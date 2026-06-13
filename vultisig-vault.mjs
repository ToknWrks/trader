/**
 * vultisig-vault.mjs
 *
 * Server-side Fast Vault provisioning for the trader dashboard.
 *
 * Flow (email-OTP, see CLAUDE.md Phase 3):
 *   1. createVaultStart({name,email,password}) → MPC keygen with VultiServer,
 *      server emails a verification code. Returns { vaultId }.
 *   2. verifyVaultFinish({code})            → verifyVault(code) completes keygen,
 *      then export() writes the DEVICE share (localPartyId `sdk-XXXX`) to
 *      data/vault.vult and records VULT_FILE_PATH + VULTISIG_PASS in .env.
 *
 * The exported .vult is the device share — distinct from VultiServer's
 * `Server-XXXX` party — so fast co-signing actually completes. (A server-share
 * backup collides with the live server and stalls at waitForPeers; that is the
 * bug this whole flow exists to avoid — see loadVultisigAccount's guard.)
 *
 * MemoryStorage means the pending vault lives only in this module's singleton
 * SDK instance: create → verify must happen in the same dashboard process.
 */
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Vultisig, MemoryStorage } from "@vultisig/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const VAULT_PATH = resolve(__dirname, "data/vault.vult");

// Singleton SDK + the in-flight (pending) vault state between create and verify.
let _sdk = null;
let _pending = null; // { vaultId, password }

async function getSdk() {
  if (_sdk) return _sdk;
  const sdk = new Vultisig({ storage: new MemoryStorage() });
  await sdk.initialize();
  _sdk = sdk;
  return sdk;
}

/**
 * Step 1 — start Fast Vault keygen. VultiServer emails the OTP.
 * @returns {Promise<{ vaultId: string }>}
 */
export async function createVaultStart({ name, email, password }) {
  if (!name || !email || !password) {
    throw new Error("name, email and password are all required");
  }
  const sdk = await getSdk();
  // default flow (skipVerification omitted) → returns the vaultId string and
  // triggers the verification email. Keygen runs with VultiServer here.
  const vaultId = await sdk.createFastVault({ name, email, password });
  _pending = { vaultId, password };
  return { vaultId };
}

/**
 * Step 2 — finish with the emailed code, export the device share to disk.
 * @returns {Promise<{ address: string, localPartyId: string, path: string }>}
 */
export async function verifyVaultFinish({ code }) {
  if (!_pending) {
    throw new Error("no vault is awaiting verification — start creation again (dashboard may have restarted)");
  }
  if (!code) throw new Error("verification code is required");
  const sdk = await getSdk();
  const { vaultId, password } = _pending;

  const vault = await sdk.verifyVault(vaultId, code);

  const cv = vault.coreVault ?? vault.vaultData?.vault ?? vault.vaultData;
  const localPartyId = cv?.localPartyId ?? vault.localPartyId ?? "";
  // Sanity: the share we just exported must be the device share, never the server's.
  if (/^Server-/i.test(localPartyId)) {
    throw new Error(`exported share is the server party (${localPartyId}) — refusing to save; this would not be able to co-sign`);
  }

  const { data } = await vault.export(password);
  await writeFile(VAULT_PATH, data, "utf8");
  _pending = null;

  const { Chain } = await import("@vultisig/sdk");
  const address = (await vault.address(Chain.Hyperliquid)).toLowerCase();
  return { address, localPartyId, path: VAULT_PATH };
}

/**
 * Import an existing .vult backup (its raw text content) and install it as the
 * trader's signing vault. Rejects a server share — only a device share can
 * co-sign. Writes the file to data/vault.vult.
 * @returns {Promise<{ address: string, localPartyId: string, path: string }>}
 */
export async function importVaultFile({ content, password }) {
  if (!content || !content.trim()) throw new Error("vault file is empty");
  const sdk = await getSdk();

  const encrypted = sdk.isVaultEncrypted(content);
  if (encrypted && !password) throw new Error("this vault is encrypted — a password is required");

  const vault = await sdk.importVault(content, encrypted ? password : undefined);
  if (!vault) throw new Error("import failed — not a valid .vult backup");

  const cv = vault.coreVault ?? vault.vaultData?.vault ?? vault.vaultData;
  const localPartyId = cv?.localPartyId ?? vault.localPartyId ?? "";
  if (/^Server-/i.test(localPartyId)) {
    throw new Error(`this is the SERVER share (${localPartyId}) — it collides with VultiServer and cannot co-sign. Import the device share (sdk-XXXX).`);
  }

  // Persist the backup as-is (already a valid encrypted device-share file).
  await writeFile(VAULT_PATH, content, "utf8");

  const { Chain } = await import("@vultisig/sdk");
  const address = (await vault.address(Chain.Hyperliquid)).toLowerCase();
  return { address, localPartyId, path: VAULT_PATH };
}

/**
 * Inspect the on-disk vault (if any) — used to render dashboard status.
 * @returns {Promise<{ exists: boolean, address?: string, localPartyId?: string, isDeviceShare?: boolean, error?: string }>}
 */
export async function vaultStatus(password) {
  const { existsSync, readFileSync } = await import("node:fs");
  if (!existsSync(VAULT_PATH)) return { exists: false };
  try {
    const { loadVultisigAccount } = await import("./vultisig-account.mjs");
    const acct = await loadVultisigAccount({ vultPath: VAULT_PATH, password });
    const cv = acct.vault.coreVault ?? acct.vault.vaultData?.vault ?? acct.vault.vaultData;
    const localPartyId = cv?.localPartyId ?? acct.vault.localPartyId ?? "";
    return {
      exists: true,
      address: acct.address,
      localPartyId,
      isDeviceShare: !/^Server-/i.test(localPartyId),
    };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}
