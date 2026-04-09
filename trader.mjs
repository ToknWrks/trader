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

const PRIVATE_KEY       = process.env.AGENT_PRIVATE_KEY?.trim();
const KRAKEN_API_KEY    = process.env.KRAKEN_API_KEY?.trim();
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET?.trim();
const ALPACA_API_KEY    = process.env.ALPACA_API_KEY?.trim();
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET?.trim();
const ALPACA_PAPER      = process.env.ALPACA_PAPER === "true";
const AGENT_SIGNAL_URL  = process.env.AGENT_SIGNAL_URL ?? "https://agentsignal.app";

// ── x402 network config ───────────────────────────────────────────────────────

const X402_NETWORKS = {
  "eip155:8453":  { viemChain: "base",        rpc: "https://mainnet.base.org" },
  "eip155:1":     { viemChain: "mainnet",     rpc: "https://eth.llamarpc.com" },
  "eip155:42161": { viemChain: "arbitrum",    rpc: "https://arb1.arbitrum.io/rpc" },
  "eip155:137":   { viemChain: "polygon",     rpc: "https://polygon-rpc.com" },
  "eip155:43114": { viemChain: "avalanche",   rpc: "https://api.avax.network/ext/bc/C/rpc" },
  "eip155:84532": { viemChain: "baseSepolia", rpc: "https://sepolia.base.org" },
};

function getPaymentNetwork() {
  return process.env.X402_PAYMENT_NETWORK || "eip155:8453";
}
const HL_SIZE_USD      = parseFloat(process.env.HL_POSITION_SIZE_USD ?? "10");
const isDryRun         = argv.includes("--dry-run");
const cryptoOnly       = argv.includes("--crypto-only");
const stocksOnly       = argv.includes("--stocks-only");
const today            = new Date().toISOString().slice(0, 10);

// Crypto tickers traded on 24/7 markets (Hyperliquid perps)
const CRYPTO_TICKERS = new Set([
  "BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","MATIC","POL","LINK","UNI",
  "ATOM","LTC","DOGE","SHIB","TRX","TON","SUI","APT","OP","ARB","INJ","SEI",
  "TIA","JUP","WIF","BONK","PEPE","NEAR","FIL","ICP","HBAR","VET","ALGO","XLM",
  "XMR","ETC","BCH","AAVE","CRV","MKR","SNX","LDO","RETH","STETH","WBTC","VVV","VULT",
]);

function isCrypto(symbol) {
  // Strip exchange suffix: "BTC-USD" → "BTC", "ETH/USD" → "ETH"
  const base = symbol.toUpperCase().replace(/-USD$/, "").replace(/\/USD$/, "");
  return CRYPTO_TICKERS.has(base);
}

if (!PRIVATE_KEY && !KRAKEN_API_KEY && !ALPACA_API_KEY) {
  console.error("[trader] No exchange credentials found. Run: npm run setup");
  process.exit(1);
}

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  getActiveStrategies, upsertSignal, getLatestSignal,
  getPriorSignal, insertTrade, isStrategyDue, touchStrategyRun,
  insertSignalEvent, setTpState, getTpState, updateTpTrailMode,
  updateTpHighWater, clearTpState, logFetch,
} from "./db.mjs";

import { HyperliquidExchange } from "./exchanges/hyperliquid.mjs";
import { KrakenExchange } from "./exchanges/kraken.mjs";
import { AlpacaExchange } from "./exchanges/alpaca.mjs";

function getExchange(strategy) {
  const exch = strategy.exchange ?? "hyperliquid";
  if (exch === "kraken") {
    if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) throw new Error("KRAKEN_API_KEY and KRAKEN_API_SECRET are required for Kraken strategies");
    return new KrakenExchange(KRAKEN_API_KEY, KRAKEN_API_SECRET);
  }
  if (exch === "alpaca") {
    if (!ALPACA_API_KEY || !ALPACA_API_SECRET) throw new Error("ALPACA_API_KEY and ALPACA_API_SECRET are required for Alpaca strategies");
    return new AlpacaExchange(ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_PAPER);
  }
  if (!PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY is required for Hyperliquid strategies");
  return new HyperliquidExchange(PRIVATE_KEY);
}

// ── Fetch signal from agentsignal.app ─────────────────────────────────────────

async function fetchSignal(strategyId) {
  const url = `${AGENT_SIGNAL_URL}/api/strategy/${strategyId}/signal`;
  try {
    const { x402Client } = await import("@x402/core/client");
    const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
    const { ExactEvmScheme } = await import("@x402/evm/exact/client");
    const { createWalletClient, http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const allChains = await import("viem/chains");

    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = new x402Client();

    // Step 1: probe — expect 402
    const probe = await fetch(url);
    if (probe.ok) {
      // No payment required (e.g. local dev bypass)
      const data = await probe.json();
      console.log(`[trader] ✅ Signal fetched for ${strategyId}: ${data.signal}`);
      logFetch({ strategy_id: strategyId, network: "bypass", cost_usd: 0 });
      return data;
    }
    if (probe.status !== 402) throw new Error(`Signal API ${probe.status}`);

    // Step 2: decode payment requirement — network comes FROM the server's 402 response
    // x402 v2 uses "payment-required"; v1 used "X-PAYMENT-REQUIRED" — try both
    const rawHeader = probe.headers.get("payment-required") ?? probe.headers.get("X-PAYMENT-REQUIRED");
    if (!rawHeader) throw new Error("No payment-required header in 402 response");
    const paymentRequired = decodePaymentRequiredHeader(rawHeader);

    // Step 3: resolve network from the server's requirement (not from local settings)
    const serverNetwork = paymentRequired.accepts?.[0]?.network ?? paymentRequired.accepts?.network;
    const networkCfg = X402_NETWORKS[serverNetwork] ?? X402_NETWORKS[getPaymentNetwork()] ?? X402_NETWORKS["eip155:8453"];
    const chain = allChains[networkCfg.viemChain];
    const walletClient = createWalletClient({ account, chain, transport: http(networkCfg.rpc) });

    // ExactEvmScheme reads signer.address directly — viem wallet client exposes it
    // via account.address so we surface it at the top level
    const signer = Object.assign(walletClient, { address: account.address });
    const evmScheme = new ExactEvmScheme(signer);
    client.register(serverNetwork, evmScheme);

    console.log(`[trader] 💳 Paying on ${networkCfg.label ?? serverNetwork}`);

    // Step 4: create and sign payment payload
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeader = encodePaymentSignatureHeader(paymentPayload);

    // Step 5: retry with payment
    // x402 v2 server reads "payment-signature" (core server extractPayment)
    const res = await fetch(url, { headers: { "payment-signature": paymentHeader } });
    if (!res.ok) {
      const errHeader = res.headers.get("payment-required") ?? res.headers.get("X-PAYMENT-REQUIRED") ?? "";
      try {
        const decoded = errHeader ? JSON.parse(Buffer.from(errHeader, "base64").toString()) : {};
        console.error(`[trader] x402 verify rejected (${res.status}):`, JSON.stringify(decoded));
      } catch {
        console.error(`[trader] x402 verify rejected (${res.status}): raw=`, errHeader.slice(0, 300));
      }
      throw new Error(`Signal API ${res.status} after payment`);
    }
    const data = await res.json();
    console.log(`[trader] ✅ Signal fetched for ${strategyId}: ${data.signal}`);
    logFetch({ strategy_id: strategyId, network: serverNetwork, cost_usd: 0.01 });
    return data;
  } catch (err) {
    console.warn(`[trader] Signal fetch failed: ${err.message}`);
    return null;
  }
}

// ── TP / Trail stop monitor ───────────────────────────────────────────────────

async function checkTpTrail(strategy) {
  const state = getTpState(strategy.id);
  if (!state) return false; // no TP configured for this position

  const asset    = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  const exchange = getExchange(strategy);
  const price    = await exchange.getMidPrice(asset);
  if (!price) return false;

  if (!state.trail_mode) {
    // Waiting for TP to be hit
    if (price >= state.tp_price) {
      console.log(`[trader] 🎯 TP hit @ $${price.toLocaleString()} (target $${state.tp_price.toLocaleString()}) — switching to trail`);
      updateTpTrailMode(strategy.id, price);
    }
    return false;
  }

  // In trail mode — update high water mark
  const hwm = Math.max(state.high_water ?? price, price);
  if (hwm > state.high_water) updateTpHighWater(strategy.id, hwm);

  const stopPrice = hwm * (1 - state.trail_pct / 100);
  console.log(`[trader] 📈 Trail: price $${price.toLocaleString()} | HWM $${hwm.toLocaleString()} | stop $${stopPrice.toLocaleString()}`);

  if (price <= stopPrice) {
    console.log(`[trader] 🛑 Trail stop triggered @ $${price.toLocaleString()} — closing position`);
    const position = await exchange.getPosition(asset);
    const entryPx  = parseFloat(position?.entryPx ?? state.entry_price);
    const size     = Math.abs(parseFloat(position?.szi ?? "0"));
    const pnl      = parseFloat(((price - entryPx) * size).toFixed(2));

    if (!isDryRun) await exchange.closePosition(asset);
    else console.log(`[trader] [DRY RUN] Would close via trail stop`);

    clearTpState(strategy.id);
    insertTrade({
      strategy_id: strategy.id,
      action: `TRAIL STOP @ $${price.toLocaleString()} (HWM $${hwm.toLocaleString()})`,
      asset,
      size,
      price,
      leverage: strategy.leverage ?? 1,
      pnl,
      result: { trail_stop: true, hwm, stop_price: stopPrice },
    });
    console.log(`[trader] P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
    return true; // position closed by trail
  }

  return false;
}

// ── Execute trade ─────────────────────────────────────────────────────────────

async function executeTrade(strategy, signal, priorSignal) {
  const asset    = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  const leverage = strategy.leverage ?? 1;
  const sizeUsd  = strategy.position_size_usd ?? HL_SIZE_USD;

  const exchange = getExchange(strategy);

  const midPrice = await exchange.getMidPrice(asset);
  if (!midPrice) throw new Error(`Could not get price for ${asset}`);

  const positionSize = parseFloat(((sizeUsd * leverage) / midPrice).toFixed(5));
  const position     = await exchange.getPosition(asset);
  const currentSize  = parseFloat(position?.szi ?? "0");
  const entryPrice   = parseFloat(position?.entryPx ?? "0");
  const isFlat = currentSize === 0;
  const isLong = currentSize > 0;

  console.log(`[trader] ${strategy.name} (${exchange.name}) — signal: ${priorSignal?.signal ?? "N/A"} → ${signal} | position: ${currentSize} ${asset}`);

  let action = "HOLD";
  let result = null;
  let pnl    = null;

  if (signal === "LONG" && isFlat) {
    action = `ENTERED LONG ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    if (!isDryRun) {
      await exchange.setLeverage(asset, leverage);
      result = await exchange.placeMarketOrder(asset, "buy", positionSize);
    }
    // Set TP state if strategy has TP configured
    if (strategy.tp_pct && strategy.trail_pct) {
      const tpPrice = midPrice * (1 + strategy.tp_pct / 100);
      setTpState({ strategy_id: strategy.id, entry_price: midPrice, tp_price: tpPrice, trail_pct: strategy.trail_pct });
      console.log(`[trader] 🎯 TP set: +${strategy.tp_pct}% = $${tpPrice.toLocaleString()} | trail ${strategy.trail_pct}%`);
    }
  } else if (signal === "FLAT" && !isFlat) {
    action = `CLOSED ${Math.abs(currentSize)} ${asset} @ ~$${midPrice.toLocaleString()}`;
    if (entryPrice > 0) {
      const dir = isLong ? 1 : -1;
      pnl = parseFloat(((midPrice - entryPrice) * Math.abs(currentSize) * dir).toFixed(2));
      console.log(`[trader] P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
    }
    if (!isDryRun) {
      result = await exchange.closePosition(asset);
    }
    clearTpState(strategy.id);
  } else if (signal === "SHORT" && !isFlat) {
    action = `SHORTED ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    if (entryPrice > 0 && isLong) {
      pnl = parseFloat(((midPrice - entryPrice) * Math.abs(currentSize)).toFixed(2));
      console.log(`[trader] Closed long P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
    }
    if (!isDryRun) {
      await exchange.closePosition(asset);
      await exchange.setLeverage(asset, leverage);
      result = await exchange.placeMarketOrder(asset, "sell", positionSize);
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
    asset,
    size: positionSize,
    price: midPrice,
    leverage,
    pnl,
    result,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n[trader] ═══════════════════════════════════════`);
console.log(`[trader] AgentSignal Trader — ${today}${isDryRun ? " [DRY RUN]" : ""}`);
console.log(`[trader] ═══════════════════════════════════════`);

const allStrategies = getActiveStrategies();
const strategies = allStrategies.filter(s => {
  if (cryptoOnly) return isCrypto(s.symbol);
  if (stocksOnly) return !isCrypto(s.symbol);
  return true;
});

if (!strategies.length) {
  const scope = cryptoOnly ? "crypto" : stocksOnly ? "stock" : "active";
  console.log(`[trader] No ${scope} strategies. Activate one from the dashboard: npm run dashboard`);
  process.exit(0);
}

console.log(`[trader] Active strategies: ${strategies.map(s => s.name).join(", ")}`);

for (const strategy of strategies) {
  console.log(`\n[trader] ── ${strategy.name} (${strategy.symbol}) ──`);

  // Check interval — skip if not due yet
  if (!isStrategyDue(strategy.id)) {
    console.log(`[trader] ⏱ Not due yet (every ${strategy.interval_minutes}min) — skipping`);
    continue;
  }

  // Fetch signal
  const signalData = await fetchSignal(strategy.id);
  if (!signalData) {
    console.warn(`[trader] Skipping ${strategy.name} — could not fetch signal`);
    continue;
  }
  touchStrategyRun(strategy.id);

  const signal = signalData.signal;
  const price  = signalData.price ?? null;

  // Build notes from scores (signalData.compass is the full market_reports row)
  const c = signalData.compass;
  const scoreNotes = [
    c?.score       != null ? `COMPASS:${c.score}` : null,
    c?.radar_score != null ? `RADAR:${c.radar_score}` : null,
    c?.crypto_radar_score != null ? `CRYPTO:${c.crypto_radar_score}` : null,
  ].filter(Boolean).join(" | ");

  // Store signal
  upsertSignal({
    strategy_id: strategy.id,
    date: today,
    signal,
    price,
    notes: scoreNotes || null,
  });

  // Get prior signal to detect flips
  const priorSignal = getPriorSignal(strategy.id);
  const signalChanged = !priorSignal || priorSignal.signal !== signal;

  if (!signalChanged) {
    console.log(`[trader] ⚪ Signal unchanged (${signal}) — holding`);
    insertSignalEvent({
      strategy_id: strategy.id,
      signal,
      prev_signal: priorSignal?.signal ?? null,
      price,
      notes: scoreNotes || null,
      type: "check",
    });
    // Still check TP/trail even when signal hasn't changed
    if (signal === "LONG") await checkTpTrail(strategy);
    continue;
  }

  // Record the flip as a feed event
  insertSignalEvent({
    strategy_id: strategy.id,
    signal,
    prev_signal: priorSignal?.signal ?? null,
    price,
    notes: scoreNotes || null,
    type: "flip",
  });

  console.log(`[trader] 🔄 Signal flip: ${priorSignal?.signal ?? "N/A"} → ${signal}`);

  try {
    await executeTrade(strategy, signal, priorSignal);
  } catch (err) {
    console.error(`[trader] ❌ Execution error for ${strategy.name}: ${err.message}`);
  }
}

console.log(`\n[trader] Done.`);
