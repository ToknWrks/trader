/**
 * diag-vultisig.mjs — isolate WHY fast keysign stalls at waitForPeers.
 *   - server reachability (fastVault + messageRelay)
 *   - does the server actually hold THIS vault for THIS password
 *   - vault metadata (pubkeys, signers, server party id)
 *
 * Usage: VULT_PASSWORD=… node diag-vultisig.mjs /path/to.vult
 */
import { readFile } from "node:fs/promises";
import { Vultisig, MemoryStorage } from "@vultisig/sdk";

try { process.loadEnvFile(".env"); } catch {}

const vultPath = process.argv[2] ?? process.env.VULT_FILE_PATH;
const password = process.argv[3] ?? process.env.VULT_PASSWORD ?? process.env.VULTISIG_PASS;
if (!vultPath) { console.error("need vult path"); process.exit(2); }

const content = await readFile(vultPath, "utf8");
const sdk = new Vultisig({
  storage: new MemoryStorage(),
  onPasswordRequired: password ? async () => password : undefined,
});
await sdk.initialize();

const ctx = sdk.context;
const srv = ctx?.serverManager;
console.log("→ context keys:", ctx ? Object.keys(ctx) : "(no context)");
console.log("→ serverManager methods:", srv ? Object.getOwnPropertyNames(Object.getPrototypeOf(srv)).filter(n => typeof srv[n] === "function") : "(none)");

console.log("→ checkServerStatus()");
try {
  const st = await srv.checkServerStatus();
  console.log("  ", JSON.stringify(st));
} catch (e) { console.log("   ✗", e.message); }

const encrypted = sdk.isVaultEncrypted(content);
console.log("→ encrypted:", encrypted);
const vault = await sdk.importVault(content, encrypted ? password : undefined);

const summary = typeof vault.summary === "function" ? vault.summary() : null;
const pubEcdsa = summary?.publicKeyEcdsa ?? vault.publicKeyEcdsa ?? vault.publicKeys?.ecdsa;
console.log("→ vault summary:", JSON.stringify(summary, null, 2));
console.log("→ publicKeyEcdsa:", pubEcdsa);

import { Chain } from "@vultisig/sdk";
const cv = vault.coreVault ?? vault.vaultData?.vault ?? vault.vaultData;
console.log("→ coreVault.localPartyId:", cv?.localPartyId);
console.log("→ coreVault.signers:", JSON.stringify(cv?.signers));
console.log("→ coreVault.keyShares localPartyIds:", JSON.stringify((cv?.keyShares ?? cv?.keyshares ?? []).map(k => k?.localPartyId ?? Object.keys(k ?? {}))));
console.log("→ vaultData keys:", vault.vaultData ? Object.keys(vault.vaultData) : "(none)");
console.log("→ vault.localPartyId getter:", vault.localPartyId ?? vault.data?.localPartyId);
console.log("→ vault signers:", JSON.stringify(vault.signers ?? vault.data?.signers));
console.log("→ vault keys:", Object.keys(vault));
try {
  const hl = await vault.address(Chain.Hyperliquid);
  const eth = await vault.address(Chain.Ethereum);
  console.log("→ addr Hyperliquid:", hl);
  console.log("→ addr Ethereum:   ", eth, hl.toLowerCase() === eth.toLowerCase() ? "(SAME)" : "(DIFFERENT!)");
} catch (e) { console.log("→ addr err:", e.message); }

if (pubEcdsa) {
  console.log("→ getVaultFromServer(pubEcdsa, password) — does server know this vault for this password?");
  try {
    const r = await srv.getVaultFromServer(pubEcdsa, password);
    console.log("   ✓ server HAS vault:", JSON.stringify(r));
  } catch (e) {
    console.log("   ✗ server rejected:", e.message);
  }
}
