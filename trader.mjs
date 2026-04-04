#!/usr/bin/env node
/**
 * trader.mjs — AgentSignal autonomous trader
 *
 * Fetches live signals from agentsignal.app and executes trades
 * on Hyperliquid for all active strategies.
 *
 * Runs on a schedule via PM2 (see ecosystem.config.cjs).
 * Run manually: node trader.mjs [--dry-run]
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { argv } from "process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env ─────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
    }
  } catch {}
}

loadEnv();

const PRIVATE_KEY      = process.env.AGENT_PRIVATE_KEY?.trim();
const AGENT_SIGNAL_URL = process.env.AGENT_SIGNAL_URL ?? "https://agentsignal.app";
const HL_SIZE_USD      = parseFloat(process.env.HL_POSITION_SIZE_USD ?? "10");
const isDryRun         = argv.includes("--dry-run");
const today            = new Date().toISOString().slice(0, 10);

if (!PRIVATE_KEY) {
  console.error("[trader] AGENT_PRIVATE_KEY is required. Run: npm run setup");
  process.exit(1);
}

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  getActiveStrategies, upsertSignal, getLatestSignal,
  getPriorSignal, insertTrade,
} from "./db.mjs";

import {
  placeMarketOrder, closePosition, getPosition,
  getMidPrice, setLeverage,
} from "./hyperliquid.mjs";

// ── Fetch signal from agentsignal.app ─────────────────────────────────────────

async function fetchSignal(strategyId) {
  const url = `${AGENT_SIGNAL_URL}/api/strategy/${strategyId}/signal`;
  try {
    const { x402Client } = await import("@x402/core/client");
    const { ExactEvmScheme } = await import("@x402/evm/exact/client");
    const { privateKeyToAccount, createWalletClient, http } = await import("viem");
    const { mainnet } = await import("viem/chains");

    const account = privateKeyToAccount(PRIVATE_KEY);
    const walletClient = createWalletClient({ account, chain: mainnet, transport: http() });
    const client = new x402Client();
    const evmScheme = new ExactEvmScheme(walletClient);
    client.register("eip155:8453", evmScheme);
    client.register("eip155:*", evmScheme);

    const res = await client.fetch(url);
    if (!res.ok) throw new Error(`Signal API ${res.status}`);
    const data = await res.json();
    console.log(`[trader] ✅ Signal fetched for ${strategyId}: ${data.signal}`);
    return data;
  } catch (err) {
    console.warn(`[trader] Signal fetch failed: ${err.message}`);
    return null;
  }
}

// ── Execute trade ─────────────────────────────────────────────────────────────

async function executeTrade(strategy, signal, priorSignal) {
  const hlAsset = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  const leverage = strategy.leverage ?? 1;
  const sizeUsd  = strategy.position_size_usd ?? HL_SIZE_USD;

  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(PRIVATE_KEY);

  const midPrice = await getMidPrice(hlAsset);
  if (!midPrice) throw new Error(`Could not get price for ${hlAsset}`);

  const positionSize = parseFloat((sizeUsd / midPrice).toFixed(5));
  const position = await getPosition(account.address, hlAsset);
  const currentSize = parseFloat(position?.szi ?? "0");
  const isFlat = currentSize === 0;
  const isLong = currentSize > 0;

  console.log(`[trader] ${strategy.name} — signal: ${priorSignal?.signal ?? "N/A"} → ${signal} | position: ${currentSize} ${hlAsset}`);

  let action = "HOLD";
  let result = null;

  if (signal === "LONG" && isFlat) {
    action = `ENTERED LONG ${positionSize} ${hlAsset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    if (!isDryRun) {
      await setLeverage(PRIVATE_KEY, hlAsset, leverage);
      result = await placeMarketOrder(PRIVATE_KEY, hlAsset, "buy", positionSize);
    }
  } else if (signal === "FLAT" && !isFlat) {
    action = `CLOSED ${Math.abs(currentSize)} ${hlAsset} @ ~$${midPrice.toLocaleString()}`;
    if (!isDryRun) {
      result = await closePosition(PRIVATE_KEY, hlAsset);
    }
  } else if (signal === "SHORT" && !isFlat) {
    action = `SHORTED ${positionSize} ${hlAsset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    if (!isDryRun) {
      await closePosition(PRIVATE_KEY, hlAsset);
      await setLeverage(PRIVATE_KEY, hlAsset, leverage);
      result = await placeMarketOrder(PRIVATE_KEY, hlAsset, "sell", positionSize);
    }
  } else {
    console.log(`[trader] ⚪ HOLD — no action needed`);
    return;
  }

  if (isDryRun) console.log(`[trader] [DRY RUN] Would: ${action}`);
  else console.log(`[trader] ✅ ${action}`);

  insertTrade({
    strategy_id: strategy.id,
    action,
    asset: hlAsset,
    size: positionSize,
    price: midPrice,
    leverage,
    result,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n[trader] ═══════════════════════════════════════`);
console.log(`[trader] AgentSignal Trader — ${today}${isDryRun ? " [DRY RUN]" : ""}`);
console.log(`[trader] ═══════════════════════════════════════`);

const strategies = getActiveStrategies();
if (!strategies.length) {
  console.log("[trader] No active strategies. Activate one from the dashboard: npm run dashboard");
  process.exit(0);
}

console.log(`[trader] Active strategies: ${strategies.map(s => s.name).join(", ")}`);

for (const strategy of strategies) {
  console.log(`\n[trader] ── ${strategy.name} (${strategy.symbol}) ──`);

  // Fetch signal
  const signalData = await fetchSignal(strategy.id);
  if (!signalData) {
    console.warn(`[trader] Skipping ${strategy.name} — could not fetch signal`);
    continue;
  }

  const signal = signalData.signal;
  const price  = signalData.price ?? null;

  // Store signal
  upsertSignal({
    strategy_id: strategy.id,
    date: today,
    signal,
    price,
    notes: signalData.notes ?? null,
  });

  // Get prior signal to detect flips
  const priorSignal = getPriorSignal(strategy.id);
  const signalChanged = !priorSignal || priorSignal.signal !== signal;

  if (!signalChanged) {
    console.log(`[trader] ⚪ Signal unchanged (${signal}) — holding`);
    continue;
  }

  console.log(`[trader] 🔄 Signal flip: ${priorSignal?.signal ?? "N/A"} → ${signal}`);

  try {
    await executeTrade(strategy, signal, priorSignal);
  } catch (err) {
    console.error(`[trader] ❌ Execution error for ${strategy.name}: ${err.message}`);
  }
}

console.log(`\n[trader] Done.`);
