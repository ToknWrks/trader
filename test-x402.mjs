/**
 * x402 end-to-end test — Base Sepolia testnet
 *
 * Tests the full probe → pay → verify cycle against the /api/x402-test
 * endpoint on agentsignal.app. Uses testnet USDC so no real money moves.
 *
 * Requirements:
 *   - AGENT_PRIVATE_KEY in .env (same key used for trading)
 *   - The wallet needs Base Sepolia testnet ETH (for gas) and testnet USDC
 *   - Get testnet ETH: https://www.alchemy.com/faucets/base-sepolia
 *   - Get testnet USDC: https://faucet.circle.com (select Base Sepolia)
 *
 * Usage:
 *   node test-x402.mjs
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const env = readFileSync(resolve(__dirname, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const [k, ...v] = line.split("=");
    if (k && v.length && !process.env[k]) process.env[k] = v.join("=").trim();
  }
} catch {}

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("❌ AGENT_PRIVATE_KEY not set in .env");
  process.exit(1);
}

const TEST_URL = "https://agentsignal.app/api/x402-test";
const NETWORK = "eip155:84532"; // Base Sepolia

console.log("🧪 x402 end-to-end test (Base Sepolia)\n");
console.log(`   Endpoint: ${TEST_URL}`);
console.log(`   Network:  ${NETWORK}\n`);

const { x402Client } = await import("@x402/core/client");
const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
const { ExactEvmScheme } = await import("@x402/evm/exact/client");
const { toClientEvmSigner } = await import("@x402/evm");
const { createWalletClient, createPublicClient, http } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { baseSepolia } = await import("viem/chains");

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`   Wallet:   ${account.address}\n`);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register(NETWORK, new ExactEvmScheme(signer));

// Step 1: Probe
console.log("1️⃣  Probing endpoint...");
const probe = await fetch(TEST_URL);
console.log(`   Status: ${probe.status}`);

if (probe.ok) {
  console.log("✅ No payment required — endpoint returned 200 freely");
  const body = await probe.json();
  console.log("   Response:", body);
  process.exit(0);
}

if (probe.status !== 402) {
  const body = await probe.text();
  console.error(`❌ Expected 402, got ${probe.status}:`, body.slice(0, 300));
  process.exit(1);
}

console.log("   Got 402 ✓\n");

// Step 2: Parse payment requirements
const rawHeader = probe.headers.get("payment-required");
if (!rawHeader) {
  console.error("❌ No X-PAYMENT-REQUIRED header in 402 response");
  process.exit(1);
}

let paymentRequired;
try {
  paymentRequired = decodePaymentRequiredHeader(rawHeader);
  const a = paymentRequired.accepts?.[0] ?? paymentRequired;
  console.log("2️⃣  Payment required:");
  console.log(`   Scheme:  ${a.scheme}`);
  console.log(`   Network: ${a.network}`);
  const usdAmount = a.amount ? `$${(Number(a.amount) / 1e6).toFixed(4)} (${a.amount} raw units)` : "unknown";
  console.log(`   Amount:  ${usdAmount}`);
  console.log(`   Pay to:  ${a.payTo}\n`);
} catch (err) {
  console.error("❌ Failed to decode payment header:", err.message);
  process.exit(1);
}

// Check USDC balance on Base Sepolia
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const balanceRaw = await publicClient.readContract({
  address: USDC_SEPOLIA,
  abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "balanceOf",
  args: [account.address],
}).catch(() => null);
const balance = balanceRaw !== null ? Number(balanceRaw) / 1e6 : null;
console.log(`   USDC balance: ${balance !== null ? `$${balance.toFixed(4)}` : "could not read"}`);
if (balance !== null && balance < 0.001) {
  console.error("❌ Insufficient USDC — need at least $0.001 on Base Sepolia");
  console.error("   Get testnet USDC at: https://faucet.circle.com (select Base Sepolia)");
  process.exit(1);
}
console.log();

// Step 3: Sign & pay
console.log("3️⃣  Signing payment...");
let paymentPayload;
try {
  paymentPayload = await client.createPaymentPayload(paymentRequired);
  console.log("   Signed ✓\n");
} catch (err) {
  console.error("❌ Failed to sign payment:", err.message);
  console.error("   (Make sure your wallet has testnet USDC on Base Sepolia)");
  process.exit(1);
}

// Step 4: Send payment
console.log("4️⃣  Sending paid request...");
// v2 uses PAYMENT-SIGNATURE header, v1 uses X-PAYMENT
const paymentHeader = paymentPayload.x402Version === 2
  ? { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) }
  : { "X-PAYMENT": encodePaymentSignatureHeader(paymentPayload) };
const paid = await fetch(TEST_URL, { headers: paymentHeader });
console.log(`   Status: ${paid.status}`);

if (paid.ok) {
  const body = await paid.json();
  console.log("\n✅ Payment accepted! Response:", body);
  console.log("\n🎉 x402 is working end-to-end on Base Sepolia.");
  console.log("   When Base mainnet support lands, swap NETWORK to eip155:8453 and you're live.");
} else {
  const body = await paid.text();
  console.error(`\n❌ Payment rejected (${paid.status}):`, body.slice(0, 500));
  console.error("   Response headers:");
  for (const [k, v] of paid.headers.entries()) {
    if (k.toLowerCase().includes("payment") || k.toLowerCase().includes("x402")) {
      console.error(`     ${k}: ${v}`);
    }
  }
  process.exit(1);
}
