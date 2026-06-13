/**
 * vultisig-account.mjs
 *
 * Loads a Vultisig MPC vault from a .vult backup + password and exposes it as a
 * viem-style Local Account: { address, signTypedData(params) }.
 *
 * This is the exact shape @nktkas/hyperliquid's ExchangeClient expects for a
 * `wallet`, so it drops in where `privateKeyToAccount(privateKey)` is used today
 * — no other trader code needs to change.
 *
 * Signing routes through the vault's MPC keysign (local keyshare + VultiServer
 * co-sign), so there is no raw private key on disk.
 */
import { readFile } from "node:fs/promises";
import { hashTypedData, recoverAddress } from "viem";
import { Vultisig, Chain, MemoryStorage } from "@vultisig/sdk";

/**
 * @param {object}  opts
 * @param {string}  opts.vultPath   path to the .vult backup file
 * @param {string} [opts.password]  password for an encrypted vault
 * @returns {Promise<{ address: `0x${string}`, signTypedData: (params: object) => Promise<`0x${string}`> }>}
 */
// Decode a DER-encoded ECDSA signature (hex, no 0x) into { r, s } hex strings.
// DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
function derToRS(der) {
  let i = 0;
  const byte = () => parseInt(der.slice(i, (i += 2)), 16);
  if (byte() !== 0x30) throw new Error("[vultisig] DER: expected sequence tag");
  byte(); // sequence length (ignored)
  if (byte() !== 0x02) throw new Error("[vultisig] DER: expected r integer tag");
  const rlen = byte();
  const r = der.slice(i, (i += rlen * 2));
  if (byte() !== 0x02) throw new Error("[vultisig] DER: expected s integer tag");
  const slen = byte();
  const s = der.slice(i, (i += slen * 2));
  return { r, s };
}

export async function loadVultisigAccount({ vultPath, password }) {
  if (!vultPath) throw new Error("[vultisig] vultPath is required");

  const content = await readFile(vultPath, "utf8");

  const sdk = new Vultisig({
    storage: new MemoryStorage(),
    onPasswordRequired: password ? async () => password : undefined,
  });
  await sdk.initialize();

  const encrypted = sdk.isVaultEncrypted(content);
  if (encrypted && !password) {
    throw new Error("[vultisig] vault is encrypted but no password was provided");
  }

  // importVault sets the imported vault active and returns it.
  const vault = await sdk.importVault(content, encrypted ? password : undefined);
  if (!vault) throw new Error("[vultisig] importVault returned no vault");

  // Guard: a Fast Vault co-signs device + server. If the loaded share IS the
  // server party (`Server-XXXX`), it collides with the live VultiServer and the
  // keysign stalls forever at waitForPeers. Fail fast with a clear message.
  const cv = vault.coreVault ?? vault.vaultData?.vault ?? vault.vaultData;
  const localPartyId = cv?.localPartyId ?? vault.localPartyId ?? "";
  if (/^Server-/i.test(localPartyId)) {
    throw new Error(
      `[vultisig] this .vult is the SERVER share (localPartyId ${localPartyId}); ` +
      `fast signing needs the DEVICE share (sdk-XXXX). It would collide with VultiServer and hang.`
    );
  }

  const address = (await vault.address(Chain.Hyperliquid)).toLowerCase();

  // Sign an arbitrary 32-byte digest with the vault's EVM key via MPC keysign,
  // returning a 65-byte `0x{r}{s}{v}` signature (v ∈ {27,28}). Shared by EIP-712
  // typed-data signing and raw EVM transaction signing (Arbitrum deposits).
  async function signDigest(hash, opts) {
    const sig = await vault.signBytes({ data: hash, chain: Chain.Hyperliquid }, { signal: opts?.signal });

    // Extract r,s. The SDK returns ECDSA as a DER blob (0x30…) — decode it.
    // Prefer the structured signatures[0] if present.
    let r, s;
    const parts = sig.signatures?.[0];
    const raw = (sig.signature ?? "").replace(/^0x/, "");
    if (parts?.r && parts?.s) {
      ({ r, s } = { r: parts.r.replace(/^0x/, ""), s: parts.s.replace(/^0x/, "") });
    } else if (raw.startsWith("30")) {
      ({ r, s } = derToRS(raw));
    } else if (raw.length === 128 || raw.length === 130) {
      r = raw.slice(0, 64); s = raw.slice(64, 128);
    } else {
      throw new Error(`[vultisig] unrecognized signature (format=${sig.format}, len=${raw.length})`);
    }

    // Normalize r,s to 32 bytes and enforce low-s (EIP-2 / Hyperliquid).
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const norm = (h) => { let x = h.replace(/^0x/, ""); while (x.length > 64 && x.startsWith("00")) x = x.slice(2); return x.padStart(64, "0"); };
    r = norm(r);
    let sBig = BigInt("0x" + norm(s));
    if (sBig > N / 2n) sBig = N - sBig;
    s = sBig.toString(16).padStart(64, "0");
    const rs = r + s;
    if (rs.length !== 128) {
      throw new Error(`[vultisig] bad r||s length ${rs.length} (format=${sig.format})`);
    }

    // recovery id may be 0/1 (yParity). Try both v values to find the one that
    // recovers to our vault address.
    const recoveredFor = {};
    for (const v of [27, 28]) {
      const full = /** @type {`0x${string}`} */ (`0x${rs}${v.toString(16).padStart(2, "0")}`);
      try {
        const recovered = (await recoverAddress({ hash, signature: full })).toLowerCase();
        recoveredFor[v] = recovered;
        if (recovered === address) return full;
      } catch (e) {
        recoveredFor[v] = `(invalid: ${e.message.split("\n")[0]})`;
      }
    }
    throw new Error(
      "[vultisig] no recovery id matched the vault address.\n" +
      `  vault address: ${address}\n` +
      `  recovered v27: ${recoveredFor[27]}\n` +
      `  recovered v28: ${recoveredFor[28]}\n` +
      `  sig.format=${sig.format} recovery=${sig.recovery} sig.signature.len=${sig.signature.replace(/^0x/, "").length}\n` +
      `  → if both recovered addresses are stable but wrong, signBytes is signing a different digest than hashTypedData produced.`
    );
  }

  // viem Local Account detection in @nktkas needs signTypedData with arity 1–2
  // and a string `address` property. Keep params first.
  async function signTypedData(params, opts) {
    // @nktkas passes the full typed data incl. EIP712Domain in `types` — viem's
    // hashTypedData handles that and derives the domain separator from `domain`.
    return signDigest(hashTypedData(params), opts);
  }

  return { address, signTypedData, signDigest, vault, sdk };
}
