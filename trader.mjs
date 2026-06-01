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
import Decimal from "decimal.js";

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
const ALPACA_API_KEY         = process.env.ALPACA_API_KEY?.trim();
const ALPACA_API_SECRET      = process.env.ALPACA_API_SECRET?.trim();
const ALPACA_PAPER           = process.env.ALPACA_PAPER === "true";
const COINBASE_API_KEY        = process.env.COINBASE_API_KEY?.trim();
const COINBASE_API_SECRET     = process.env.COINBASE_API_SECRET?.trim();
const COINBASE_API_PASSPHRASE = process.env.COINBASE_API_PASSPHRASE?.trim();
const SCHWAB_API_KEY          = process.env.SCHWAB_API_KEY?.trim();
const SCHWAB_APP_SECRET       = process.env.SCHWAB_APP_SECRET?.trim();
const AGENT_API_KEY           = process.env.AGENT_API_KEY?.trim();
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
  "XMR","ETC","BCH","AAVE","CRV","MKR","SNX","LDO","RETH","STETH","WBTC","VVV","VULT","ZEC",
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
  updateTpHighWater, clearTpState, logFetch, getLastTradeTime,
} from "./db.mjs";

import { HyperliquidExchange } from "./exchanges/hyperliquid.mjs";
import { KrakenExchange } from "./exchanges/kraken.mjs";
import { AlpacaExchange } from "./exchanges/alpaca.mjs";
import { CoinbaseExchange } from "./exchanges/coinbase.mjs";
import { SchwabExchange } from "./exchanges/schwab.mjs";

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
  if (exch === "coinbase") {
    if (!COINBASE_API_KEY || !COINBASE_API_SECRET || !COINBASE_API_PASSPHRASE) throw new Error("COINBASE_API_KEY, COINBASE_API_SECRET, and COINBASE_API_PASSPHRASE are required for Coinbase strategies");
    return new CoinbaseExchange(COINBASE_API_KEY, COINBASE_API_SECRET, COINBASE_API_PASSPHRASE);
  }
  if (exch === "schwab") {
    if (!SCHWAB_API_KEY || !SCHWAB_APP_SECRET) throw new Error("SCHWAB_API_KEY and SCHWAB_APP_SECRET are required for Schwab strategies");
    return new SchwabExchange(SCHWAB_API_KEY, SCHWAB_APP_SECRET, {
      optionMode:  strategy.option_mode  ?? null,
      dteTarget:   strategy.dte_target   ?? 30,
      deltaTarget: strategy.delta_target ?? 0.30,
      contracts:   strategy.contracts    ?? 1,
    });
  }
  if (!PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY is required for Hyperliquid strategies");
  return new HyperliquidExchange(PRIVATE_KEY);
}

// ── Retry / guard helpers ─────────────────────────────────────────────────────

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isTransient =
        err.cause?.code === "ECONNRESET" || err.cause?.code === "ETIMEDOUT" ||
        err.cause?.code === "ENOTFOUND"  || err.cause?.code === "ECONNREFUSED" ||
        err.message?.includes("fetch failed") || err.message?.includes("timeout");
      if (!isTransient || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[trader] Network error, retry ${attempt}/${maxAttempts - 1} in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function runGuards(strategy, sizeUsd) {
  if (strategy.max_size_usd && sizeUsd > strategy.max_size_usd) {
    return `position size $${sizeUsd} exceeds max $${strategy.max_size_usd}`;
  }
  if (strategy.cooldown_minutes) {
    const lastTrade = getLastTradeTime(strategy.id);
    if (lastTrade) {
      const minutesAgo = (Date.now() - new Date(lastTrade + "Z").getTime()) / 60000;
      if (minutesAgo < strategy.cooldown_minutes) {
        return `cooldown active — last trade ${Math.round(minutesAgo)}min ago (cooldown: ${strategy.cooldown_minutes}min)`;
      }
    }
  }
  return null;
}

// ── Indicator helpers ─────────────────────────────────────────────────────────

function minutesToInterval(min) {
  const m = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 120: "2h", 240: "4h", 480: "8h", 720: "12h", 1440: "1d" };
  return m[min] ?? `${min}m`;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function computeEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// ── Strategy definition fetch (free, no x402) ────────────────────────────────

async function fetchStrategyDef(strategyId) {
  try {
    const res = await fetch(`${AGENT_SIGNAL_URL}/api/strategy/${strategyId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Local eval — price thresholds + candle indicators (no x402) ──────────────

async function tryLocalEval(strategy, def) {
  try {
    if (!def) return null;
    const parse = v => typeof v === "string" ? JSON.parse(v) : v;
    const hasConditions = r => r?.conditions?.length > 0;
    const entry = hasConditions(parse(def.long_entry)) ? parse(def.long_entry) : parse(def.entry);
    const exit  = hasConditions(parse(def.long_exit))  ? parse(def.long_exit)  : parse(def.exit);

    const allConds = [...(entry?.conditions ?? []), ...(exit?.conditions ?? [])];
    if (!allConds.length) return null;

    const priceFlds     = new Set(["close", "price", "last", "mark", "open", "high", "low"]);
    const indicatorFlds = new Set(["rsi", "sma", "ema"]);
    const knownFlds     = new Set([...priceFlds, ...indicatorFlds]);
    if (!allConds.every(c => knownFlds.has((c.field ?? "close").toLowerCase()))) return null;

    const asset    = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
    const exchange = getExchange(strategy);

    const needsCandles = allConds.some(c => indicatorFlds.has((c.field ?? "close").toLowerCase()));

    const [price, position] = await Promise.all([
      withRetry(() => exchange.getMidPrice(asset)),
      withRetry(() => exchange.getPosition(asset)),
    ]);
    if (!price) return null;

    const hasPosition = parseFloat(position?.szi ?? "0") !== 0;

    // Fetch candles + compute indicators if needed
    const indicatorValues = {};
    if (needsCandles) {
      if (typeof exchange.getCandles !== "function") return null; // exchange doesn't support candles
      const defaultInterval = minutesToInterval(strategy.interval_minutes ?? 60);
      const intervals = new Set(allConds.map(c => c.interval ?? defaultInterval));
      const candlesByInterval = {};
      for (const iv of intervals) {
        const candles = await withRetry(() => exchange.getCandles(asset, iv, 100));
        candlesByInterval[iv] = candles.map(c => parseFloat(c.c));
      }
      for (const c of allConds) {
        const field = (c.field ?? "close").toLowerCase();
        if (!indicatorFlds.has(field)) continue;
        const iv     = c.interval ?? defaultInterval;
        const period = parseInt(c.period ?? 14);
        const key    = `${field}_${period}_${iv}`;
        if (indicatorValues[key] !== undefined) continue;
        const closes = candlesByInterval[iv];
        if (!closes?.length) continue;
        switch (field) {
          case "rsi": indicatorValues[key] = computeRSI(closes, period); break;
          case "sma": indicatorValues[key] = computeSMA(closes, period); break;
          case "ema": indicatorValues[key] = computeEMA(closes, period); break;
        }
      }
    }

    const defaultInterval = minutesToInterval(strategy.interval_minutes ?? 60);
    const evalRules = (rules) => {
      if (!rules?.conditions?.length) return false;
      const results = rules.conditions.map(c => {
        const field = (c.field ?? "close").toLowerCase();
        const v     = parseFloat(c.value);
        let actual;
        if (indicatorFlds.has(field)) {
          const period = parseInt(c.period ?? 14);
          const iv     = c.interval ?? defaultInterval;
          actual = indicatorValues[`${field}_${period}_${iv}`];
        } else {
          actual = price;
        }
        if (actual == null) return false;
        const op = c.op;
        if (op === "<="  || op === "lte") return actual <= v;
        if (op === ">="  || op === "gte") return actual >= v;
        if (op === "<"   || op === "lt")  return actual <  v;
        if (op === ">"   || op === "gt")  return actual >  v;
        return false;
      });
      return rules.operator === "AND" ? results.every(Boolean) : results.some(Boolean);
    };

    // Scalper model: signal derived from actual position + conditions, not signal history
    const signal = hasPosition
      ? (evalRules(exit)  ? "FLAT" : "LONG")
      : (evalRules(entry) ? "LONG" : "FLAT");

    const indLog = Object.entries(indicatorValues)
      .map(([k, v]) => {
        const [fld, period, iv] = k.split("_");
        return `${fld.toUpperCase()}(${period},${iv})=${v?.toFixed(2)}`;
      })
      .join(" ");
    console.log(`[trader] 📊 Local eval: ${asset} @ $${price.toLocaleString()}${indLog ? " | " + indLog : ""} | pos: ${hasPosition ? "open" : "flat"} → ${signal}`);
    return { signal, price };
  } catch (err) {
    console.warn(`[trader] Local eval failed: ${err.message}`);
    return null;
  }
}

// ── Subscribe strategy (lump-sum x402) ───────────────────────────────────────

async function subscribeStrategy(strategyId, intervalMinutes, period) {
  const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
  const days = PERIOD_DAYS[period];
  if (!days) throw new Error(`Invalid subscription period: ${period}`);

  const url = `${AGENT_SIGNAL_URL}/api/strategy/${strategyId}/subscribe?interval_minutes=${intervalMinutes}&period=${period}`;
  const { x402Client } = await import("@x402/core/client");
  const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const allChains = await import("viem/chains");

  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = new x402Client();

  const probe = await fetch(url, { method: "POST", headers: { "X-Wallet-Address": account.address } });
  if (probe.ok) return await probe.json();
  if (probe.status !== 402) throw new Error(`Subscribe API ${probe.status}`);

  const rawHeader = probe.headers.get("payment-required") ?? probe.headers.get("X-PAYMENT-REQUIRED");
  if (!rawHeader) throw new Error("No payment-required header");
  const paymentRequired = decodePaymentRequiredHeader(rawHeader);

  const serverNetwork = paymentRequired.accepts?.[0]?.network ?? paymentRequired.accepts?.network;
  const networkCfg = X402_NETWORKS[serverNetwork] ?? X402_NETWORKS["eip155:8453"];
  const chain = allChains[networkCfg.viemChain];
  const walletClient = createWalletClient({ account, chain, transport: http(networkCfg.rpc) });
  const signer = Object.assign(walletClient, { address: account.address });
  client.register(serverNetwork, new ExactEvmScheme(signer));

  const calls = Math.round((60 / intervalMinutes) * 24 * days);
  const priceUsd = (Math.round(calls * 0.01 * 100) / 100).toFixed(2);
  console.log(`[trader] 🔄 Auto-renewing ${period} subscription for strategy ${strategyId} — $${priceUsd}`);

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeader = encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetch(url, { method: "POST", headers: { "payment-signature": paymentHeader, "X-Wallet-Address": account.address } });
  if (!paid.ok) throw new Error(`Subscription payment rejected (${paid.status})`);
  return await paid.json();
}

// ── Fetch signal from agentsignal.app ─────────────────────────────────────────

async function fetchSignal(strategy) {
  const strategyId = typeof strategy === "string" ? strategy : strategy.id;
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

    // Step 1: probe — send API key header so AgentSignal can bypass x402 for paid subscribers
    const probeHeaders = { "X-Wallet-Address": account.address };
    if (AGENT_API_KEY) probeHeaders["Authorization"] = "Bearer " + AGENT_API_KEY;
    const probe = await fetch(url, { headers: probeHeaders });
    if (probe.ok) {
      const data = await probe.json();
      const network = AGENT_API_KEY ? "api_key" : "bypass";
      console.log(`[trader] ✅ Signal fetched for ${strategyId} (${network}): ${data.signal}`);
      logFetch({ strategy_id: strategyId, network, cost_usd: 0 });
      return data;
    }
    if (probe.status !== 402) throw new Error(`Signal API ${probe.status}`);

    // Auto-renew subscription if strategy has a preferred period
    const subPeriod = typeof strategy === "object" ? strategy.subscription_period : null;
    if (subPeriod) {
      try {
        const iv = typeof strategy === "object" ? (strategy.interval_minutes ?? 60) : 60;
        await subscribeStrategy(strategyId, iv, subPeriod);
        // Retry — subscription now active
        const retried = await fetch(url, { headers: { "X-Wallet-Address": account.address } });
        if (retried.ok) {
          const data = await retried.json();
          console.log(`[trader] ✅ Signal fetched for ${strategyId} (auto-renewed ${subPeriod}): ${data.signal}`);
          logFetch({ strategy_id: strategyId, network: "subscription", cost_usd: 0 });
          return data;
        }
      } catch (e) {
        console.warn(`[trader] Auto-renew failed: ${e.message} — falling back to per-call`);
      }
    }

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
    const res = await fetch(url, { headers: { "payment-signature": paymentHeader, "X-Wallet-Address": account.address } });
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
  const asset    = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  const exchange = getExchange(strategy);

  // Check actual position on exchange — not signal state
  const position    = await withRetry(() => exchange.getPosition(asset));
  const positionSzi = parseFloat(position?.szi ?? "0");

  // No open position — clear stale TP state and bail
  if (positionSzi === 0) {
    clearTpState(strategy.id);
    return false;
  }

  let state = getTpState(strategy.id);

  // Position exists but no TP state (e.g. manual entry) — auto-initialize
  if (!state && strategy.tp_pct) {
    const entryPrice = parseFloat(position?.entryPx ?? "0");
    if (entryPrice > 0) {
      const tpPrice = positionSzi > 0
        ? entryPrice * (1 + strategy.tp_pct / 100)
        : entryPrice * (1 - strategy.tp_pct / 100);
      setTpState({
        strategy_id: strategy.id,
        entry_price: entryPrice,
        tp_price:    tpPrice,
        trail_pct:   strategy.trail_pct ?? 1,
      });
      state = getTpState(strategy.id);
      console.log(`[trader] 📊 Auto-initialized TP for ${strategy.name}: entry $${entryPrice.toLocaleString()} → TP $${tpPrice.toLocaleString()}`);
    }
  }

  const price = await withRetry(() => exchange.getMidPrice(asset));
  if (!price) return false;

  // Stop loss check — runs before TP/trail
  if (strategy.sl_pct) {
    const entryPx = parseFloat(position?.entryPx ?? "0");
    if (entryPx > 0) {
      const isLong   = positionSzi > 0;
      const slPrice  = isLong ? entryPx * (1 - strategy.sl_pct / 100) : entryPx * (1 + strategy.sl_pct / 100);
      const slHit    = isLong ? price <= slPrice : price >= slPrice;
      if (slHit) {
        const size = Math.abs(positionSzi);
        const pnl  = parseFloat(((price - entryPx) * size * (isLong ? 1 : -1)).toFixed(2));
        console.log(`[trader] 🛑 Stop loss @ $${price.toLocaleString()} (entry $${entryPx.toLocaleString()}, SL $${slPrice.toLocaleString()})`);
        if (!isDryRun) await exchange.closePosition(asset);
        else console.log(`[trader] [DRY RUN] Would close via stop loss`);
        clearTpState(strategy.id);
        insertTrade({
          strategy_id: strategy.id,
          action: `STOP LOSS @ $${price.toLocaleString()} (entry $${entryPx.toLocaleString()})`,
          asset, size, price, leverage: strategy.leverage ?? 1, pnl,
          result: { stop_loss: true, entry_price: entryPx, sl_price: slPrice },
        });
        console.log(`[trader] P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
        return true;
      }
    }
  }

  if (!state) return false;

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

  const midPrice = await withRetry(() => exchange.getMidPrice(asset));
  if (!midPrice) throw new Error(`Could not get price for ${asset}`);

  const positionSize = new Decimal(sizeUsd).times(leverage).div(midPrice).toDecimalPlaces(5).toNumber();

  const guardBlock = runGuards(strategy, sizeUsd);
  if (guardBlock) {
    console.warn(`[trader] 🛡 Guard blocked: ${guardBlock}`);
    return;
  }

  const position     = await withRetry(() => exchange.getPosition(asset));
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
      await withRetry(() => exchange.setLeverage(asset, leverage));
      result = await withRetry(() => exchange.placeMarketOrder(asset, "buy", positionSize));
    }
    if (strategy.tp_pct && strategy.trail_pct) {
      const tpPrice = new Decimal(midPrice).times(1 + strategy.tp_pct / 100).toDecimalPlaces(2).toNumber();
      setTpState({ strategy_id: strategy.id, entry_price: midPrice, tp_price: tpPrice, trail_pct: strategy.trail_pct });
      console.log(`[trader] 🎯 TP set: +${strategy.tp_pct}% = $${tpPrice.toLocaleString()} | trail ${strategy.trail_pct}%`);
    }
  } else if (signal === "FLAT" && !isFlat) {
    action = `CLOSED ${Math.abs(currentSize)} ${asset} @ ~$${midPrice.toLocaleString()}`;
    if (entryPrice > 0) {
      const dir = isLong ? 1 : -1;
      pnl = new Decimal(midPrice).minus(entryPrice).times(Math.abs(currentSize)).times(dir).toDecimalPlaces(2).toNumber();
      console.log(`[trader] P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
    }
    if (!isDryRun) {
      result = await withRetry(() => exchange.closePosition(asset));
    }
    clearTpState(strategy.id);
  } else if (signal === "SHORT" && !isFlat) {
    action = `SHORTED ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    if (entryPrice > 0 && isLong) {
      pnl = new Decimal(midPrice).minus(entryPrice).times(Math.abs(currentSize)).toDecimalPlaces(2).toNumber();
      console.log(`[trader] Closed long P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
    }
    if (!isDryRun) {
      await withRetry(() => exchange.closePosition(asset));
      await withRetry(() => exchange.setLeverage(asset, leverage));
      result = await withRetry(() => exchange.placeMarketOrder(asset, "sell", positionSize));
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

  // Fetch strategy definition once — used for local eval + risk fallback
  const def  = await fetchStrategyDef(strategy.id);
  const risk = def?.risk ?? {};
  const effectiveStrategy = {
    ...strategy,
    tp_pct:    strategy.tp_pct    ?? risk.tp_pct    ?? null,
    trail_pct: strategy.trail_pct ?? risk.trail_pct ?? null,
    sl_pct:    strategy.sl_pct    ?? risk.sl_pct ?? risk.stop_loss_pct ?? null,
  };

  // Try local candle/indicator eval first, fall back to x402 fetch
  const signalData = await tryLocalEval(effectiveStrategy, def) ?? await fetchSignal(effectiveStrategy);
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
    // Check TP/trail/SL based on actual exchange position, not signal
    await checkTpTrail(effectiveStrategy);
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
    await executeTrade(effectiveStrategy, signal, priorSignal);
  } catch (err) {
    console.error(`[trader] ❌ Execution error for ${strategy.name}: ${err.message}`);
  }
}

console.log(`\n[trader] Done.`);

