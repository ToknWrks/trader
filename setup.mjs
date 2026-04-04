#!/usr/bin/env node
/**
 * setup.mjs — AgentSignal Trader setup wizard
 * Run: npm run setup
 */

import { createInterface } from "readline";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));
const askHidden = (q) => new Promise(r => {
  process.stdout.write(q);
  process.stdin.setRawMode?.(true);
  let val = "";
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const onData = (ch) => {
    if (ch === "\n" || ch === "\r") {
      process.stdin.setRawMode?.(false);
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      r(val);
    } else if (ch === "\u0003") {
      process.exit();
    } else if (ch === "\u007f") {
      if (val.length > 0) { val = val.slice(0, -1); process.stdout.write("\b \b"); }
    } else {
      val += ch;
      process.stdout.write("*");
    }
  };
  process.stdin.on("data", onData);
});

console.log(`
╔════════════════════════════════════════╗
║   AgentSignal Trader — Setup Wizard    ║
╚════════════════════════════════════════╝

Your private key stays on this machine.
Signals are fetched from agentsignal.app.
`);

// Load existing .env if present
const envPath = resolve(__dirname, ".env");
const existing = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)/);
    if (m) existing[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  console.log("Found existing .env — press Enter to keep current values.\n");
}

// ── Collect inputs ────────────────────────────────────────────────────────────

const privateKey = await askHidden(
  `Private key (0x...)${existing.AGENT_PRIVATE_KEY ? " [keep existing]" : ""}: `
) || existing.AGENT_PRIVATE_KEY || "";

if (!privateKey || (!privateKey.startsWith("0x") && privateKey !== "")) {
  if (privateKey && !privateKey.startsWith("0x")) {
    console.error("\n❌ Private key must start with 0x");
    process.exit(1);
  }
}

const signalUrl = await ask(
  `AgentSignal URL [${existing.AGENT_SIGNAL_URL ?? "https://agentsignal.app"}]: `
) || existing.AGENT_SIGNAL_URL || "https://agentsignal.app";

const positionSize = await ask(
  `Default position size USD [${existing.HL_POSITION_SIZE_USD ?? "10"}]: `
) || existing.HL_POSITION_SIZE_USD || "10";

// ── Write .env ────────────────────────────────────────────────────────────────

const envContent = [
  `AGENT_PRIVATE_KEY=${privateKey}`,
  `AGENT_SIGNAL_URL=${signalUrl}`,
  `HL_POSITION_SIZE_USD=${positionSize}`,
].join("\n") + "\n";

writeFileSync(envPath, envContent, "utf8");
console.log("\n✅ .env saved");

// ── Test connections ──────────────────────────────────────────────────────────

console.log("\nTesting connections...");

// Test agentsignal.app
try {
  const res = await fetch(`${signalUrl}/api/health`).catch(() => null);
  if (res?.ok) {
    console.log(`✅ agentsignal.app reachable`);
  } else {
    console.log(`⚠️  agentsignal.app returned ${res?.status ?? "no response"} — check the URL`);
  }
} catch {}

// Test Hyperliquid
try {
  process.env.AGENT_PRIVATE_KEY = privateKey;
  const { getMidPrice } = await import("./hyperliquid.mjs");
  const price = await getMidPrice("BTC");
  if (price) console.log(`✅ Hyperliquid reachable — BTC mid: $${price.toLocaleString()}`);
} catch (err) {
  console.log(`⚠️  Hyperliquid connection issue: ${err.message}`);
}

// ── Add a strategy ────────────────────────────────────────────────────────────

const addStrategy = await ask("\nAdd a strategy now? (y/n) [y]: ");
if (!addStrategy || addStrategy.toLowerCase() === "y") {
  console.log(`\nFind your strategy ID at ${signalUrl}/navigator`);
  console.log("Click a strategy → Live Signal ↗ — the ID is in the URL.\n");

  const stratId = await ask("Strategy ID (e.g. ba5a1fbc-...): ");
  if (stratId?.trim()) {
    const stratName = await ask("Strategy name: ") || "My Strategy";
    const stratSymbol = await ask("Symbol [BTC-USD]: ") || "BTC-USD";
    const stratLeverage = parseInt(await ask("Leverage [1]: ") || "1") || 1;
    const stratSize = await ask(`Position size USD [${positionSize}]: `) || null;

    // Init DB and add strategy
    process.env.AGENT_PRIVATE_KEY = privateKey;
    process.env.AGENT_SIGNAL_URL = signalUrl;
    const { upsertStrategy } = await import("./db.mjs");
    upsertStrategy({
      id: stratId.trim(),
      name: stratName,
      symbol: stratSymbol.toUpperCase(),
      leverage: stratLeverage,
      position_size_usd: stratSize ? parseFloat(stratSize) : null,
    });
    console.log(`\n✅ Strategy "${stratName}" added (inactive by default)`);
    console.log("   Activate it from the dashboard: npm run dashboard");
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`
════════════════════════════════════════
  Setup complete!

  Start the dashboard:   npm run dashboard
  Run trader manually:   npm run trade
  Start on a schedule:   npm start  (requires PM2)
  View logs:             npm run logs

  Dashboard: http://localhost:4100
════════════════════════════════════════
`);

rl.close();
process.exit(0);
