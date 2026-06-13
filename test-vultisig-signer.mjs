/**
 * test-vultisig-signer.mjs
 *
 * Standalone verification for the Vultisig signer — NO exchange calls, no orders.
 * Proves: vault loads → derives an HL address → signs EIP-712 typed data → the
 * signature recovers back to that address (i.e. @nktkas/hyperliquid will accept it).
 *
 * Usage:
 *   VULT_FILE_PATH=./myvault.vult VULT_PASSWORD=secret node test-vultisig-signer.mjs
 *   node test-vultisig-signer.mjs ./myvault.vult secret
 */
import { recoverTypedDataAddress } from "viem";
import { loadVultisigAccount } from "./vultisig-account.mjs";

try { process.loadEnvFile(".env"); } catch { /* no .env — rely on shell env / argv */ }

// ── Instrument fetch to expose the VultiServer / relay conversation ──────────
const _fetch = globalThis.fetch;
let reqN = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = init?.method ?? (typeof input === "object" ? input?.method : "GET") ?? "GET";
  // Log coordination calls; skip the repetitive relay GET-polling on /router.
  const isVaultOrVerifier = /vultisig\.com\/(vault|verifier)/.test(url);
  const isRouterPost = /vultisig\.com\/router/.test(url) && /post/i.test(method);
  const interesting = isVaultOrVerifier || isRouterPost;
  const n = ++reqN;
  if (interesting) console.log(`  [net #${n}] → ${method} ${url}`);
  try {
    const res = await _fetch(input, init);
    if (interesting) {
      let bodyNote = "";
      if (!res.ok) {
        try { bodyNote = " body=" + (await res.clone().text()).slice(0, 200); } catch {}
      }
      console.log(`  [net #${n}] ← ${res.status} ${res.statusText}${bodyNote}`);
    }
    return res;
  } catch (e) {
    if (interesting) console.log(`  [net #${n}] ✗ ${e.message}`);
    throw e;
  }
};

const vultPath = process.argv[2] ?? process.env.VULT_FILE_PATH;
const password = process.argv[3] ?? process.env.VULT_PASSWORD ?? process.env.VULTISIG_PASS;

if (!vultPath) {
  console.error("Missing vault path. Set VULT_FILE_PATH or pass it as the first arg.");
  process.exit(2);
}

// Sample HL L1-action typed data (the "Agent" envelope HL uses for exchange actions).
const sample = {
  domain: {
    name: "Exchange",
    version: "1",
    chainId: 1337,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  },
  types: {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  },
  primaryType: "Agent",
  message: {
    source: "a",
    connectionId: `0x${"00".repeat(32)}`,
  },
};

console.log("→ Loading Vultisig vault from", vultPath, password ? "(encrypted)" : "(no password)");

const t0 = Date.now();
const account = await loadVultisigAccount({ vultPath, password });
console.log(`✓ Vault loaded in ${Date.now() - t0}ms`);
console.log("  HL address:", account.address);

// Diagnostics — is this recognized as a fast (server-cosigned) vault?
try {
  const v = account.vault;
  console.log("  vault class:", v?.constructor?.name);
  console.log("  signing modes:", v?.availableSigningModes);
  console.log("  threshold:", v?.threshold);
  console.log("  signers:", v?.signers ?? v?.summary?.()?.signers);
} catch (e) { console.log("  (diagnostics unavailable:", e.message, ")"); }

console.log("→ Signing sample typed data (MPC keysign — co-signs with VultiServer)…");
console.log("  (90s timeout — if it stalls here, server co-sign isn't completing)");
const tSign = Date.now();
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(new Error("sign timeout after 90s")), 90_000);
let signature;
try {
  signature = await account.signTypedData(sample, { signal: ac.signal });
} finally {
  clearTimeout(timer);
}
console.log(`✓ Signed in ${Date.now() - tSign}ms`);
console.log("  signature:", signature);
console.log("  length:", signature.length, signature.length === 132 ? "(65 bytes — OK)" : "(EXPECTED 132!)");

const recovered = (await recoverTypedDataAddress({ ...sample, signature })).toLowerCase();
console.log("  recovered:", recovered);

if (recovered === account.address) {
  console.log("\n✅ PASS — signature recovers to the vault address. Signer is valid for Hyperliquid.");
  process.exit(0);
} else {
  console.error("\n❌ FAIL — recovered address does not match the vault address.");
  console.error("   Signature would be rejected by Hyperliquid.");
  process.exit(1);
}
