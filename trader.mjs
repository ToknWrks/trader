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
const VAULT_ACTIVE      = process.env.VAULT_ACTIVE === "true";
const VULT_FILE_PATH    = process.env.VULT_FILE_PATH?.trim();
const VULTISIG_PASS     = process.env.VULTISIG_PASS;
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
const strategyIdx      = argv.indexOf("--strategy");
const strategyFilter   = strategyIdx !== -1 ? (argv[strategyIdx + 1] || null) : null;
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

if (!PRIVATE_KEY && !KRAKEN_API_KEY && !ALPACA_API_KEY && !VAULT_ACTIVE) {
  console.error("[trader] No exchange credentials found. Run: npm run setup");
  process.exit(1);
}

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  getActiveStrategies, upsertSignal, getLatestSignal,
  getPriorSignal, insertTrade, isStrategyDue, touchStrategyRun,
  insertSignalEvent, setTpState, getTpState, updateTpTrailMode,
  updateTpHighWater, clearTpState, logFetch, getLastTradeTime,
  setSubscriptionExpiry, getLastStrategyEntry, setStrategyRiskMode,
  getTradingWallet, setStrategySlPct,
} from "./db.mjs";

import { HyperliquidExchange } from "./exchanges/hyperliquid.mjs";
import { KrakenExchange } from "./exchanges/kraken.mjs";
import { AlpacaExchange } from "./exchanges/alpaca.mjs";
import { CoinbaseExchange } from "./exchanges/coinbase.mjs";
import { SchwabExchange } from "./exchanges/schwab.mjs";

// Resolve the Hyperliquid signer once and cache it. When the Vultisig MPC vault
// is the active trading wallet, this is a viem-style account that co-signs with
// VultiServer; otherwise the Hyperliquid branch uses the raw AGENT_PRIVATE_KEY.
let _vaultSigner;
async function getVaultSigner() {
  if (_vaultSigner !== undefined) return _vaultSigner;
  if (!VULT_FILE_PATH) throw new Error("VAULT_ACTIVE=true but VULT_FILE_PATH is not set — create/import a vault from the dashboard");
  const { loadVultisigAccount } = await import("./vultisig-account.mjs");
  _vaultSigner = await loadVultisigAccount({ vultPath: VULT_FILE_PATH, password: VULTISIG_PASS });
  console.log(`[trader] 🔐 Vultisig MPC vault active — signing as ${_vaultSigner.address}`);
  return _vaultSigner;
}

async function getExchange(strategy) {
  const exch = strategy.exchange ?? "hyperliquid";
  if (exch === "kraken") {
    if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) throw new Error("KRAKEN_API_KEY and KRAKEN_API_SECRET are required for Kraken strategies");
    return new KrakenExchange(KRAKEN_API_KEY, KRAKEN_API_SECRET, strategy.leverage ?? 1);
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
  if (VAULT_ACTIVE) {
    return new HyperliquidExchange(await getVaultSigner());
  }
  // The db trading wallet is the source of truth; the dashboard keeps
  // AGENT_PRIVATE_KEY in sync with it, so env is the fallback.
  const key = getTradingWallet()?.key ?? PRIVATE_KEY;
  if (!key) throw new Error("No trading wallet set and AGENT_PRIVATE_KEY is unset — pick a wallet in the dashboard");
  return new HyperliquidExchange(key);
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

// Wilder's smoothed ATR. Candles must have .h .l .c fields.
function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = parseFloat(candles[i].h), l = parseFloat(candles[i].l), pc = parseFloat(candles[i - 1].c);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
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

    const risk = parse(def.risk) ?? {};

    const hasConditions = r => r?.conditions?.length > 0;
    const entry       = hasConditions(parse(def.long_entry))  ? parse(def.long_entry)  : parse(def.entry);
    const exit        = hasConditions(parse(def.long_exit))   ? parse(def.long_exit)   : parse(def.exit);
    const shortEntry  = hasConditions(parse(def.short_entry)) ? parse(def.short_entry) : null;
    const shortExit   = hasConditions(parse(def.short_exit))  ? parse(def.short_exit)  : null;

    const allConds = [
      ...(entry?.conditions ?? []), ...(exit?.conditions ?? []),
      ...(shortEntry?.conditions ?? []), ...(shortExit?.conditions ?? []),
    ];
    if (!allConds.length) return null;

    const priceFlds     = new Set(["close", "price", "last", "mark", "open", "high", "low"]);
    const indicatorFlds = new Set(["rsi", "sma", "ema"]);
    const passthroughFlds = new Set(["pct_above_entry", "pct_below_entry"]);
    const knownFlds     = new Set([...priceFlds, ...indicatorFlds, ...passthroughFlds]);

    const asset    = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
    const exchange = await getExchange(strategy);

    // Fetch position first — needed to decide whether RADAR gate applies
    const [price, position] = await Promise.all([
      withRetry(() => exchange.getMidPrice(asset)),
      withRetry(() => exchange.getPosition(asset)),
    ]);
    if (!price) return null;

    const hasPosition = parseFloat(position?.szi ?? "0") !== 0;
    const isLong      = parseFloat(position?.szi ?? "0") > 0;

    // Crypto RADAR gate blocks new entries only — if flat, defer entry decision to server.
    // When already in a position, evaluate exit conditions locally; RADAR is irrelevant to exits.
    if (!hasPosition && (risk.crypto_radar_long_gate != null || risk.crypto_radar_short_gate != null)) {
      console.log(`[trader] 📡 Crypto RADAR gate configured — deferring entry signal to server`);
      return null;
    }

    // When in a position, only the relevant exit conditions matter.
    // Unknown fields in entry rules (e.g. macd_cross) shouldn't block exit evaluation.
    const relevantConds = hasPosition
      ? (isLong ? [...(exit?.conditions ?? [])] : [...(shortExit?.conditions ?? [])])
      : allConds;

    if (!relevantConds.length) return null;
    if (!relevantConds.every(c => knownFlds.has((c.field ?? "close").toLowerCase()))) return null;

    const needsCandles = relevantConds.some(c => indicatorFlds.has((c.field ?? "close").toLowerCase()));

    // Fetch candles + compute indicators if needed
    const indicatorValues = {};
    if (needsCandles) {
      if (typeof exchange.getCandles !== "function") return null; // exchange doesn't support candles
      const defaultInterval = minutesToInterval(strategy.interval_minutes ?? 60);
      const intervals = new Set(relevantConds.map(c => c.interval ?? defaultInterval));
      const candlesByInterval = {};
      for (const iv of intervals) {
        const candles = await withRetry(() => exchange.getCandles(asset, iv, 100));
        candlesByInterval[iv] = candles.map(c => parseFloat(c.c));
      }
      for (const c of relevantConds) {
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
        if (passthroughFlds.has(field)) {
          const entryPx = parseFloat(position?.entryPx ?? "0");
          if (!entryPx || !hasPosition) return true;
          if (field === "pct_above_entry") {
            actual = isLong
              ? (price - entryPx) / entryPx * 100
              : (entryPx - price) / entryPx * 100;
          } else if (field === "pct_below_entry") {
            actual = isLong
              ? (entryPx - price) / entryPx * 100
              : (price - entryPx) / entryPx * 100;
          } else {
            return true;
          }
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

    // Funding gate check (mirrors server-side fail-closed logic)
    let fundingRate = null;
    if (risk.funding_long_gate != null || risk.funding_short_gate != null) {
      try {
        const fRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        });
        const [meta, ctxs] = await fRes.json();
        const idx = meta.universe.findIndex(a => a.name === asset);
        if (idx !== -1) fundingRate = parseFloat(ctxs[idx].funding);
      } catch { /* funding unavailable — fail closed */ }
    }
    const longGateOk  = risk.funding_long_gate  == null || (fundingRate !== null && fundingRate <= risk.funding_long_gate);
    const shortGateOk = risk.funding_short_gate == null || (fundingRate !== null && fundingRate >= risk.funding_short_gate);

    // 4-ruleset scalper model: long + short independent entry/exit
    let signal;
    if (shortEntry) {
      if (hasPosition) {
        const isLong  = parseFloat(position?.szi ?? "0") > 0;
        signal = isLong
          ? (evalRules(exit)      ? "FLAT" : "LONG")
          : (evalRules(shortExit) ? "FLAT" : "SHORT");
      } else {
        if      (evalRules(entry)      && longGateOk)  signal = "LONG";
        else if (evalRules(shortEntry) && shortGateOk) signal = "SHORT";
        else                                            signal = "FLAT";
      }
    } else {
      // Legacy long-only model
      signal = hasPosition
        ? (evalRules(exit)  ? "FLAT" : "LONG")
        : (evalRules(entry) ? "LONG" : "FLAT");
    }

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

// ── Entry confirmation gate ───────────────────────────────────────────────────
// Four layers run on every new scalper entry signal. Exits (FLAT) are never
// blocked. Returns { slPct } on pass, null on block. Fails open — candle errors
// return { slPct: strategy.sl_pct } so the fallback SL still applies.
//
// Layer 1 — RSI band: only enter in "healthy trend" zone (40–65 long, 35–60 short).
//           Blocks overbought chasing and oversold panic entries.
// Layer 2 — EMA50 trend: price must be above EMA50 for longs, below for shorts.
// Layer 3 — ATR volatility regime: if ATR(14) > 1.5×ATR(50), market is stressed
//           — stand aside until volatility normalises.
// Layer 4 — BTC macro filter: if BTC drops >2.5% on the last 4h candle, skip
//           all alt entries (most alt selloffs are BTC-led).
// Adaptive SL — computed as 1.5×ATR(14) / price, clamped [3%, 15%]. Widens in
//           volatile conditions, tightens in calm ones. Written to the DB at entry
//           so checkTpTrail uses the condition-appropriate stop throughout the trade.
//
// TUNING: if too many blocks → widen RSI band (e.g. 35–70 long), lower ATR ratio
//         (e.g. 1.8×), or raise BTC threshold (e.g. -3.5%). If too many losses →
//         tighten RSI band, lower ATR ratio (e.g. 1.2×), lower BTC threshold.

async function confirmEntry(strategy, signal, exchange) {
  if (signal !== "LONG" && signal !== "SHORT") return { slPct: strategy.sl_pct };
  const asset = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  try {
    const position = await withRetry(() => exchange.getPosition(asset));
    if (parseFloat(position?.szi ?? "0") !== 0) return { slPct: strategy.sl_pct }; // already in

    if (typeof exchange.getCandles !== "function") return { slPct: strategy.sl_pct };
    const iv      = minutesToInterval(strategy.interval_minutes ?? 60);
    const candles = await withRetry(() => exchange.getCandles(asset, iv, 60));
    if (!candles?.length) return { slPct: strategy.sl_pct };

    const closes = candles.map(c => parseFloat(c.c));
    const price  = closes[closes.length - 1];
    const rsi    = computeRSI(closes, 14);
    const ema50  = computeEMA(closes, 50);
    const atr14  = computeATR(candles, 14);
    const atr50  = computeATR(candles, 50);

    // ── Layer 1: RSI band ────────────────────────────────────────────────
    if (rsi != null) {
      const [lo, hi] = signal === "LONG" ? [40, 65] : [35, 60];
      if (rsi < lo || rsi > hi) {
        console.log(`[trader] 🚫 Gate L1 blocked ${signal} — RSI ${rsi.toFixed(1)} outside band [${lo}–${hi}]`);
        return null;
      }
    }

    // ── Layer 2: EMA50 trend alignment ───────────────────────────────────
    if (ema50 != null) {
      const trendOk = signal === "LONG" ? price > ema50 : price < ema50;
      if (!trendOk) {
        console.log(`[trader] 🚫 Gate L2 blocked ${signal} — price ${signal === "LONG" ? "below" : "above"} EMA50 $${ema50.toFixed(4)}`);
        return null;
      }
    }

    // ── Layer 3: ATR volatility regime ───────────────────────────────────
    if (atr14 != null && atr50 != null && atr14 > atr50 * 1.5) {
      console.log(`[trader] 🚫 Gate L3 blocked ${signal} — elevated volatility (ATR14 ${atr14.toFixed(4)} > 1.5×ATR50 ${atr50.toFixed(4)})`);
      return null;
    }

    // ── Layer 4: BTC macro filter ────────────────────────────────────────
    try {
      const now = Date.now();
      const btcRaw = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "4h", startTime: now - 3 * 4 * 3600 * 1000, endTime: now } }),
      }).then(r => r.json());
      if (Array.isArray(btcRaw) && btcRaw.length >= 2) {
        const prev = parseFloat(btcRaw[btcRaw.length - 2].c);
        const cur  = parseFloat(btcRaw[btcRaw.length - 1].c);
        const chg  = (cur - prev) / prev;
        if (chg < -0.025) {
          console.log(`[trader] 🚫 Gate L4 blocked ${signal} — BTC down ${(chg * 100).toFixed(1)}% in last 4h (macro risk)`);
          return null;
        }
      }
    } catch { /* BTC fetch failed — fail open */ }

    // ── Adaptive SL: 1.5×ATR as % of price, clamped [3%, 15%] ──────────
    let slPct = strategy.sl_pct ?? 7;
    if (atr14 != null && price > 0) {
      slPct = Math.max(3, Math.min(15, parseFloat((1.5 * atr14 / price * 100).toFixed(2))));
    }

    console.log(`[trader] ✅ Entry gate passed — RSI ${rsi?.toFixed(1)} | ATR14/50 ${atr14?.toFixed(4)}/${atr50?.toFixed(4)} | adaptive SL ${slPct.toFixed(2)}%`);
    return { slPct };
  } catch (err) {
    console.warn(`[trader] ⚠️  Entry gate error: ${err.message} — allowing entry`);
    return { slPct: strategy.sl_pct }; // fail open
  }
}

// ── Fetch signal from agentsignal.app ─────────────────────────────────────────

async function fetchSignal(strategy) {
  const strategyId = typeof strategy === "string" ? strategy : strategy.id;
  const isScalper = strategy.risk?.mode === "scalp";
  const url = isScalper
    ? `${AGENT_SIGNAL_URL}/api/scalper/${strategyId}/signal`
    : `${AGENT_SIGNAL_URL}/api/strategy/${strategyId}/signal`;
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

    // Auto-renew subscription if strategy has a preferred period and it has expired locally
    const subPeriod = typeof strategy === "object" ? strategy.subscription_period : null;
    const subExpiresAt = typeof strategy === "object" ? strategy.subscription_expires_at : null;
    const subStillValid = subExpiresAt && new Date(subExpiresAt) > new Date();
    if (subPeriod && !subStillValid) {
      try {
        const iv = typeof strategy === "object" ? (strategy.interval_minutes ?? 60) : 60;
        const subResult = await subscribeStrategy(strategyId, iv, subPeriod);
        // Record expiry locally so we don't try again until it actually expires
        if (subResult?.expires_at) setSubscriptionExpiry(strategyId, subResult.expires_at);
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
    } else if (subStillValid) {
      console.log(`[trader] 📋 Subscription valid until ${subExpiresAt} — skipping auto-renew`);
    }

    // Warn if falling back to per-call — subscription missing or expired
    const subExpired = subExpiresAt && new Date(subExpiresAt) <= new Date();
    if (subExpired) {
      console.warn(`[trader] ⚠️  Subscription expired ${subExpiresAt} — paying per-call. Renew from the dashboard.`);
    } else if (!subPeriod) {
      console.warn(`[trader] ⚠️  No subscription set for ${strategyId} — paying per-call. Set one from the dashboard.`);
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

    console.warn(`[trader] 💳 Per-call payment on ${networkCfg.label ?? serverNetwork} ($0.01)`);

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
  const exchange = await getExchange(strategy);

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

  const exchange = await getExchange(strategy);

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
  } else if (signal === "SHORT" && isFlat) {
    action = `ENTERED SHORT ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    if (!isDryRun) {
      await withRetry(() => exchange.setLeverage(asset, leverage));
      result = await withRetry(() => exchange.placeMarketOrder(asset, "sell", positionSize));
    }
  } else if (signal === "SHORT" && !isFlat && isLong) {
    action = `FLIPPED SHORT ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    if (entryPrice > 0) {
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

  if (isDryRun) {
    console.log(`[trader] [DRY RUN] Would: ${action}`);
    return;
  }
  console.log(`[trader] ✅ ${action}`);

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
  if (strategyFilter) return s.id === strategyFilter;
  if (cryptoOnly) return isCrypto(s.symbol);
  if (stocksOnly) return !isCrypto(s.symbol);
  return true;
});

if (!strategies.length) {
  const scope = strategyFilter ? `strategy ${strategyFilter}` : cryptoOnly ? "crypto" : stocksOnly ? "stock" : "active";
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
  const parseJson = v => { try { return typeof v === "string" ? JSON.parse(v) : (v ?? {}); } catch { return {}; } };
  const risk = parseJson(def?.risk);
  if (risk?.mode) setStrategyRiskMode(strategy.id, risk.mode);
  const effectiveStrategy = {
    ...strategy,
    risk,  // expose parsed risk so fetchSignal can detect scalper mode + gate checks
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

  // Read prior signal BEFORE upserting — includes today's earlier fetches for intraday strategies
  const priorSignal = getLatestSignal(strategy.id);
  const signalChanged = !priorSignal || priorSignal.signal !== signal;

  // Store signal
  upsertSignal({
    strategy_id: strategy.id,
    date: today,
    signal,
    price,
    notes: scoreNotes || null,
  });

  const isScalper = effectiveStrategy.risk?.mode === "scalp";

  if (!signalChanged && (!isScalper || signal === "FLAT")) {
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

  // Entry confirmation gate — scalpers only, new entries only
  if (effectiveStrategy.risk?.mode === "scalp" && (signal === "LONG" || signal === "SHORT")) {
    const gateExchange = await getExchange(effectiveStrategy);
    const gateResult   = await confirmEntry(effectiveStrategy, signal, gateExchange);
    if (!gateResult) continue; // blocked — reason already logged inside confirmEntry
    if (gateResult.slPct != null) {
      setStrategySlPct(strategy.id, gateResult.slPct);
      effectiveStrategy.sl_pct = gateResult.slPct;
      console.log(`[trader] 🛡 Adaptive SL: ${gateResult.slPct.toFixed(2)}%`);
    }
  }

  try {
    await executeTrade(effectiveStrategy, signal, priorSignal);
  } catch (err) {
    console.error(`[trader] ❌ Execution error for ${strategy.name}: ${err.message}`);
  }
}

console.log(`\n[trader] Done.`);

// Sync position snapshot to AgentSignal account
if (AGENT_API_KEY && AGENT_SIGNAL_URL) {
  try {
    const snapshot = strategies.map(s => {
      const latest = getLatestSignal(s.id);
      const signal = latest?.signal ?? "FLAT";
      const entry = signal !== "FLAT" ? getLastStrategyEntry(s.id) : null;
      return {
        strategy_id:   s.id,
        strategy_name: s.name,
        asset:         s.symbol,
        exchange:      s.exchange ?? "hyperliquid",
        signal,
        signal_price:  latest?.price ?? null,
        entry_price:   entry?.price ?? null,
        leverage:      entry?.leverage ?? s.leverage ?? 1,
      };
    });
    const res = await fetch(`${AGENT_SIGNAL_URL}/api/account/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${AGENT_API_KEY}` },
      body: JSON.stringify({ positions: snapshot }),
    });
    if (res.ok) {
      const { synced } = await res.json();
      console.log(`[trader] 📡 Synced ${synced} position(s) to AgentSignal`);
    }
  } catch (e) {
    console.warn(`[trader] ⚠️  Position sync failed: ${e.message}`);
  }
}

