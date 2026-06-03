#!/usr/bin/env node
/**
 * dashboard.mjs — AgentSignal Trader local dashboard
 * Open: http://localhost:4100
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "4100");

// Load .env
function loadEnv() {
  try {
    const lines = readFileSync(resolve(__dirname, ".env"), "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
    }
  } catch {}
}
loadEnv();

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
function getSignalUrl() { return process.env.AGENT_SIGNAL_URL ?? "https://agentsignal.app"; }

async function getAgentSignalUser() {
  const key = process.env.AGENT_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(`${getSignalUrl()}/api/auth/me`, {
      headers: { "Authorization": "Bearer " + key },
    });
    if (!res.ok) return null;
    return await res.json(); // { valid, email, tier }
  } catch { return null; }
}

function getSchwabClient() {
  const key = process.env.SCHWAB_API_KEY?.trim();
  const sec = process.env.SCHWAB_APP_SECRET?.trim();
  if (!key || !sec) return null;
  return new SchwabClient(key, sec);
}

// ── Schedule ──────────────────────────────────────────────────────────────────

function parseCron(cron) {
  try {
    const [minute, hour, , , days] = cron.split(" ");
    const utcH = parseInt(hour);
    if (isNaN(utcH)) {
      // e.g. "0 * * * *" — hourly
      return { label: "every hour", detail: `Cron: ${cron} — runs at the top of every hour, 24/7` };
    }
    const utcM = parseInt(minute);
    const edtH = utcH - 4;
    const fmt = (h, m) => `${((h + 24) % 24) % 12 || 12}:${String(m).padStart(2,"0")} ${((h + 24) % 24) >= 12 ? "PM" : "AM"}`;
    const daysLabel = days === "1-5" ? "weekdays" : days === "*" ? "every day" : `days ${days}`;
    return {
      label: `${fmt(edtH, utcM)} ET on ${daysLabel}`,
      detail: `Cron: ${cron} — runs at ${hour}:${String(utcM).padStart(2,"0")} UTC on ${daysLabel}`,
    };
  } catch {
    return { label: "on schedule", detail: `Cron: ${cron}` };
  }
}

function parseSchedules() {
  try {
    const content = readFileSync(resolve(__dirname, "ecosystem.config.cjs"), "utf8");
    const matches = [...content.matchAll(/cron_restart:\s*["']([^"']+)["']/g)];
    const stocksCron = matches[0]?.[1] ?? "31 13 * * 1-5";
    const cryptoCron = matches[1]?.[1] ?? "0 * * * *";
    return { stocks: parseCron(stocksCron), crypto: parseCron(cryptoCron) };
  } catch {
    return {
      stocks: { label: "9:31 AM ET on weekdays", detail: "Stocks run at market open" },
      crypto: { label: "every hour", detail: "Crypto runs hourly — 24/7 markets" },
    };
  }
}

const SCHEDULES = parseSchedules();

import {
  getStrategies, getStrategy, upsertStrategy, setStrategyActive, setSubscriptionPeriod,
  deleteStrategy, getSignalHistory, getAllRecentTrades, getLatestSignal,
  countSignals, countFetchesToday, countFetchesTotal, getRecentSignalEvents, getYtdPnl,
  getSnapshots, insertSnapshot, hasSnapshots, backfillSnapshotsFromTrades, insertTrade,
} from "./db.mjs";

import { getV3Positions, getV4Positions, getPnl, collectAndSwap } from "./uniswap-api.mjs";
import { SchwabClient } from "./exchanges/schwab.mjs";

// ── x402 network config ───────────────────────────────────────────────────────

const X402_NETWORKS = {
  "eip155:8453":  { label: "Base",               viemChain: "base",        rpc: "https://mainnet.base.org" },
};

function getPaymentNetwork() {
  return process.env.X402_PAYMENT_NETWORK || "eip155:8453";
}

// ── Network-aware USDC balance ────────────────────────────────────────────────

const X402_PRICE_USD = 0.01;

// USDC contract addresses per network
const USDC_ADDRESSES = {
  "eip155:8453":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
  "eip155:1":     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
  "eip155:137":   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon
  "eip155:43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Avalanche
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

async function getNetworkUsdcBalance(address) {
  const network = getPaymentNetwork();
  const networkCfg = X402_NETWORKS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!networkCfg || !usdcAddress) return null;
  try {
    const padded = address.toLowerCase().replace("0x", "").padStart(64, "0");
    const res = await fetch(networkCfg.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: usdcAddress, data: "0x70a08231" + padded }, "latest"],
      }),
    });
    const { result } = await res.json();
    return parseInt(result, 16) / 1e6; // USDC has 6 decimals
  } catch {
    return null;
  }
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; background: #09090b; color: #e4e4e7; min-height: 100vh; }
a { color: #A8F1F7; text-decoration: none; }
a:hover { color: #8ae8f0; }
header { background: #09090b; border-bottom: 1px solid rgba(255,255,255,0.07); padding: 0.9rem 2rem; display: flex; align-items: center; gap: 1.5rem; position: sticky; top: 0; z-index: 10; }
.logo { display: flex; align-items: center; gap: 0.6rem; font-size: 1rem; font-weight: 700; color: #fafafa; letter-spacing: -0.03em; }
.logo img { width: 24px; height: 24px; border-radius: 4px; }
.nav-links { display: flex; align-items: center; gap: 0.25rem; margin-left: auto; }
.nav-link { font-size: 0.8rem; color: rgba(255,255,255,0.5); padding: 0.3rem 0.75rem; border-radius: 6px; border: 1px solid transparent; transition: all 0.15s; cursor: pointer; background: none; }
.nav-link:hover, .nav-link.active { color: #A8F1F7; border-color: rgba(168,241,247,0.2); background: rgba(168,241,247,0.05); }
.container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
.section-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,0.5); margin-bottom: 0.85rem; }
details.accordion { margin-bottom: 1.5rem; }
details.accordion > summary { list-style: none; display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,0.5); margin-bottom: 0; padding: 0.4rem 0.75rem; border-radius: 6px; background: rgba(255,255,255,0.06); user-select: none; }
details.accordion > summary::-webkit-details-marker { display: none; }
details.accordion > summary::before { content: "▶"; font-size: 0.55rem; transition: transform 0.15s; display: inline-block; }
details.accordion[open] > summary::before { transform: rotate(90deg); }
details.accordion > summary:hover { color: rgba(255,255,255,0.75); }
details.accordion[open] > summary { margin-bottom: 0.85rem; }
.card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
.card h2 { font-size: 1rem; font-weight: 600; color: #fafafa; letter-spacing: -0.02em; margin-bottom: 1.25rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
th { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.55); text-align: left; padding: 0.55rem 0.85rem; border: 1px solid rgba(255,255,255,0.1); font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
td { padding: 0.55rem 0.85rem; border: 1px solid rgba(255,255,255,0.08); color: rgba(255,255,255,0.85); vertical-align: middle; }
tr:hover td { background: rgba(255,255,255,0.04); }
strong { color: #fafafa; }
.stat-row { display: flex; gap: 0.85rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.stat { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 0.85rem 1.25rem; min-width: 130px; }
.stat .label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.45); margin-bottom: 0.35rem; }
.stat .value { font-size: 1.15rem; font-weight: 700; color: #fafafa; letter-spacing: -0.02em; }
.green { color: #4ade80; } .red { color: #f87171; } .cyan { color: #A8F1F7; }
.badge-long { background: rgba(74,222,128,0.1); color: #4ade80; border: 1px solid rgba(74,222,128,0.25); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
.badge-short { background: rgba(248,113,113,0.1); color: #f87171; border: 1px solid rgba(248,113,113,0.25); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
.badge-flat { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.1); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
.badge-active { background: rgba(74,222,128,0.1); color: #4ade80; border: 1px solid rgba(74,222,128,0.25); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
.badge-inactive { background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.3); border: 1px solid rgba(255,255,255,0.08); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.7rem; }
.btn { font-size: 0.7rem; padding: 0.25rem 0.65rem; border-radius: 6px; cursor: pointer; background: transparent; transition: all 0.15s; }
.btn-green { border: 1px solid rgba(74,222,128,0.4); color: #4ade80; }
.btn-green:hover { background: rgba(74,222,128,0.1); }
.btn-red { border: 1px solid rgba(248,113,113,0.4); color: #f87171; }
.btn-red:hover { background: rgba(248,113,113,0.1); }
.btn-cyan { border: 1px solid rgba(168,241,247,0.3); color: #A8F1F7; }
.btn-cyan:hover { background: rgba(168,241,247,0.08); }
.hint { font-size: 0.78rem; color: rgba(255,255,255,0.4); margin-top: 1.5rem; }
.modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:100; align-items:center; justify-content:center; }
.modal-overlay.open { display:flex; }
.modal { background:#111113; border:1px solid rgba(255,255,255,0.12); border-radius:14px; padding:1.75rem; max-width:420px; width:90%; }
.modal-title { font-size:1rem; font-weight:700; color:#fafafa; letter-spacing:-0.02em; margin-bottom:0.5rem; }
.modal-body { font-size:0.82rem; color:rgba(255,255,255,0.6); line-height:1.6; }
.modal-body strong { color:#fafafa; }
.modal-body .flow { margin:1rem 0; padding:1rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; display:flex; flex-direction:column; gap:0.4rem; }
.modal-body .flow-step { display:flex; align-items:flex-start; gap:0.5rem; font-size:0.78rem; }
.modal-body .flow-step .num { color:#A8F1F7; font-weight:700; min-width:1rem; }
.modal-schedule { margin-top:0.75rem; padding:0.6rem 0.85rem; background:rgba(168,241,247,0.05); border:1px solid rgba(168,241,247,0.15); border-radius:6px; font-size:0.75rem; color:#A8F1F7; }
.modal-actions { display:flex; gap:0.65rem; margin-top:1.25rem; justify-content:flex-end; }
.modal-cancel { background:transparent; border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.5); border-radius:7px; padding:0.45rem 1rem; font-size:0.82rem; cursor:pointer; }
.modal-cancel:hover { background:rgba(255,255,255,0.05); }
.modal-confirm-green { background:rgba(74,222,128,0.12); border:1px solid rgba(74,222,128,0.35); color:#4ade80; border-radius:7px; padding:0.45rem 1rem; font-size:0.82rem; font-weight:600; cursor:pointer; }
.modal-confirm-green:hover { background:rgba(74,222,128,0.2); }
.modal-confirm-red { background:rgba(248,113,113,0.12); border:1px solid rgba(248,113,113,0.35); color:#f87171; border-radius:7px; padding:0.45rem 1rem; font-size:0.82rem; font-weight:600; cursor:pointer; }
.modal-confirm-red:hover { background:rgba(248,113,113,0.2); }
.network-card { display:flex; align-items:center; justify-content:space-between; padding:0.65rem 0.9rem; border:1px solid rgba(255,255,255,0.08); border-radius:8px; cursor:pointer; font-size:0.82rem; color:rgba(255,255,255,0.6); transition:border-color 0.15s,background 0.15s; }
.network-card:hover { border-color:rgba(255,255,255,0.18); background:rgba(255,255,255,0.03); }
.network-card.selected { border-color:rgba(168,241,247,0.5); background:rgba(168,241,247,0.06); color:#fafafa; }
.network-card.selected::after { content:"✓"; color:#A8F1F7; font-weight:700; font-size:0.85rem; }
.info-btn { background:none; border:none; color:#A8F1F7; cursor:pointer; padding:0 0.35rem; vertical-align:middle; transition:opacity 0.15s; line-height:1; }
.info-btn:hover { opacity:0.7; }
.info-btn svg { display:inline-block; vertical-align:middle; }
.info-popover { display:none; position:fixed; z-index:90; background:#111113; border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:1rem 1.1rem; max-width:320px; font-size:0.78rem; color:rgba(255,255,255,0.65); line-height:1.6; box-shadow:0 8px 32px rgba(0,0,0,0.5); }
.info-popover.open { display:block; }
.info-popover strong { color:#fafafa; }
.info-popover .sched { color:#A8F1F7; font-size:0.72rem; margin-top:0.5rem; }
.pos-long { background: rgba(74,222,128,0.1); color: #4ade80; border: 1px solid rgba(74,222,128,0.25); padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; }
.pos-short { background: rgba(248,113,113,0.1); color: #f87171; border: 1px solid rgba(248,113,113,0.25); padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; }
input, select { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e4e4e7; padding: 0.4rem 0.6rem; font-size: 0.8rem; outline: none; }
input:focus, select:focus { border-color: rgba(168,241,247,0.4); }
.acc-item { border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; margin-bottom: 0.75rem; overflow: hidden; }
.acc-header { padding: 0.9rem 1.1rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; background: rgba(255,255,255,0.03); user-select: none; }
.acc-header:hover { background: rgba(255,255,255,0.06); }
.acc-item.open { border-color: rgba(168,241,247,0.2); }
.acc-item.open .acc-header { background: rgba(168,241,247,0.04); }
.acc-chevron { color: rgba(255,255,255,0.3); transition: transform 0.2s; flex-shrink: 0; }
.acc-item.open .acc-chevron { transform: rotate(180deg); }
.acc-body { border-top: 1px solid rgba(255,255,255,0.08); display: none; }
.acc-item.open .acc-body { display: block; }
.notif-feed { display: flex; flex-direction: column; gap: 0.5rem; }
.notif { display: flex; align-items: center; gap: 0.85rem; padding: 0.75rem 1rem; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; }
.notif-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.notif-dot.long  { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.5); }
.notif-dot.flat  { background: rgba(255,255,255,0.25); }
.notif-dot.short { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.5); }
.notif-body { flex: 1; min-width: 0; }
.notif-top { display: flex; align-items: baseline; gap: 0.5rem; }
.notif-name { font-size: 0.82rem; font-weight: 600; color: #fafafa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.notif-sig { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.05em; padding: 0.1rem 0.45rem; border-radius: 4px; }
.notif-sig.long  { background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid rgba(74,222,128,0.25); }
.notif-sig.flat  { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.1); }
.notif-sig.short { background: rgba(248,113,113,0.12); color: #f87171; border: 1px solid rgba(248,113,113,0.25); }
.notif-meta { font-size: 0.72rem; color: rgba(255,255,255,0.35); margin-top: 0.2rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.notif-price { font-size: 0.82rem; color: rgba(255,255,255,0.5); flex-shrink: 0; text-align: right; }
.notif-time { font-size: 0.68rem; color: rgba(255,255,255,0.25); }
`;

function shell(title, body, active = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — AgentSignal Trader</title>
  <link rel="icon" href="${getSignalUrl()}/icon.png" type="image/png" />
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div class="logo">
      <img src="/public/logo.png" alt="AgentSignal" style="width:28px;height:28px;border-radius:6px" />
      AgentSignal Trader
    </div>
    <div class="nav-links">
      <a class="nav-link ${active === "portfolio" ? "active" : ""}" href="/portfolio">Portfolio</a>
      <a class="nav-link ${active === "positions" ? "active" : ""}" href="/positions">Positions</a>
      <a class="nav-link ${active === "strategies" ? "active" : ""}" href="/strategies">Strategies</a>
      <a class="nav-link ${active === "signals" ? "active" : ""}" href="/signals">Signals</a>
      <a class="nav-link ${active === "history" ? "active" : ""}" href="/history">History</a>
      ${process.env.AGENT_API_KEY ? `<a class="nav-link ${active === "premium-fade" ? "active" : ""}" href="/premium-fade">Premium Fade</a>` : ""}
      <a class="nav-link ${active === "uniswap" ? "active" : ""}" href="/uniswap">Uniswap</a>
      <a class="nav-link ${active === "settings" ? "active" : ""}" href="/settings">Settings</a>
      <a class="nav-link" href="${getSignalUrl()}/navigator" target="_blank">Navigator ↗</a>
      <span id="traderStatus" style="font-size:0.75rem;padding:0.25rem 0.75rem;border-radius:999px;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.4);margin-left:0.5rem">checking…</span>
      <button id="traderStartBtn" onclick="startTrader()" style="display:none;font-size:0.75rem;padding:0.25rem 0.75rem;border-radius:6px;border:1px solid rgba(168,241,247,0.3);background:rgba(168,241,247,0.08);color:#A8F1F7;cursor:pointer">▶ Start Trader</button>
    </div>
  </header>
  <script>
  async function checkTraderStatus() {
    try {
      const r = await fetch('/api/pm2-status');
      const d = await r.json();
      const pill = document.getElementById('traderStatus');
      const btn = document.getElementById('traderStartBtn');
      if (d.running) {
        pill.textContent = '● Running';
        pill.style.color = '#4ade80';
        pill.style.borderColor = 'rgba(74,222,128,0.3)';
        btn.style.display = 'none';
      } else if (d.scheduled) {
        pill.textContent = '● Scheduled';
        pill.style.color = '#A8F1F7';
        pill.style.borderColor = 'rgba(168,241,247,0.3)';
        btn.style.display = 'none';
      } else {
        pill.textContent = '○ Not started';
        pill.style.color = 'rgba(255,255,255,0.4)';
        pill.style.borderColor = 'rgba(255,255,255,0.1)';
        btn.style.display = 'inline-block';
      }
    } catch { }
  }
  async function startTrader() {
    const btn = document.getElementById('traderStartBtn');
    btn.textContent = 'Starting…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/pm2-start', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        btn.textContent = '✓ Started';
        btn.style.color = '#4ade80';
        setTimeout(() => { btn.textContent = '▶ Start Trader'; btn.style.color = '#A8F1F7'; checkTraderStatus(); }, 3000);
      } else {
        btn.textContent = '✗ Failed';
        setTimeout(() => { btn.textContent = '▶ Start Trader'; }, 3000);
      }
    } catch {
      btn.textContent = '✗ Error';
      setTimeout(() => { btn.textContent = '▶ Start Trader'; }, 3000);
    }
    finally { btn.disabled = false; }
  }
  checkTraderStatus();
  setInterval(checkTraderStatus, 30000);
  </script>
  <div class="container">${body}</div>

  <!-- Activate/Deactivate modal -->
  <div class="modal-overlay" id="toggleModal">
    <div class="modal">
      <div class="modal-title" id="modalTitle"></div>
      <div class="modal-body" id="modalBody"></div>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeModal()">Cancel</button>
        <button id="modalConfirm" class="modal-confirm-green">Confirm</button>
      </div>
    </div>
  </div>

  <!-- Run strategy modal -->
  <div class="modal-overlay" id="runModal">
    <div class="modal">
      <div class="modal-title" id="runModalTitle"></div>
      <div class="modal-body" id="runModalBody"></div>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="document.getElementById('runModal').classList.remove('open')">Cancel</button>
        <button id="runModalConfirm" class="modal-confirm-green">▶ Run Now</button>
      </div>
    </div>
  </div>

  <!-- Open position modal -->
  <div class="modal-overlay" id="openModal">
    <div class="modal">
      <div class="modal-title" id="openModalTitle"></div>
      <div class="modal-body" id="openModalBody"></div>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="document.getElementById('openModal').classList.remove('open')">Cancel</button>
        <button id="openModalConfirm" class="modal-confirm-green">Place Order</button>
      </div>
    </div>
  </div>

  <!-- Edit strategy modal -->
  <div class="modal-overlay" id="editModal">
    <div class="modal" style="max-width:500px;max-height:90vh;overflow-y:auto">
      <div class="modal-title" id="editModalTitle">Edit Strategy</div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:0.75rem;margin-top:1rem">
        <input type="hidden" id="em_id" />
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.65rem">
          <div style="grid-column:1/-1">
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Name</label>
            <input id="em_name" style="width:100%" />
          </div>
          <div style="grid-column:1/-1">
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Symbol</label>
            <input id="em_symbol" style="width:100%" />
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Margin (USD)</label>
            <input id="em_position_size_usd" type="number" placeholder="default" style="width:100%" />
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Leverage</label>
            <select id="em_leverage" style="width:100%">
              <option value="1">1x</option><option value="2">2x</option><option value="3">3x</option>
              <option value="5">5x</option><option value="10">10x</option><option value="20">20x</option><option value="50">50x</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Exchange</label>
            <select id="em_exchange" style="width:100%">
              <option value="hyperliquid">Hyperliquid</option>
              <option value="kraken">Kraken</option>
              <option value="alpaca">Alpaca</option>
              <option value="coinbase">Coinbase</option>
              <option value="schwab">Schwab</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Check Every</label>
            <select id="em_interval_minutes" style="width:100%">
              <option value="5">5 min</option><option value="15">15 min</option><option value="30">30 min</option>
              <option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="1440">Daily</option>
            </select>
            <div id="em_candle_hint" style="font-size:0.67rem;color:rgba(255,255,255,0.3);margin-top:0.25rem;display:none"></div>
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Take Profit %</label>
            <input id="em_tp_pct" type="number" step="0.5" placeholder="optional" style="width:100%" />
            <div style="font-size:0.67rem;color:rgba(255,255,255,0.25);margin-top:0.2rem">Asset price move, not P&L. 5% @ 5x = 25% profit.</div>
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Trail Stop %</label>
            <input id="em_trail_pct" type="number" step="0.1" placeholder="optional" style="width:100%" />
            <div style="font-size:0.67rem;color:rgba(255,255,255,0.25);margin-top:0.2rem">% drop from peak before closing.</div>
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Stop Loss %</label>
            <input id="em_sl_pct" type="number" step="0.5" placeholder="optional" style="width:100%" />
            <div style="font-size:0.67rem;color:rgba(255,255,255,0.25);margin-top:0.2rem">% drop from entry before closing.</div>
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Max Size (USD)</label>
            <input id="em_max_size_usd" type="number" placeholder="optional" style="width:100%" />
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Cooldown (min)</label>
            <input id="em_cooldown_minutes" type="number" placeholder="optional" style="width:100%" />
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="document.getElementById('editModal').classList.remove('open')">Cancel</button>
        <button id="editModalSave" class="modal-confirm-green">Save</button>
      </div>
    </div>
  </div>

  <!-- Network picker modal -->
  <div class="modal-overlay" id="networkModal" onclick="if(event.target===this)document.getElementById('networkModal').classList.remove('open')">
    <div class="modal" style="max-width:380px">
      <div class="modal-title">Payment Network</div>
      <div class="modal-body">
        Select the chain your wallet holds USDC on.
        <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:1rem">
          ${Object.entries(X402_NETWORKS).map(([id, n]) =>
            `<div class="network-card" data-network-id="${id}" onclick="selectNetwork('${id}')">${n.label}</div>`
          ).join("")}
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="document.getElementById('networkModal').classList.remove('open')">Cancel</button>
        <button class="modal-confirm-green" onclick="confirmNetwork()">Confirm</button>
      </div>
    </div>
  </div>

  <!-- Strategy info popover -->
  <div class="info-popover" id="infoPopover"></div>

  <script>
    const SCHEDULES = ${JSON.stringify(SCHEDULES)};
    const CRYPTO_TICKERS = new Set(["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","MATIC","POL","LINK","UNI","ATOM","LTC","DOGE","SHIB","TRX","TON","SUI","APT","OP","ARB","INJ","SEI","TIA","JUP","WIF","BONK","PEPE","NEAR","FIL","ICP","HBAR","VET","ALGO","XLM","XMR","ETC","BCH","AAVE","CRV","MKR","SNX","LDO","RETH","STETH","WBTC","VVV","VULT","ZEC"]);
    function isCrypto(symbol) { return CRYPTO_TICKERS.has(symbol.toUpperCase().replace(/-USD$/, "").replace(/\\/USD$/, "")); }

    function closeModal() {
      document.getElementById('toggleModal').classList.remove('open');
    }

    // Network picker
    const NETWORK_LABELS = ${JSON.stringify(Object.fromEntries(Object.entries(X402_NETWORKS).map(([id, n]) => [id, n.label])))};
    let _pendingNetwork = document.getElementById('x402NetworkInput')?.value || 'eip155:8453';
    function selectNetwork(id) {
      _pendingNetwork = id;
      document.querySelectorAll('.network-card').forEach(c => c.classList.toggle('selected', c.dataset.networkId === id));
    }
    function confirmNetwork() {
      document.getElementById('x402NetworkInput').value = _pendingNetwork;
      document.getElementById('x402NetworkDisplay').textContent = NETWORK_LABELS[_pendingNetwork] || _pendingNetwork;
      document.getElementById('networkModal').classList.remove('open');
    }
    // Mark current selection when modal opens
    document.getElementById('networkModal').addEventListener('click', function() {
      const current = document.getElementById('x402NetworkInput')?.value;
      if (current) document.querySelectorAll('.network-card').forEach(c => c.classList.toggle('selected', c.dataset.networkId === current));
    }, true);
    document.getElementById('toggleModal').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });

    let _pendingToggle = null;

    function subPrice(intervalMinutes, period) {
      const days = { day: 1, week: 7, month: 30, year: 365 }[period];
      const calls = Math.round((60 / intervalMinutes) * 24 * days);
      return (Math.round(calls * 0.01 * 100) / 100).toFixed(2);
    }

    function showToggleModal(btn, id, active, symbol, intervalMinutes) {
      const iv = intervalMinutes || 60;
      const sched = isCrypto(symbol) ? SCHEDULES.crypto : SCHEDULES.stocks;
      const title = active ? 'Activate Strategy' : 'Deactivate Strategy';
      const confirmClass = active ? 'modal-confirm-green' : 'modal-confirm-red';
      const confirmLabel = active ? 'Activate' : 'Deactivate';
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalBody').innerHTML = active ? \`
        <p>The trader will automatically execute trades on Hyperliquid when the signal flips.</p>
        <div class="flow">
          <div class="flow-step"><span class="num">1</span><span>No order is placed now — activation just enables auto-trading.</span></div>
          <div class="flow-step"><span class="num">2</span><span>At the scheduled time, the trader fetches the latest signal.</span></div>
          <div class="flow-step"><span class="num">3</span><span>If the signal has flipped (e.g. FLAT → LONG), it places a market order.</span></div>
          <div class="flow-step"><span class="num">4</span><span>If the signal hasn't changed, it holds — no order is placed.</span></div>
        </div>
        <div class="modal-schedule">⏱ Runs: \${sched.label}<br><span style="opacity:0.6;font-size:0.7rem">\${sched.detail}</span></div>
        <div style="margin-top:1rem;padding:0.85rem;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px">
          <div style="font-size:0.78rem;font-weight:600;color:#fafafa;margin-bottom:0.6rem">Signal subscription</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.35rem">
            \${['day','week','month','year'].map((p, i) => \`
              <label style="display:flex;align-items:center;gap:0.4rem;padding:0.4rem 0.5rem;border:1px solid rgba(255,255,255,0.08);border-radius:6px;cursor:pointer;font-size:0.75rem;color:rgba(255,255,255,0.7)">
                <input type="radio" name="subPeriod" value="\${p}" \${i === 2 ? 'checked' : ''} style="accent-color:#A8F1F7">
                1 \${p.charAt(0).toUpperCase()+p.slice(1)} — <strong style="color:#A8F1F7">$\${subPrice(iv, p)}</strong>
              </label>\`).join('')}
          </div>
        </div>
      \` : \`
        <p>The trader will <strong>stop executing trades</strong> for this strategy. Any open positions on Hyperliquid will remain open until you close them manually.</p>
      \`;
      const confirmBtn = document.getElementById('modalConfirm');
      confirmBtn.className = confirmClass;
      confirmBtn.textContent = active ? 'Subscribe & Activate' : 'Deactivate';
      _pendingToggle = { btn, id, active, intervalMinutes: iv };

      document.getElementById('toggleModal').classList.add('open');
    }

    document.getElementById('modalConfirm').addEventListener('click', async () => {
      if (!_pendingToggle) return;
      const { btn, id, active, intervalMinutes } = _pendingToggle;
      const selectedPeriod = active
        ? (document.querySelector('input[name="subPeriod"]:checked')?.value ?? 'month')
        : '';
      closeModal();
      btn.disabled = true;
      btn.textContent = active ? 'Subscribing...' : 'Saving...';

      if (active) {
        const subRes = await fetch('/api/subscribe-strategy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy_id: id, interval_minutes: intervalMinutes, period: selectedPeriod }),
        });
        const subData = await subRes.json();
        if (!subData.ok) {
          btn.disabled = false; btn.textContent = 'Activate';
          alert('Subscription failed: ' + (subData.error ?? 'Unknown error'));
          return;
        }
        console.log('[subscribe] ✅ Subscribed until', subData.expires_at);
        // Save period to strategy for auto-renew
        await fetch('/api/set-subscription-period', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy_id: id, period: selectedPeriod }),
        });
      }

      const res = await fetch('/api/toggle', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id, active}) });
      const d = await res.json();
      if (d.ok) setTimeout(() => location.reload(), 300);
      else { btn.disabled = false; btn.textContent = active ? 'Activate' : 'Deactivate'; alert(d.error); }
    });

    function renderCond(c) {
      const FIELD_LABELS = { pct_above_entry: '% Above Entry', pct_below_entry: '% Below Entry' };
      const OP_LABELS    = { gte: '≥', lte: '≤', gt: '>', lt: '<' };
      const field = c.field || '';
      const label = FIELD_LABELS[field] || field;
      const op    = OP_LABELS[c.op] || c.op || '';
      const isPctField = field === 'pct_above_entry' || field === 'pct_below_entry';
      const valStr = c.value !== undefined ? c.value + (isPctField ? '%' : '') : '';
      const sourceTag = (c.source && !isPctField) ? '<span style="color:#A8F1F7">' + c.source + '</span> ' : '';
      const periodTag = (c.period && !isPctField) ? '<span style="color:rgba(255,255,255,0.3)">('+c.period+')</span> ' : '';
      return sourceTag + label + ' ' + periodTag + op + ' ' + valStr;
    }
    function renderRules(rs) {
      if (!rs || !Array.isArray(rs.conditions) || !rs.conditions.length) return '<span style="color:rgba(255,255,255,0.3)">—</span>';
      return rs.conditions.map(renderCond).join(' <span style="opacity:0.4">' + rs.operator + '</span> ');
    }
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('.strategy-info-btn');
      if (btn) showStrategyInfo(btn);
    });
    async function showStrategyInfo(btn) {
      const s = JSON.parse(btn.dataset.strategy);
      const iv = s.interval_minutes ?? 60;
      const schedLabel = isCrypto(s.symbol)
        ? (iv >= 1440 ? 'every day' : 'every ' + iv + 'min')
        : SCHEDULES.stocks.label;
      const size = s.position_size_usd ? '$' + s.position_size_usd : 'default';
      const AGENT_SIGNAL_URL = '${getSignalUrl()}';
      const pop = document.getElementById('infoPopover');

      // Position and show with loading state
      if (pop.classList.contains('open') && pop._stratId === s.id) { pop.classList.remove('open'); return; }
      pop._stratId = s.id;
      const rect = btn.getBoundingClientRect();
      pop.style.top = (rect.bottom + 8 + window.scrollY) + 'px';
      pop.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';
      pop.innerHTML = '<span style="color:rgba(255,255,255,0.3);font-size:0.75rem">Loading…</span>';
      pop.classList.add('open');

      // Fetch full strategy via local proxy (avoids CORS)
      let longEntry = null, longExit = null, shortEntry = null, shortExit = null;
      try {
        const res = await fetch('/api/strategy-details/' + s.id);
        if (res.ok) {
          const full = await res.json();
          const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
          const hasConditions = r => r?.conditions?.length > 0;
          longEntry  = hasConditions(parse(full.long_entry))  ? parse(full.long_entry)  : (hasConditions(parse(full.entry)) ? parse(full.entry) : null);
          longExit   = hasConditions(parse(full.long_exit))   ? parse(full.long_exit)   : (hasConditions(parse(full.exit))  ? parse(full.exit)  : null);
          shortEntry = hasConditions(parse(full.short_entry)) ? parse(full.short_entry) : null;
          shortExit  = hasConditions(parse(full.short_exit))  ? parse(full.short_exit)  : null;
        }
      } catch {}

      const hasShort = shortEntry || shortExit;
      const sectionLabel = (label, color) => '<span style="color:' + color + ';font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em">' + label + '</span>';
      pop.innerHTML = '<strong>' + s.name + '</strong>'
        + '<div style="margin:0.4rem 0 0;font-family:monospace;font-size:0.7rem;color:rgba(255,255,255,0.35);word-break:break-all">' + s.id + '</div>'
        + '<div style="margin-top:0.75rem;display:flex;flex-direction:column;gap:0.5rem">'
        + '<div><span style="color:rgba(255,255,255,0.4);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em">Symbol</span><br>' + s.symbol + ' · ' + s.leverage + 'x · ' + size + '</div>'
        + (longEntry  ? '<div>' + sectionLabel(hasShort ? 'Long Entry' : 'Entry', 'rgba(255,255,255,0.4)') + '<br><span style="font-size:0.75rem">' + renderRules(longEntry)  + '</span></div>' : '')
        + (longExit   ? '<div>' + sectionLabel(hasShort ? 'Long Exit'  : 'Exit',  'rgba(255,255,255,0.4)') + '<br><span style="font-size:0.75rem">' + renderRules(longExit)   + '</span></div>' : '')
        + (shortEntry ? '<div>' + sectionLabel('Short Entry', 'rgba(248,113,113,0.7)') + '<br><span style="font-size:0.75rem">' + renderRules(shortEntry) + '</span></div>' : '')
        + (shortExit  ? '<div>' + sectionLabel('Short Exit',  'rgba(248,113,113,0.7)') + '<br><span style="font-size:0.75rem">' + renderRules(shortExit)  + '</span></div>' : '')
        + '</div>'
        + '<div class="sched">⏱ ' + schedLabel + '</div>';
    }
    document.addEventListener('click', function(e) {
      const pop = document.getElementById('infoPopover');
      if (pop.classList.contains('open') && !pop.contains(e.target) && !e.target.closest('.info-btn')) {
        pop.classList.remove('open');
      }
    });

    async function copyId(id, btn) {
      await navigator.clipboard.writeText(id);
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.style.color = '#4ade80';
      btn.style.borderColor = 'rgba(74,222,128,0.3)';
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.style.borderColor = ''; }, 1500);
    }
  </script>
    <div class="modal-overlay" id="editOrderModal" onclick="if(event.target===this)document.getElementById('editOrderModal').style.display='none'">
      <div class="modal" style="max-width:360px">
        <div class="modal-title" id="editOrderTitle">Edit Order</div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:1rem;margin-top:1rem">
          <input type="hidden" id="editOrderExchange">
          <input type="hidden" id="editOrderOrderId">
          <input type="hidden" id="editOrderAsset">
          <input type="hidden" id="editOrderSide">
          <input type="hidden" id="editOrderDuration">
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Size</label>
            <input id="editOrderSize" type="number" step="any" style="width:100%" />
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Limit Price</label>
            <input id="editOrderPrice" type="number" step="any" style="width:100%" />
          </div>
          <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
            <button id="editOrderSubmitBtn" onclick="submitEditOrder()" style="flex:1;padding:0.6rem;border-radius:8px;background:#A8F1F7;color:#000;font-size:0.8rem;font-weight:600;border:none;cursor:pointer">Update Order</button>
            <button onclick="document.getElementById('editOrderModal').style.display='none'" style="flex:1;padding:0.6rem;border-radius:8px;background:rgba(255,255,255,0.05);color:#fff;font-size:0.8rem;border:1px solid rgba(255,255,255,0.1);cursor:pointer">Cancel</button>
          </div>
        </div>
      </div>
    </div>
</body>
</html>`;
}

// ── Env helpers ───────────────────────────────────────────────────────────────

const ENV_PATH = resolve(__dirname, ".env");

function readEnv() {
  try { return readFileSync(ENV_PATH, "utf8"); } catch { return ""; }
}

function getEnvValue(key) {
  const m = readEnv().match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

function writeEnvValues(updates) {
  let src = readEnv();
  for (const [key, val] of Object.entries(updates)) {
    if (!val && val !== "false") continue; // skip blanks (don't clear existing)
    const line = `${key}=${val}`;
    if (new RegExp(`^${key}=`, "m").test(src)) {
      src = src.replace(new RegExp(`^${key}=.*$`, "m"), line);
    } else {
      src = src.trimEnd() + "\n" + line + "\n";
    }
  }
  writeFileSync(ENV_PATH, src, "utf8");
  // Reload into process.env immediately
  for (const [key, val] of Object.entries(updates)) {
    if (val) process.env[key] = val;
  }
}

// ── Equity curve (server-side SVG) ────────────────────────────────────────────

function renderEquityCurve(snapshots, positionValue, spotUsdc = 0) {
  const fmt2 = v => v > 0 ? `$${v.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}` : "—";
  const statBlock = (label, val) => `
    <div>
      <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.4);margin-bottom:0.25rem">${label}</div>
      <div style="font-size:1rem;font-weight:600;color:rgba(255,255,255,0.55);letter-spacing:-0.02em;line-height:1">${val}</div>
    </div>`;
  const divider = `<div style="width:1px;background:rgba(255,255,255,0.08);align-self:stretch;margin-top:2px"></div>`;
  const header = `<div style="display:flex;gap:2rem;align-items:flex-start">
    ${statBlock("Position Value", fmt2(positionValue))}
    ${divider}
    ${statBlock("Spot USDC", fmt2(spotUsdc))}
  </div>`;

  if (snapshots.length < 2) {
    return `<div class="card" style="margin-bottom:1.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between">
        ${header}
        <span style="font-size:0.7rem;color:rgba(255,255,255,0.25)">chart builds after day 2</span>
      </div>
    </div>`;
  }
  const points = snapshots.map(s => s.net_liq);
  const dates  = snapshots.map(s => s.date);
  const minY = Math.min(...points);
  const maxY = Math.max(...points);
  const rangeY = maxY - minY || 1;
  const W = 1000, H = 130;
  const pL = 62, pR = 10, pT = 10, pB = 22;
  const cW = W - pL - pR, cH = H - pT - pB;

  const sx = i => (pL + (i / (points.length - 1)) * cW).toFixed(1);
  const sy = v => (pT + cH - ((v - minY) / rangeY) * cH).toFixed(1);

  const coords = points.map((v, i) => `${sx(i)},${sy(v)}`);
  const lineD = "M" + coords.join(" L");
  const fillD = lineD + ` L${sx(points.length - 1)},${pT + cH} L${pL},${pT + cH} Z`;

  const last = points[points.length - 1];
  const first = points[0];
  const isUp = last >= first;
  const color = isUp ? "#4ade80" : "#f87171";
  const fill  = isUp ? "rgba(74,222,128,0.07)" : "rgba(248,113,113,0.07)";
  const pct   = ((last - first) / first * 100);
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";

  const fmt = v => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const mid = Math.floor((dates.length - 1) / 2);
  const dateFmt = d => d.slice(5); // MM-DD

  return `<div class="card" style="margin-bottom:1.5rem">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
      ${header}
      <span style="font-size:0.75rem;color:${color};font-weight:600">${pctStr} <span style="color:rgba(255,255,255,0.3);font-weight:400">· ${snapshots.length}d</span></span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto">
      <line x1="${pL}" y1="${pT}"        x2="${W-pR}" y2="${pT}"        stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <line x1="${pL}" y1="${pT+cH/2}"   x2="${W-pR}" y2="${pT+cH/2}"  stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <line x1="${pL}" y1="${pT+cH}"     x2="${W-pR}" y2="${pT+cH}"    stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <text x="${pL-5}" y="${pT+4}"      text-anchor="end" font-size="12" fill="rgba(255,255,255,0.3)">${fmt(maxY)}</text>
      <text x="${pL-5}" y="${pT+cH/2+4}" text-anchor="end" font-size="12" fill="rgba(255,255,255,0.3)">${fmt((maxY+minY)/2)}</text>
      <text x="${pL-5}" y="${pT+cH+4}"  text-anchor="end" font-size="12" fill="rgba(255,255,255,0.3)">${fmt(minY)}</text>
      <path d="${fillD}" fill="${fill}"/>
      <path d="${lineD}" fill="none" stroke="${color}" stroke-width="1.5"/>
      <circle cx="${sx(points.length-1)}" cy="${sy(last)}" r="3" fill="${color}"/>
      <text x="${sx(0)}"   y="${H-4}" text-anchor="start"  font-size="11" fill="rgba(255,255,255,0.3)">${dateFmt(dates[0])}</text>
      <text x="${sx(mid)}" y="${H-4}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.3)">${dateFmt(dates[mid])}</text>
      <text x="${sx(dates.length-1)}" y="${H-4}" text-anchor="end" font-size="11" fill="rgba(255,255,255,0.3)">${dateFmt(dates[dates.length-1])}</text>
    </svg>
  </div>`;
}

// ── Pages ─────────────────────────────────────────────────────────────────────

async function portfolioPage() {
  let hlData = null, spotData = null, coinbaseAccounts = [], coinbaseUsdValues = {}, krakenBalances = {}, krakenUsdValues = {}, openOrders = [];

  try {
    const wallet = PRIVATE_KEY
      ? (await import("viem/accounts")).privateKeyToAccount(PRIVATE_KEY)
      : null;
    if (wallet) {
      [hlData, spotData] = await Promise.all([
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: wallet.address }),
        }).then(r => r.json()).catch(() => null),
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "spotClearinghouseState", user: wallet.address }),
        }).then(r => r.json()).catch(() => null),
      ]);
      // HL open orders
      try {
        const { getOpenOrders: hlGetOO } = await import("./hyperliquid.mjs");
        const hlOrders = await hlGetOO(wallet.address);
        openOrders.push(...hlOrders.map(o => ({ ...o, exchange: "Hyperliquid" })));
      } catch (e) { console.error("[dashboard] HL open orders:", e.message); }
    }
  } catch {}

  // Fetch Kraken balances + USD values
  if (process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET) {
    try {
      const { KrakenExchange } = await import("./exchanges/kraken.mjs");
      const kr = new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET);
      const raw = await kr._balance();
      krakenBalances = Object.fromEntries(
        Object.entries(raw ?? {}).filter(([, v]) => parseFloat(v) > 0.00001)
      );
      const krakenKeyToDisplay = key =>
        key === "XXBT" ? "BTC" : key === "XETH" ? "ETH" : key === "ZUSD" ? "USD" : key.replace(/^[XZ]/, "");
      await Promise.all(Object.entries(krakenBalances).map(async ([key, val]) => {
        const display = krakenKeyToDisplay(key);
        const amount = parseFloat(val);
        if (display === "USD" || display === "USDC" || display === "USDT") {
          krakenUsdValues[key] = amount;
        } else {
          try {
            krakenUsdValues[key] = amount * await kr.getMidPrice(display);
          } catch { krakenUsdValues[key] = null; }
        }
      }));
      // Kraken open orders
      try {
        const krOrders = await kr.getOpenOrders();
        openOrders.push(...krOrders.map(o => ({ ...o, exchange: "Kraken" })));
      } catch (e) { console.error("[dashboard] Kraken open orders:", e.message); }
    } catch (e) {
      console.error("[dashboard] Kraken balance fetch error:", e.message);
    }
  }

  // Fetch Coinbase accounts + USD values
  if (process.env.COINBASE_API_KEY && process.env.COINBASE_API_SECRET) {
    try {
      const { CoinbaseExchange } = await import("./exchanges/coinbase.mjs");
      const cb = new CoinbaseExchange(process.env.COINBASE_API_KEY, process.env.COINBASE_API_SECRET, process.env.COINBASE_API_PASSPHRASE);
      const data = await cb._request("GET", "/api/v3/brokerage/accounts");
      coinbaseAccounts = (data?.accounts ?? []).filter(a => parseFloat(a.available_balance?.value ?? "0") > 0.00001);
      await Promise.all(coinbaseAccounts.map(async a => {
        const avail = parseFloat(a.available_balance?.value ?? "0");
        if (a.currency === "USD" || a.currency === "USDC" || a.currency === "USDT") {
          coinbaseUsdValues[a.currency] = (coinbaseUsdValues[a.currency] ?? 0) + avail;
        } else {
          try {
            coinbaseUsdValues[a.uuid] = avail * await cb.getMidPrice(a.currency);
          } catch { coinbaseUsdValues[a.uuid] = null; }
        }
      }));
      // Coinbase open orders
      try {
        const cbOrders = await cb.getOpenOrders();
        openOrders.push(...cbOrders.map(o => ({ ...o, exchange: "Coinbase" })));
      } catch (e) { console.error("[dashboard] Coinbase open orders:", e.message); }
    } catch (e) {
      console.error("[dashboard] Coinbase accounts fetch error:", e.message);
    }
  }

  // Fetch Alpaca open orders
  if (process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET) {
    try {
      const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
      const alp = new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true");
      const alpOrders = await alp.getOpenOrders();
      openOrders.push(...alpOrders.map(o => ({ ...o, exchange: "Alpaca" })));
    } catch (e) { console.error("[dashboard] Alpaca open orders:", e.message); }
  }

  const accountValue = parseFloat(hlData?.marginSummary?.accountValue ?? "0");
  const withdrawable = parseFloat(hlData?.withdrawable ?? "0");
  const usdcSpot = parseFloat(spotData?.balances?.find(b => b.coin === "USDC")?.total ?? "0");

  const fetchesToday = countFetchesToday();
  const fetchesTotal = countFetchesTotal();
  const wallet = PRIVATE_KEY
    ? (await import("viem/accounts")).privateKeyToAccount(PRIVATE_KEY)
    : null;
  const networkUsdc = wallet ? await getNetworkUsdcBalance(wallet.address) : null;
  const payNetwork = getPaymentNetwork();
  const payNetworkLabel = X402_NETWORKS[payNetwork]?.label ?? payNetwork;

  // ── Schwab account data ─────────────────────────────────────────────────────
  const schwab = getSchwabClient();
  let schwabAccounts = [], schwabTotalUsd = 0;
  if (schwab?.isAuthorized()) {
    try {
      const raw = await schwab.getAccounts(true);
      schwabAccounts = Array.isArray(raw) ? raw : [];
      schwabTotalUsd = schwabAccounts.reduce((s, a) => {
        const eq = parseFloat(a.securitiesAccount?.currentBalances?.liquidationValue ?? a.securitiesAccount?.currentBalances?.totalCash ?? 0);
        return s + eq;
      }, 0);
    } catch {}
    // Schwab open orders
    try {
      const nums = await schwab.getAccountNumbers();
      const hash = process.env.SCHWAB_ACCOUNT_HASH || nums?.[0]?.hashValue;
      if (hash) {
        const SCHWAB_TERMINAL = new Set(["REJECTED","CANCELED","FILLED","EXPIRED","REPLACED"]);
        const schwabOrders = (await schwab.getOrders(hash) ?? [])
          .filter(o => !SCHWAB_TERMINAL.has(o.status));
        openOrders.push(...schwabOrders.map(o => {
          const leg   = o.orderLegCollection?.[0] ?? {};
          const instr = (leg.instruction ?? "").toUpperCase();
          const side  = (instr === "BUY" || instr === "BUY_TO_OPEN") ? "buy" : "sell";
          return {
            exchange:   "Schwab",
            id:         String(o.orderId),
            asset:      leg.instrument?.symbol ?? "—",
            side,
            size:       parseFloat(leg.quantity ?? "0"),
            limitPrice: parseFloat(o.price ?? "0"),
            duration:   o.duration ?? "GOOD_TILL_CANCEL",
          };
        }));
      }
    } catch (e) { console.error("[dashboard] Schwab open orders:", e.message); }
  }

  // ── Uniswap positions ───────────────────────────────────────────────────────
  const uniData = wallet ? (await getV3Positions(wallet.address).catch(() => ({ positions: [] }))) : { positions: [] };
  const uniOpen = uniData.positions.filter(p => p.hasLiquidity);
  const uniswapLiqUsd  = uniOpen.reduce((s, p) => s + (p.totalLiquidityUsd ?? 0), 0);
  const uniswapFeesUsd = uniOpen.reduce((s, p) => s + (p.totalFeesUsd ?? 0), 0);

  // ── Summary calculations ────────────────────────────────────────────────────
  const cbTotalUsd = Object.values(coinbaseUsdValues).reduce((s, v) => s + (v ?? 0), 0);
  const krTotalUsd = Object.values(krakenUsdValues).reduce((s, v) => s + (v ?? 0), 0);
  const totalValue = accountValue + usdcSpot + cbTotalUsd + krTotalUsd + uniswapLiqUsd + schwabTotalUsd;

  // Liquid USDC/USD across all exchanges
  const cbUsdcTotal = coinbaseAccounts
    .filter(a => a.currency === "USD" || a.currency === "USDC" || a.currency === "USDT")
    .reduce((s, a) => s + parseFloat(a.available_balance?.value ?? "0"), 0);
  const krUsdcTotal = Object.entries(krakenBalances)
    .filter(([k]) => ["ZUSD","USDC","USDT"].includes(k))
    .reduce((s, [, v]) => s + parseFloat(v), 0);
  const totalUsdc = withdrawable + usdcSpot + cbUsdcTotal + krUsdcTotal;

  // YTD P&L
  const ytdPnl = getYtdPnl();
  const startingValue = totalValue - ytdPnl;
  const ytdPct = startingValue > 0 ? (ytdPnl / startingValue) * 100 : 0;
  const ytdSign = ytdPnl >= 0 ? "+" : "";

  const hlTotalValue = accountValue + usdcSpot;
  if (usdcSpot > 0) {
    if (!hasSnapshots()) backfillSnapshotsFromTrades(usdcSpot);
    const unrealizedPnl = (hlData?.assetPositions ?? [])
      .reduce((s, p) => s + parseFloat(p.position?.unrealizedPnl ?? "0"), 0);
    insertSnapshot({ net_liq: usdcSpot, unrealized_pnl: unrealizedPnl, realized_pnl: ytdPnl, total_value: usdcSpot });
  }

  const hlPositionValue = (hlData?.assetPositions ?? [])
    .filter(p => parseFloat(p.position?.szi ?? "0") !== 0)
    .reduce((s, p) => s + parseFloat(p.position?.positionValue ?? "0"), 0);

  const equityCurveHtml = renderEquityCurve(getSnapshots(90), hlPositionValue, usdcSpot);

  return shell("Portfolio", `
    ${!PRIVATE_KEY ? '<p style="color:#f87171;margin-bottom:1rem">⚠️ AGENT_PRIVATE_KEY not set — run <code>npm run setup</code></p>' : ""}
    <div class="stat-row" style="margin-bottom:2rem">
      <div class="stat">
        <div class="label">Total Value</div>
        <div class="value">$${totalValue.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      <div class="stat">
        <div class="label">USDC Balance</div>
        <div class="value cyan">$${totalUsdc.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      <div class="stat">
        <div class="label">YTD P&amp;L</div>
        <div class="value ${ytdPnl >= 0 ? "green" : "red"}">${ytdSign}$${Math.abs(ytdPnl).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})} <span style="font-size:0.75em;opacity:0.7">(${ytdSign}${ytdPct.toFixed(1)}%)</span></div>
      </div>
      ${uniswapLiqUsd > 0.01 ? `<div class="stat">
        <div class="label">Uniswap LP</div>
        <div class="value" style="color:#a78bfa">$${uniswapLiqUsd.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        ${uniswapFeesUsd > 0.001 ? `<div style="font-size:0.7rem;color:rgba(167,139,250,0.6);margin-top:0.15rem">+$${uniswapFeesUsd.toFixed(2)} fees</div>` : ""}
      </div>` : ""}
      ${schwabTotalUsd > 0.01 ? `<div class="stat">
        <div class="label">Schwab</div>
        <div class="value" style="color:#fbbf24">$${schwabTotalUsd.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>` : ""}
    </div>
    <div style="display:flex;gap:0.25rem;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.2rem;margin-bottom:1.25rem">
      <button id="ptab-hl"     onclick="switchPTab('hl')"     style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:#A8F1F7;color:#000">Hyperliquid</button>
      ${process.env.COINBASE_API_KEY ? `<button id="ptab-cb" onclick="switchPTab('cb')" style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">Coinbase</button>` : ""}
      ${process.env.KRAKEN_API_KEY   ? `<button id="ptab-kr" onclick="switchPTab('kr')" style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">Kraken</button>` : ""}
      ${schwab ? `<button id="ptab-schwab" onclick="switchPTab('schwab')" style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">Schwab</button>` : ""}
      ${uniOpen.length > 0 ? `<button id="ptab-uni" onclick="switchPTab('uni')" style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">Uniswap (${uniOpen.length})</button>` : ""}
      <button id="ptab-orders" onclick="switchPTab('orders')" style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">Orders${openOrders.length > 0 ? ` (${openOrders.length})` : ""}</button>
    </div>

    <div id="ppane-hl">
      ${equityCurveHtml}
      ${accountValue > 0.01 || usdcSpot > 0.001 ? `<div class="card"><table>
        <thead><tr><th>Asset</th><th>Value (USD)</th></tr></thead>
        <tbody>
          ${accountValue > 0.01 ? `<tr><td style="font-weight:600">Perp Account</td><td>$${accountValue.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>` : ""}
          ${usdcSpot > 0.001   ? `<tr><td style="font-weight:600">Spot USDC</td><td>$${usdcSpot.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>` : ""}
        </tbody>
      </table></div>` : `<p class="hint">No Hyperliquid balance.</p>`}
    </div>

    <div id="ppane-cb" style="display:none">
      <div class="card" style="margin-bottom:1.5rem">
        <div style="display:flex;gap:2rem;align-items:flex-start">
          <div><div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.4);margin-bottom:0.25rem">Total Value</div>
          <div style="font-size:1rem;font-weight:600;color:rgba(255,255,255,0.55);line-height:1">$${cbTotalUsd.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
        </div>
      </div>
      ${coinbaseAccounts.length > 0 ? `<div class="card"><table>
        <thead><tr><th>Currency</th><th>Available</th><th>Hold</th><th>Value (USD)</th><th></th></tr></thead>
        <tbody>${coinbaseAccounts.map(a => {
          const avail = parseFloat(a.available_balance?.value ?? "0");
          const hold  = parseFloat(a.hold?.value ?? "0");
          const isUsd = a.currency === "USD" || a.currency === "USDC" || a.currency === "USDT";
          const usdVal = isUsd ? coinbaseUsdValues[a.currency] : coinbaseUsdValues[a.uuid];
          const sellBtn = !isUsd && avail > 0 ? `<button class="btn btn-cyan" onclick="sellForUsdc('coinbase','${a.currency}',${avail},this)">→ USDC</button>` : "";
          return `<tr>
            <td style="font-weight:600">${a.currency}</td>
            <td>${avail.toFixed(3)}</td>
            <td style="color:rgba(255,255,255,0.35)">${hold > 0 ? hold.toFixed(3) : "—"}</td>
            <td>${usdVal != null ? "$" + usdVal.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}) : "—"}</td>
            <td>${sellBtn}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>` : `<p class="hint">No Coinbase balances found.</p>`}
    </div>

    <div id="ppane-kr" style="display:none">
      <div class="card" style="margin-bottom:1.5rem">
        <div style="display:flex;gap:2rem;align-items:flex-start">
          <div><div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.4);margin-bottom:0.25rem">Total Value</div>
          <div style="font-size:1rem;font-weight:600;color:rgba(255,255,255,0.55);line-height:1">$${krTotalUsd.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
        </div>
      </div>
      ${Object.keys(krakenBalances).length > 0 ? `<div class="card"><table>
        <thead><tr><th>Asset</th><th>Balance</th><th>Value (USD)</th><th></th></tr></thead>
        <tbody>${Object.entries(krakenBalances).map(([key, val]) => {
          const display = key === "XXBT" ? "BTC" : key === "XETH" ? "ETH" : key === "ZUSD" ? "USD" : key.replace(/^[XZ]/, "");
          const isUsd = ["ZUSD","USDC","USDT"].includes(key);
          const usdVal = krakenUsdValues[key];
          const amount = parseFloat(val);
          const sellBtn = !isUsd && amount > 0 ? `<button class="btn btn-cyan" onclick="sellForUsdc('kraken','${display}',${amount},this)">→ USDC</button>` : "";
          return `<tr>
            <td style="font-weight:600">${display}</td>
            <td>${amount.toFixed(3)}</td>
            <td>${usdVal != null ? "$" + usdVal.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}) : "—"}</td>
            <td>${sellBtn}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>` : `<p class="hint">No Kraken balances found.</p>`}
    </div>

    <div id="ppane-schwab" style="display:none">
      ${schwab && !schwab.isAuthorized() ? `
        <div class="card" style="text-align:center;padding:2.5rem">
          <p style="color:rgba(255,255,255,0.5);margin-bottom:1rem">Schwab not yet authorized.</p>
          <a href="/settings" style="color:#A8F1F7;font-size:0.82rem">Go to Settings to connect →</a>
        </div>` :
      schwabAccounts.length > 0 ? schwabAccounts.map(a => {
        const sa = a.securitiesAccount;
        const bal = sa?.currentBalances;
        const positions = sa?.positions ?? [];
        const liqValue  = parseFloat(bal?.liquidationValue ?? bal?.totalCash ?? 0);
        const cashBal   = parseFloat(bal?.cashBalance ?? 0);
        const posRows   = positions.map(p => {
          const sym    = p.instrument?.symbol ?? "—";
          const under  = p.instrument?.underlyingSymbol ?? sym;
          const qty    = p.longQuantity || p.shortQuantity || 0;
          const side   = p.shortQuantity > 0 ? "SHORT" : "LONG";
          const mv     = parseFloat(p.marketValue ?? 0);
          const avgPx  = parseFloat(p.averagePrice ?? 0);
          const dayPnl = parseFloat(p.currentDayProfitLoss ?? 0);
          const type   = p.instrument?.assetType ?? "";
          return "<tr>" +
            "<td style='font-weight:600'>" + sym + (type === "OPTION" ? " <span style='font-size:0.65rem;color:rgba(255,255,255,0.4)'>OPT</span>" : "") + "</td>" +
            "<td><span class='" + (side === "LONG" ? "pos-long" : "pos-short") + "'>" + side + "</span></td>" +
            "<td>" + qty + "</td>" +
            "<td>$" + avgPx.toFixed(2) + "</td>" +
            "<td>$" + mv.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}) + "</td>" +
            "<td style='color:" + (dayPnl >= 0 ? "#4ade80" : "#f87171") + "'>" + (dayPnl >= 0 ? "+" : "") + "$" + Math.abs(dayPnl).toFixed(2) + "</td>" +
            "</tr>";
        }).join("") || "<tr><td colspan='6' style='color:rgba(255,255,255,0.25);text-align:center;padding:1rem'>No open positions</td></tr>";
        return "<div class='card'><table>" +
          "<thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg Price</th><th>Mkt Value</th><th>Day P&L</th></tr></thead>" +
          "<tbody>" + posRows + "</tbody></table>" +
          "<div style='display:flex;gap:1.5rem;margin-top:0.75rem;font-size:0.78rem;color:rgba(255,255,255,0.45)'>" +
          "<span>Account: <strong style='color:#fafafa'>" + (sa?.accountNumber ?? "—") + "</strong></span>" +
          "<span>Cash: <strong style='color:#fafafa'>$" + cashBal.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}) + "</strong></span>" +
          "<span>Total: <strong style='color:#fbbf24'>$" + liqValue.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}) + "</strong></span>" +
          "</div></div>";
      }).join("") : `<p class="hint">No Schwab accounts found or credentials not configured.</p>`}
    </div>

    <div id="ppane-uni" style="display:none">
      ${uniOpen.length > 0 ? `<div class="card"><table>
        <thead><tr><th>Pair</th><th>Status</th><th>Liquidity</th><th>Uncollected Fees</th></tr></thead>
        <tbody>${uniOpen.map(p => {
          const inRangeBadge = p.inRange === null ? '<span class="badge-flat">Unknown</span>' :
            p.inRange ? '<span class="badge-active">In Range</span>' : '<span class="badge-inactive">Out of Range</span>';
          const liq = p.totalLiquidityUsd !== null ? "$" + p.totalLiquidityUsd.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}) : "—";
          const fees = p.totalFeesUsd !== null && p.totalFeesUsd > 0.0001
            ? "<span style='color:#A8F1F7'>$" + p.totalFeesUsd.toFixed(3) + "</span>" : "—";
          const ver = p.version === "v4" ? " <span style='font-size:0.65rem;color:#a78bfa;font-weight:700'>V4</span>" : "";
          return "<tr><td style='font-weight:600'>" + p.token0.symbol + "/" + p.token1.symbol + ver + "<div style='font-size:0.68rem;color:rgba(255,255,255,0.35)'>" + p.feeDisplay + " · #" + p.tokenId + "</div></td><td>" + inRangeBadge + "</td><td>" + liq + "</td><td>" + fees + "</td></tr>";
        }).join("")}</tbody>
      </table></div>
      <p style="margin-top:0.75rem"><a href="/uniswap" style="font-size:0.78rem;color:#A8F1F7">View full positions + P&L →</a></p>`
      : `<p class="hint">No open Uniswap V3 positions on Base.</p><p style="margin-top:0.5rem"><a href="/uniswap" style="font-size:0.78rem;color:#A8F1F7">Go to Uniswap →</a></p>`}
    </div>

    <div id="ppane-orders" style="display:none">
      ${openOrders.length > 0 ? `<div class="card"><table>
        <thead><tr><th>Exchange</th><th>Asset</th><th>Side</th><th>Size</th><th>Limit Price</th><th></th></tr></thead>
        <tbody>${openOrders.map(o => `<tr>
          <td style="color:rgba(255,255,255,0.4);font-size:0.78rem">${o.exchange}</td>
          <td style="font-weight:600">${o.asset}</td>
          <td><span class="${o.side === "buy" ? "pos-long" : "pos-short"}">${o.side === "buy" ? "▲ BUY" : "▼ SELL"}</span></td>
          <td>${o.size.toFixed(4)}</td>
          <td>$${o.limitPrice.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</td>
          <td style="text-align:right">
            <button class="btn btn-cyan" style="margin-right:0.4rem;padding:0.2rem 0.6rem;font-size:0.7rem" onclick="showEditOrderModal('${o.exchange}','${o.id}','${o.asset}','${o.side}',${o.size},${o.limitPrice},${JSON.stringify(o.duration||'')})">Edit</button>
            <button class="btn btn-red" style="padding:0.2rem 0.6rem;font-size:0.7rem" onclick="cancelOrder('${o.exchange}','${o.id}','${o.asset}',this)">Cancel</button>
          </td>
        </tr>`).join("")}</tbody>
      </table></div>` : `<p class="hint">No open limit orders.</p>`}
    </div>
    <p class="section-label" style="margin-top:2rem">x402 Signal Spend · <span style="color:rgba(255,255,255,0.35);font-size:0.65rem;text-transform:none;letter-spacing:0">${payNetworkLabel}</span></p>
    <div class="stat-row">
      <div class="stat"><div class="label">Today's Fetches</div><div class="value">${fetchesToday.total.toLocaleString()}</div></div>
      <div class="stat"><div class="label">Today's Spend</div><div class="value cyan">$${fetchesToday.spend.toFixed(3)}</div></div>
      <div class="stat"><div class="label">All-Time Fetches</div><div class="value" style="font-size:0.95rem">${fetchesTotal.total.toLocaleString()}</div></div>
      <div class="stat"><div class="label">All-Time Spend</div><div class="value" style="font-size:0.95rem">$${fetchesTotal.spend.toFixed(2)}</div></div>
      <div class="stat"><div class="label">${payNetworkLabel} USDC</div><div class="value ${networkUsdc !== null && networkUsdc < 0.05 ? "red" : "cyan"}">${networkUsdc !== null ? "$" + networkUsdc.toFixed(4) : "—"}</div></div>
    </div>
    ${networkUsdc !== null && networkUsdc < 0.05 ? `<p style="font-size:0.78rem;color:#f87171;margin-bottom:1.5rem">⚠️ Low ${payNetworkLabel} USDC — top up to continue fetching signals.</p>` : ""}
    <p class="hint"><a href="/portfolio">Refresh</a></p>
    <script>
      function switchPTab(tab) {
        ['hl','cb','kr','schwab','uni','orders'].forEach(t => {
          const pane = document.getElementById('ppane-' + t);
          const btn  = document.getElementById('ptab-' + t);
          if (pane) pane.style.display = t === tab ? '' : 'none';
          if (btn)  { btn.style.background = t === tab ? '#A8F1F7' : 'transparent'; btn.style.color = t === tab ? '#000' : 'rgba(255,255,255,0.5)'; }
        });
      }
      function sellForUsdc(exchange, asset, maxAmount, btn) {
        const exchLabel = exchange === 'kraken' ? 'Kraken' : 'Coinbase';
        document.getElementById('openModalTitle').textContent = 'Sell ' + asset + ' → USDC';
        document.getElementById('openModalBody').innerHTML =
          '<div style="margin-bottom:1rem">' +
            '<label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">Amount (' + asset + ')</label>' +
            '<div style="display:flex;gap:0.5rem;align-items:center">' +
              '<input id="sellAmount" type="number" step="any" min="0" max="' + maxAmount + '" value="' + maxAmount.toFixed(6) + '" style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:0.5rem 0.75rem;color:#fafafa;font-size:0.9rem;outline:none" />' +
              '<button type="button" onclick="this.previousElementSibling.value=this.dataset.max" data-max="' + maxAmount.toFixed(6) + '" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:rgba(255,255,255,0.45);font-size:0.72rem;padding:0.4rem 0.65rem;cursor:pointer;white-space:nowrap">Max</button>' +
            '</div>' +
            '<div style="font-size:0.68rem;color:rgba(255,255,255,0.3);margin-top:0.3rem">Available: ' + maxAmount.toFixed(6) + ' ' + asset + ' on ' + exchLabel + '</div>' +
          '</div>' +
          '<p style="font-size:0.78rem;color:rgba(255,255,255,0.4)">Market order — fills at current bid price.</p>';
        const confirmBtn = document.getElementById('openModalConfirm');
        confirmBtn.textContent = 'Sell ' + asset;
        confirmBtn.className = 'modal-confirm-red';
        confirmBtn.onclick = async () => {
          const sellAmt = parseFloat(document.getElementById('sellAmount')?.value);
          if (!sellAmt || sellAmt <= 0) { alert('Enter a valid amount.'); return; }
          if (sellAmt > maxAmount) { alert('Amount exceeds available balance.'); return; }
          confirmBtn.textContent = 'Selling…'; confirmBtn.disabled = true;
          document.getElementById('openModal').classList.remove('open');
          btn.textContent = 'Selling…'; btn.disabled = true;
          const res = await fetch('/api/sell-for-usdc', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ exchange, asset, amount: sellAmt }) });
          const d = await res.json();
          if (d.ok) { btn.textContent = '✓'; btn.style.color = '#4ade80'; setTimeout(() => location.reload(), 1500); }
          else { btn.disabled = false; btn.textContent = '→ USDC'; alert('Error: ' + d.error); }
          confirmBtn.disabled = false;
        };
        document.getElementById('openModal').classList.add('open');
      }
      function showEditOrderModal(exchange, orderId, asset, side, size, limitPrice, duration) {
        document.getElementById('editOrderTitle').textContent = 'Edit ' + asset + ' Order (' + exchange + ')';
        document.getElementById('editOrderExchange').value = exchange;
        document.getElementById('editOrderOrderId').value = orderId;
        document.getElementById('editOrderAsset').value = asset;
        document.getElementById('editOrderSide').value = side;
        document.getElementById('editOrderSize').value = size;
        document.getElementById('editOrderPrice').value = limitPrice;
        document.getElementById('editOrderDuration').value = duration || '';
        document.getElementById('editOrderModal').style.display = 'flex';
      }

      async function submitEditOrder() {
        const btn = document.getElementById('editOrderSubmitBtn');
        const exchange = document.getElementById('editOrderExchange').value;
        const orderId = document.getElementById('editOrderOrderId').value;
        const asset = document.getElementById('editOrderAsset').value;
        const side = document.getElementById('editOrderSide').value;
        const size = parseFloat(document.getElementById('editOrderSize').value);
        const limitPrice = parseFloat(document.getElementById('editOrderPrice').value);
        const duration = document.getElementById('editOrderDuration').value || undefined;

        btn.textContent = 'Updating...'; btn.disabled = true;
        try {
          const res = await fetch('/api/edit-order', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ exchange, orderId, asset, side, size, limitPrice, duration })
          });
          const d = await res.json();
          if (d.ok) {
            btn.textContent = 'Updated ✓';
            setTimeout(() => location.reload(), 800);
          } else {
            alert(d.error || 'Update failed');
            btn.textContent = 'Update Order'; btn.disabled = false;
          }
        } catch (e) {
          alert(e.message);
          btn.textContent = 'Update Order'; btn.disabled = false;
        }
      }
    </script>
  `, "portfolio");
}

async function positionsPage() {
  let hlData = null, hlSpotData = null, alpacaPositions = [];

  try {
    const wallet = PRIVATE_KEY
      ? (await import("viem/accounts")).privateKeyToAccount(PRIVATE_KEY)
      : null;
    if (wallet) {
      const hlFetch = (type) => fetch("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, user: wallet.address }),
      }).then(r => r.json()).catch(() => null);
      [hlData, hlSpotData] = await Promise.all([
        hlFetch("clearinghouseState"),
        hlFetch("spotClearinghouseState"),
      ]);
    }
  } catch {}

  if (process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET) {
    try {
      const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
      const alp = new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true");
      alpacaPositions = await alp._request("GET", "/v2/positions") ?? [];
    } catch (e) {
      console.error("[dashboard] Alpaca positions fetch error:", e.message);
    }
  }

  const hlPositions = (hlData?.assetPositions ?? []).filter(p => parseFloat(p.position?.szi ?? "0") !== 0);

  // Spot balances: exclude USDC and truly negligible amounts (<$0.01)
  const hlSpotBalances = (hlSpotData?.balances ?? []).filter(b =>
    b.coin !== "USDC" && parseFloat(b.total ?? "0") > 0 && parseFloat(b.entryNtl ?? "0") >= 0.01
  );
  // Fetch mid prices and entry prices for spot holdings
  const { getMidPrice: hlGetMid } = await import("./hyperliquid.mjs").catch(() => ({}));
  const { getLastEntry } = await import("./db.mjs");
  const spotEntries = {}, spotMids = {};
  await Promise.all(hlSpotBalances.map(async b => {
    try { spotMids[b.coin] = await hlGetMid(b.coin); } catch {}
    const entry = getLastEntry(b.coin);
    if (entry) spotEntries[b.coin] = entry;
  }));

  const allRows = [
    ...hlSpotBalances.map(b => {
      const size = parseFloat(b.total);
      const mid = spotMids[b.coin] ?? 0;
      const entry = spotEntries[b.coin];
      const entryPx = entry?.price ?? 0;
      const leverage = entry?.leverage ?? 1;
      const value = (size * mid).toFixed(2);
      const pnl = entryPx > 0 && mid > 0 ? ((mid - entryPx) * size * leverage) : null;
      const pnlCell = pnl !== null
        ? `<span class="${pnl >= 0 ? "green" : "red"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</span>`
        : `<span style="color:rgba(255,255,255,0.35)">—</span>`;
      const label = leverage > 1 ? `Hyperliquid Spot ${leverage}x` : "Hyperliquid Spot";
      const isDust = parseFloat(b.entryNtl ?? "0") < 1.0;
      const closeBtn = isDust
        ? `<span style="color:rgba(255,255,255,0.25);font-size:0.75rem">dust</span>`
        : `<div style="display:flex;gap:0.4rem"><button class="btn btn-green" onclick="addToPos(this, '${b.coin}', 'hyperliquid', 'buy')" title="Add to position">+</button><button class="btn btn-red" onclick="closePos(this, '${b.coin}', 'hyperliquid')">Force Exit</button></div>`;
      return `<tr>
        <td style="color:rgba(255,255,255,0.4);font-size:0.78rem">${label}</td>
        <td><strong>${b.coin}</strong></td>
        <td><span class="pos-long">▲ LONG</span></td>
        <td>${size}${isDust ? ' <span style="color:rgba(255,255,255,0.3);font-size:0.7rem">(dust)</span>' : ""}</td>
        <td>$${entryPx > 0 ? entryPx.toLocaleString(undefined, {maximumFractionDigits: 4}) : "—"}</td>
        <td>${pnlCell}</td>
        <td>$${value}</td>
        <td class="red">—</td>
        <td>${closeBtn}</td>
      </tr>`;
    }),
    ...hlPositions.map(p => {
      const pos = p.position;
      const size = parseFloat(pos.szi);
      const isLong = size > 0;
      const pnl = parseFloat(pos.unrealizedPnl ?? "0");
      const liqPx = parseFloat(pos.liquidationPx ?? "0");
      return `<tr>
        <td style="color:rgba(255,255,255,0.4);font-size:0.78rem">Hyperliquid</td>
        <td><strong>${pos.coin}</strong></td>
        <td><span class="${isLong ? "pos-long" : "pos-short"}">${isLong ? "▲ LONG" : "▼ SHORT"}</span></td>
        <td>${Math.abs(size)}</td>
        <td>$${parseFloat(pos.entryPx ?? "0").toLocaleString(undefined, {maximumFractionDigits: 2})}</td>
        <td class="${pnl >= 0 ? "green" : "red"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</td>
        <td>$${parseFloat(pos.positionValue ?? "0").toFixed(2)}</td>
        <td class="red">${liqPx > 0 ? "$" + liqPx.toLocaleString(undefined, {maximumFractionDigits: 2}) : "—"}</td>
        <td><div style="display:flex;gap:0.4rem"><button class="btn btn-${isLong ? "green" : "red"}" onclick="addToPos(this, '${pos.coin}', 'hyperliquid', '${isLong ? "buy" : "sell"}')" title="Add to position">+</button><button class="btn btn-red" onclick="closePos(this, '${pos.coin}', 'hyperliquid')">Force Exit</button></div></td>
      </tr>`;
    }),
    ...alpacaPositions.map(p => {
      const qty = parseFloat(p.qty ?? "0");
      const isLong = p.side === "long" || qty > 0;
      const pnl = parseFloat(p.unrealized_pl ?? "0");
      const entryPx = parseFloat(p.avg_entry_price ?? "0");
      const mktVal = parseFloat(p.market_value ?? "0");
      const label = `Alpaca${process.env.ALPACA_PAPER === "true" ? " (paper)" : ""}`;
      return `<tr>
        <td style="color:rgba(255,255,255,0.4);font-size:0.78rem">${label}</td>
        <td><strong>${p.symbol}</strong></td>
        <td><span class="${isLong ? "pos-long" : "pos-short"}">${isLong ? "▲ LONG" : "▼ SHORT"}</span></td>
        <td>${Math.abs(qty)}</td>
        <td>$${entryPx.toLocaleString(undefined, {maximumFractionDigits: 4})}</td>
        <td class="${pnl >= 0 ? "green" : "red"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</td>
        <td>$${mktVal.toFixed(2)}</td>
        <td class="red">—</td>
        <td><div style="display:flex;gap:0.4rem"><button class="btn btn-${isLong ? "green" : "red"}" onclick="addToPos(this, '${p.symbol}', 'alpaca', '${isLong ? "buy" : "sell"}')" title="Add to position">+</button><button class="btn btn-red" onclick="closePos(this, '${p.symbol}', 'alpaca')">Force Exit</button></div></td>
      </tr>`;
    }),
  ];

  const tbody = allRows.length
    ? allRows.join("")
    : `<tr><td colspan="9" style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:1.5rem">No open positions</td></tr>`;

  return shell("Positions", `
    ${!PRIVATE_KEY ? '<p style="color:#f87171;margin-bottom:1rem">⚠️ AGENT_PRIVATE_KEY not set — run <code>npm run setup</code></p>' : ""}
    <div class="card">
      <table>
        <thead><tr><th>Exchange</th><th>Asset</th><th>Side</th><th>Size</th><th>Entry</th><th>Unrealized P&L</th><th>Value</th><th>Liq. Price</th><th></th></tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
    <p class="hint">Auto-refreshes every 30s · <a href="/positions">Refresh now</a></p>
    <script>
      setTimeout(() => location.reload(), 30000);
      function addToPos(btn, asset, exchange, side) {
        const dirLabel = side === 'buy' ? 'Long' : 'Short';
        document.getElementById('openModalTitle').textContent = 'Add to ' + dirLabel + ' — ' + asset;
        document.getElementById('openModalBody').innerHTML =
          '<p style="font-size:0.82rem;color:rgba(255,255,255,0.55);margin:0 0 1rem">Place an additional <strong>' + dirLabel + '</strong> market order on <strong>' + asset + '</strong>.</p>' +
          '<label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">Amount (USD)</label>' +
          '<input id="addPosUsd" type="number" step="any" min="1" placeholder="e.g. 50" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:0.5rem 0.75rem;color:#fafafa;font-size:0.9rem;outline:none">';
        const confirmBtn = document.getElementById('openModalConfirm');
        confirmBtn.textContent = 'Add ' + dirLabel;
        confirmBtn.className = side === 'buy' ? 'modal-confirm-green' : 'modal-confirm-red';
        confirmBtn.onclick = async () => {
          const sizeUsd = parseFloat(document.getElementById('addPosUsd').value);
          if (!sizeUsd || sizeUsd <= 0) { alert('Enter a valid USD amount.'); return; }
          confirmBtn.textContent = 'Placing…'; confirmBtn.disabled = true;
          document.getElementById('openModal').classList.remove('open');
          btn.textContent = '…'; btn.disabled = true;
          try {
            const res = await fetch('/api/add-to-position', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ asset, exchange, side, sizeUsd }) });
            const d = await res.json();
            if (d.ok) { btn.textContent = '✓'; setTimeout(() => location.reload(), 1500); }
            else { btn.disabled = false; btn.textContent = '+'; alert('Error: ' + d.error); }
          } catch { btn.disabled = false; btn.textContent = '+'; }
          confirmBtn.disabled = false;
        };
        document.getElementById('openModal').classList.add('open');
        setTimeout(() => document.getElementById('addPosUsd')?.focus(), 100);
      }
      function closePos(btn, asset, exchange) {
        const exchLabel = exchange === 'alpaca' ? 'Alpaca' : exchange === 'kraken' ? 'Kraken' : exchange === 'coinbase' ? 'Coinbase' : 'Hyperliquid';
        document.getElementById('openModalTitle').textContent = 'Force Exit — ' + asset;
        document.getElementById('openModalBody').innerHTML =
          '<p>This will immediately close the <strong>' + asset + '</strong> position on <strong>' + exchLabel + '</strong> at market price.</p>';
        const confirmBtn = document.getElementById('openModalConfirm');
        confirmBtn.textContent = 'Force Exit';
        confirmBtn.className = 'modal-confirm-red';
        confirmBtn.onclick = async () => {
          confirmBtn.textContent = 'Closing…';
          confirmBtn.disabled = true;
          document.getElementById('openModal').classList.remove('open');
          btn.textContent = 'Closing…'; btn.disabled = true;
          const res = await fetch('/api/close', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({asset, exchange}) });
          const d = await res.json();
          if (d.ok) { btn.textContent = 'Closed ✓'; btn.style.color='#4ade80'; setTimeout(()=>location.reload(),1500); }
          else { btn.textContent = 'Error'; btn.disabled = false; alert(d.error); }
          confirmBtn.disabled = false;
        };
        document.getElementById('openModal').classList.add('open');
      }
    </script>
  `, "positions");
}

function tvSymbol(symbol, exchange = "hyperliquid") {
  const base = symbol.replace(/-USD$/i, "").replace(/\/USD$/i, "").toUpperCase();
  // Kraken and Coinbase: route directly to their TradingView data feed
  if (exchange === "kraken") {
    const krakenBase = base === "BTC" ? "XBT" : base;
    return `KRAKEN:${krakenBase}USD`;
  }
  if (exchange === "coinbase") return `COINBASE:${base}USD`;
  // Hyperliquid / Alpaca crypto: Binance USDT pairs; Alpaca stocks: exchange-specific
  const crypto = { BTC:"BINANCE:BTCUSDT",ETH:"BINANCE:ETHUSDT",SOL:"BINANCE:SOLUSDT",BNB:"BINANCE:BNBUSDT",XRP:"BINANCE:XRPUSDT",ADA:"BINANCE:ADAUSDT",AVAX:"BINANCE:AVAXUSDT",DOGE:"BINANCE:DOGEUSDT",LINK:"BINANCE:LINKUSDT",DOT:"BINANCE:DOTUSDT",MATIC:"BINANCE:MATICUSDT",POL:"BINANCE:POLUSDT",UNI:"BINANCE:UNIUSDT",ATOM:"BINANCE:ATOMUSDT",LTC:"BINANCE:LTCUSDT",SHIB:"BINANCE:SHIBUSDT",TRX:"BINANCE:TRXUSDT",SUI:"BINANCE:SUIUSDT",APT:"BINANCE:APTUSDT",INJ:"BINANCE:INJUSDT",NEAR:"BINANCE:NEARUSDT",ARB:"BINANCE:ARBUSDT",OP:"BINANCE:OPUSDT",WIF:"BINANCE:WIFUSDT",PEPE:"BINANCE:PEPEUSDT",BONK:"BINANCE:BONKUSDT",AKT:"BINANCE:AKTUSDT",ZEC:"BINANCE:ZECUSDT" };
  const stocks = { SPY:"AMEX:SPY",QQQ:"NASDAQ:QQQ",IWM:"AMEX:IWM",GLD:"AMEX:GLD",AAPL:"NASDAQ:AAPL",TSLA:"NASDAQ:TSLA",NVDA:"NASDAQ:NVDA",MSFT:"NASDAQ:MSFT",AMZN:"NASDAQ:AMZN",GOOGL:"NASDAQ:GOOGL" };
  return crypto[base] || stocks[base] || base;
}

function strategiesPage() {
  const strategies = getStrategies();

  const cards = strategies.length
    ? strategies.map(s => {
        const latest = getLatestSignal(s.id);
        const sig = latest?.signal ?? "—";
        const sigClass = sig === "LONG" ? "badge-long" : sig === "SHORT" ? "badge-short" : "badge-flat";
        const size = s.position_size_usd ? "$" + s.position_size_usd : "$" + (process.env.HL_POSITION_SIZE_USD ?? 10) + " (default)";
        const tv = tvSymbol(s.symbol, s.exchange);
        const sdJson = JSON.stringify(s).replace(/"/g, '&quot;');
        return `
        <div class="acc-item" id="acc-${s.id}">
          <div class="acc-header" onclick="toggleAcc('${s.id}', event)">
            <svg class="acc-chevron" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap">
                <strong style="font-size:0.95rem">${s.name}</strong>
                <span class="cyan" style="font-size:0.8rem">${s.symbol}</span>
                ${sig !== "—" ? `<span class="${sigClass}">${sig}</span>` : ""}
                ${s.active ? `<span class="badge-active">● AUTO</span>` : `<span class="badge-inactive">○ INACTIVE</span>`}
              </div>
              <div style="margin-top:0.3rem;font-size:0.72rem;color:rgba(255,255,255,0.35);display:flex;gap:1rem;flex-wrap:wrap">
                <span>${s.leverage}x leverage · ${size} · ${{ kraken: "Kraken", alpaca: "Alpaca", coinbase: "Coinbase" }[s.exchange] ?? "Hyperliquid"} · every ${s.interval_minutes >= 1440 ? "day" : s.interval_minutes + "min"}${s.tp_pct ? ` · TP ${s.tp_pct}% → trail ${s.trail_pct ?? 0.5}%` : ""}</span>
                ${latest?.date ? `<span>Signal: ${latest.date}</span>` : ""}
                <span style="font-family:monospace">${s.id.slice(0,8)}…
                  <button onclick="copyId('${s.id}', this);event.stopPropagation()" style="background:none;border:1px solid rgba(255,255,255,0.1);border-radius:3px;color:rgba(255,255,255,0.3);cursor:pointer;font-size:0.6rem;padding:0.05rem 0.3rem;margin-left:0.2rem;vertical-align:middle">copy</button>
                </span>
                <button class="info-btn strategy-info-btn" data-strategy="${sdJson}" title="Conditions" onclick="showStrategyInfo(this);event.stopPropagation()"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
              </div>
            </div>
            <div style="display:flex;gap:0.4rem;align-items:center;flex-shrink:0" onclick="event.stopPropagation()">
              ${s.active
                ? `<button class="btn btn-red" onclick="showToggleModal(this, '${s.id}', false, '${s.symbol}', ${s.interval_minutes ?? 60})">Deactivate</button>`
                : `<button class="btn btn-green" onclick="showToggleModal(this, '${s.id}', true, '${s.symbol}', ${s.interval_minutes ?? 60})">Activate</button>`}
              <button class="btn btn-cyan" onclick="runNow(this, '${s.id}', '${s.name.replace(/'/g, "\\'")}')">▶ Run Now</button>
              <button class="btn btn-green" onclick="openPosition(this, '${s.id}', 'buy', '${s.symbol}')">Open Long</button>
              <button class="btn btn-red" onclick="openPosition(this, '${s.id}', 'sell', '${s.symbol}')">Open Short</button>

              <button class="btn btn-cyan" onclick="openEditModal(${JSON.stringify(s).replace(/"/g, '&quot;')})">Edit</button>
              <button class="btn btn-red" onclick="deleteStrat('${s.id}')">✕</button>
            </div>
          </div>
          <div class="acc-body" id="acc-body-${s.id}"></div>
        </div>`;
      }).join("")
    : `<div style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:2rem">No strategies yet. <a href="/add-strategy">Add one →</a></div>`;

  return shell("Strategies", `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
      <p class="section-label" style="margin:0">Strategies</p>
      <a href="/add-strategy" class="nav-link btn-cyan" style="font-size:0.78rem;padding:0.3rem 0.75rem;border-radius:6px;border:1px solid rgba(168,241,247,0.3);color:#A8F1F7">+ Add Strategy</a>
    </div>
    ${cards}
    <script src="https://s3.tradingview.com/tv.js"></script>
    <script>
    const TV_SYMBOLS = ${JSON.stringify(Object.fromEntries(strategies.map(s => [s.id, tvSymbol(s.symbol, s.exchange)])))};
    const STRAT_INFO  = ${JSON.stringify(Object.fromEntries(strategies.map(s => [s.id, { exchange: s.exchange ?? "hyperliquid", symbol: s.symbol.replace(/-USD$|\/USD$/i, "") }])))};

    const FIELD_TO_STUDY = {
      rsi:        'RSI@tv-basicstudies',
      above_ma:   'MASimple@tv-basicstudies',
      above_ema:  'MAExp@tv-basicstudies',
      macd_cross: 'MACD@tv-basicstudies',
      bb_upper:   'BB@tv-basicstudies',
      bb_lower:   'BB@tv-basicstudies',
      stoch_k:    'Stochastic@tv-basicstudies',
      adx:        'ADX@tv-basicstudies',
      above_pp:   'Pivot Points Standard@tv-basicstudies',
      below_pp:   'Pivot Points Standard@tv-basicstudies',
      above_r1:   'Pivot Points Standard@tv-basicstudies',
      below_s1:   'Pivot Points Standard@tv-basicstudies',
    };

    async function toggleAcc(id, e) {
      const item = document.getElementById('acc-' + id);
      const body = document.getElementById('acc-body-' + id);
      const isOpen = item.classList.contains('open');
      item.classList.toggle('open');
      if (!isOpen && !body.querySelector('.tv-widget-container')) {
        const tv = TV_SYMBOLS[id] || 'BINANCE:BTCUSDT';

        // Fetch strategy conditions + funding rate in parallel
        let studies = [];
        let tvInterval = '60';
        let fundingHtml = '';
        const info = STRAT_INFO[id] ?? {};
        const isHL = !info.exchange || info.exchange === 'hyperliquid';
        const [detailsRes, fundingRes] = await Promise.all([
          fetch('/api/strategy-details/' + id),
          isHL && info.symbol ? fetch('/api/funding-rate/' + encodeURIComponent(info.symbol)) : Promise.resolve(null),
        ]);
        try {
          if (detailsRes.ok) {
            const full = await detailsRes.json();
            const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
            const hasConditions = r => r?.conditions?.length > 0;
            const entry = hasConditions(parse(full.long_entry)) ? parse(full.long_entry) : parse(full.entry);
            const exit  = hasConditions(parse(full.long_exit))  ? parse(full.long_exit)  : parse(full.exit);
            const allConds = [...(entry?.conditions ?? []), ...(exit?.conditions ?? [])];
            const CANDLE_TO_TV = { "1m":"1","3m":"3","5m":"5","15m":"15","30m":"30","1h":"60","2h":"120","4h":"240","8h":"480","12h":"720","1d":"D" };
            tvInterval = CANDLE_TO_TV[allConds.find(c => c.interval)?.interval] ?? '60';
            const seen = new Set();
            for (const c of allConds) {
              const study = FIELD_TO_STUDY[c.field];
              if (study && !seen.has(study)) { seen.add(study); studies.push(study); }
              if (studies.length >= 2) break;
            }
          }
        } catch {}
        try {
          if (fundingRes?.ok) {
            const f = await fundingRes.json();
            const rate = f.funding;
            const ratePct = (rate * 100).toFixed(4);
            const color = rate < 0 ? '#4ade80' : rate > 0 ? '#f87171' : 'rgba(255,255,255,0.4)';
            const dir   = rate < 0 ? '▼ shorts pay' : rate > 0 ? '▲ longs pay' : '—';
            const fmtNum = n => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n.toFixed(0);
            fundingHtml = '<div style="display:flex;gap:1.5rem;align-items:center;padding:0.5rem 0.75rem;background:rgba(0,0,0,0.25);font-size:0.75rem;border-bottom:1px solid rgba(255,255,255,0.07)">'
              + '<span style="color:rgba(255,255,255,0.4)">Funding/hr</span>'
              + '<span style="color:' + color + ';font-weight:600">' + (rate >= 0 ? '+' : '') + ratePct + '% &nbsp;<span style="font-weight:400;opacity:0.7">' + dir + '</span></span>'
              + '<span style="color:rgba(255,255,255,0.4)">OI</span><span style="color:rgba(255,255,255,0.75)">$' + fmtNum(f.openInterest * f.markPx) + '</span>'
              + '<span style="color:rgba(255,255,255,0.4)">24h Vol</span><span style="color:rgba(255,255,255,0.75)">$' + fmtNum(f.dayNtlVlm) + '</span>'
              + '</div>';
          }
        } catch {}
        const containerId = 'tv_' + id.replace(/-/g, '');
        body.innerHTML = fundingHtml + '<div id="' + containerId + '" class="tv-widget-container" style="height:480px"></div>';

        new TradingView.widget({
          container_id:        containerId,
          symbol:              tv,
          interval:            tvInterval,
          theme:               'dark',
          style:               '1',
          locale:              'en',
          toolbar_bg:          '#111113',
          allow_symbol_change: true,
          hide_side_toolbar:   false,
          save_image:          false,
          width:               '100%',
          height:              480,
          studies:             studies,
          overrides: {
            'paneProperties.background':                   '#111113',
            'paneProperties.backgroundGradientStartColor': '#111113',
            'paneProperties.backgroundGradientEndColor':   '#111113',
            'paneProperties.backgroundType':               'solid',
            'paneProperties.vertGridProperties.color':     'rgba(255,255,255,0.04)',
            'paneProperties.horzGridProperties.color':     'rgba(255,255,255,0.04)',
          },
          studies_overrides: {
            'RSI.Background.color':              '#111113',
            'RSI.Background.transparency':       0,
            'RSI.Background.visible':            false,
            'RSI.Upper Band BG.color':           '#111113',
            'RSI.Upper Band BG.transparency':    0,
            'RSI.Upper Band BG.visible':         false,
            'RSI.Lower Band BG.color':           '#111113',
            'RSI.Lower Band BG.transparency':    0,
            'RSI.Lower Band BG.visible':         false,
            'RSI.Overbought BG.color':           '#111113',
            'RSI.Overbought BG.transparency':    0,
            'RSI.Overbought BG.visible':         false,
            'RSI.Oversold BG.color':             '#111113',
            'RSI.Oversold BG.transparency':      0,
            'RSI.Oversold BG.visible':           false,
            'RSI.Hlines Background.color':       '#111113',
            'RSI.Hlines Background.transparency': 0,
          },
        });
      }
    }
    function runNow(btn, id, name) {
      document.getElementById('runModalTitle').textContent = '▶ Run Strategy — ' + name;
      document.getElementById('runModalBody').innerHTML =
        '<p>Fetches the latest live signal from AgentSignal and executes a trade if the signal has flipped.</p>' +
        '<div class="flow" style="margin-top:0.75rem">' +
          '<div class="flow-step"><span class="num">1</span><span>Fetch live signal (may cost $0.01 via x402)</span></div>' +
          '<div class="flow-step"><span class="num">2</span><span>Compare to last recorded signal</span></div>' +
          '<div class="flow-step"><span class="num">3</span><span>Execute trade only if signal has flipped</span></div>' +
        '</div>';
      const confirmBtn = document.getElementById('runModalConfirm');
      confirmBtn.textContent = '▶ Run Now';
      confirmBtn.disabled = false;
      confirmBtn.onclick = async () => {
        confirmBtn.textContent = 'Running…';
        confirmBtn.disabled = true;
        document.getElementById('runModal').classList.remove('open');
        btn.textContent = 'Running…'; btn.disabled = true;
        try {
          const res = await fetch('/api/run', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) });
          const d = await res.json();
          if (d.ok) {
            btn.textContent = '✓'; btn.style.color = '#4ade80';
            // Show result in modal
            document.getElementById('runModalTitle').textContent = '✓ Done';
            document.getElementById('runModalBody').innerHTML = '<p style="color:#4ade80">' + d.action + '</p>';
            document.getElementById('runModal').classList.add('open');
            document.getElementById('runModalConfirm').style.display = 'none';
            document.querySelector('#runModal .modal-cancel').textContent = 'Close';
            setTimeout(() => location.reload(), 2500);
          } else {
            btn.disabled = false; btn.textContent = '▶ Run Now';
            document.getElementById('runModalTitle').textContent = '✗ Error';
            document.getElementById('runModalBody').innerHTML = '<p style="color:#f87171">' + d.error + '</p>';
            document.getElementById('runModal').classList.add('open');
            document.getElementById('runModalConfirm').style.display = 'none';
            document.querySelector('#runModal .modal-cancel').textContent = 'Close';
          }
        } catch (e) {
          btn.disabled = false; btn.textContent = '▶ Run Now';
        }
        confirmBtn.disabled = false;
      };
      document.getElementById('runModalConfirm').style.display = '';
      document.querySelector('#runModal .modal-cancel').textContent = 'Cancel';
      document.getElementById('runModal').classList.add('open');
    }
    let _omType = 'market';
    function omSetType(type) {
      _omType = type;
      const mBtn = document.getElementById('omtMarket');
      const lBtn = document.getElementById('omtLimit');
      const lRow = document.getElementById('omLimitRow');
      const desc = document.getElementById('omTypeDesc');
      const isMarket = type === 'market';
      mBtn.style.background = isMarket ? 'rgba(168,241,247,0.12)' : 'none';
      mBtn.style.color = isMarket ? '#A8F1F7' : 'rgba(255,255,255,0.4)';
      mBtn.style.borderColor = isMarket ? 'rgba(168,241,247,0.3)' : 'rgba(255,255,255,0.1)';
      lBtn.style.background = isMarket ? 'none' : 'rgba(168,241,247,0.12)';
      lBtn.style.color = isMarket ? 'rgba(255,255,255,0.4)' : '#A8F1F7';
      lBtn.style.borderColor = isMarket ? 'rgba(255,255,255,0.1)' : 'rgba(168,241,247,0.3)';
      lRow.style.display = isMarket ? 'none' : 'block';
      desc.innerHTML = isMarket
        ? 'Closes any existing position first, then places a <strong>market order immediately</strong>.'
        : 'Places a <strong>GTC limit order</strong> at your specified price — fills when the market reaches it.';
    }
    function openPosition(btn, id, side, symbol) {
      _omType = 'market';
      const label = side === 'buy' ? 'Open Long' : 'Open Short';
      const color = side === 'buy' ? '#4ade80' : '#f87171';
      const confirmCls = side === 'buy' ? 'modal-confirm-green' : 'modal-confirm-red';
      const btnStyle = 'flex:1;padding:0.4rem;border-radius:6px;border:1px solid;cursor:pointer;font-size:0.78rem;transition:all 0.1s';
      document.getElementById('openModalTitle').textContent = label + ' — ' + symbol;
      document.getElementById('openModalBody').innerHTML =
        '<div style="display:flex;gap:0.5rem;margin-bottom:1rem">' +
          '<button id="omtMarket" onclick="omSetType(\\'market\\')" style="' + btnStyle + ';background:rgba(168,241,247,0.12);color:#A8F1F7;border-color:rgba(168,241,247,0.3)">Market</button>' +
          '<button id="omtLimit" onclick="omSetType(\\'limit\\')" style="' + btnStyle + ';background:none;color:rgba(255,255,255,0.4);border-color:rgba(255,255,255,0.1)">Limit</button>' +
        '</div>' +
        '<div id="omLimitRow" style="display:none;margin-bottom:1rem">' +
          '<label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">Limit Price (USD)</label>' +
          '<input id="omLimitPrice" type="number" step="any" min="0" placeholder="0.00" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:0.5rem 0.75rem;color:#fafafa;font-size:0.9rem;outline:none">' +
        '</div>' +
        '<p id="omTypeDesc" style="font-size:0.82rem;color:rgba(255,255,255,0.55);margin:0">Closes any existing position first, then places a <strong>market order immediately</strong>.</p>';
      const confirmBtn = document.getElementById('openModalConfirm');
      confirmBtn.textContent = label;
      confirmBtn.className = confirmCls;
      confirmBtn.onclick = async () => {
        const isLimit = _omType === 'limit';
        const limitPrice = isLimit ? parseFloat(document.getElementById('omLimitPrice').value) : null;
        if (isLimit && (!limitPrice || limitPrice <= 0)) { alert('Enter a valid limit price.'); return; }
        confirmBtn.textContent = isLimit ? 'Placing limit order…' : 'Placing order…';
        confirmBtn.disabled = true;
        document.getElementById('openModal').classList.remove('open');
        btn.textContent = 'Executing…'; btn.disabled = true;
        try {
          const payload = { id, side };
          if (limitPrice) payload.limitPrice = limitPrice;
          const res = await fetch('/api/open', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          const d = await res.json();
          if (d.ok) { btn.textContent = '✓'; btn.style.color = color; setTimeout(() => location.reload(), 1500); }
          else { btn.disabled = false; btn.textContent = label; alert('Error: ' + d.error); }
        } catch { btn.disabled = false; btn.textContent = label; }
        confirmBtn.disabled = false;
      };
      document.getElementById('openModal').classList.add('open');
    }

    async function deleteStrat(id) {
      if (!confirm('Remove this strategy from the trader?\\n\\nThis does not close any open positions.')) return;
      await fetch('/api/strategy/' + id, { method: 'DELETE' });
      location.reload();
    }

    const CANDLE_TO_MIN = { "1m":1,"3m":3,"5m":5,"15m":15,"30m":30,"1h":60,"2h":120,"4h":240,"8h":480,"12h":720,"1d":1440 };

    async function openEditModal(s) {
      const f = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
      const sel = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
      document.getElementById('editModalTitle').textContent = 'Edit — ' + s.name;
      document.getElementById('em_id').value = s.id;
      f('em_name', s.name);
      f('em_symbol', s.symbol);
      f('em_position_size_usd', s.position_size_usd);
      sel('em_leverage', s.leverage ?? 1);
      sel('em_exchange', s.exchange ?? 'hyperliquid');
      sel('em_interval_minutes', s.interval_minutes ?? 60);
      f('em_tp_pct', s.tp_pct);
      f('em_trail_pct', s.trail_pct);
      f('em_sl_pct', s.sl_pct);
      f('em_max_size_usd', s.max_size_usd);
      f('em_cooldown_minutes', s.cooldown_minutes);
      // Clear placeholders until strategy def loads
      ['em_tp_pct','em_trail_pct','em_sl_pct'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.placeholder = 'optional';
      });
      document.getElementById('editModal').classList.add('open');

      // Fetch candle interval + AgentSignal risk for placeholders
      const hint = document.getElementById('em_candle_hint');
      hint.style.display = 'none';
      try {
        const r = await fetch('/api/strategy-details/' + s.id);
        if (r.ok) {
          const def = await r.json();
          const parseJ = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };
          const defEntry = parseJ(def.long_entry) ?? parseJ(def.entry);
          const defExit  = parseJ(def.long_exit)  ?? parseJ(def.exit);
          const conds = [...(defEntry?.conditions ?? []), ...(defExit?.conditions ?? [])];
          const candleInterval = conds.find(c => c.interval)?.interval;
          // Lock exchange to Hyperliquid for scalper strategies (candle/trigger-based)
          const isScalper = conds.some(c => c.source === 'trigger');
          const exchSel = document.getElementById('em_exchange');
          if (isScalper) {
            exchSel.value = 'hyperliquid';
            exchSel.disabled = true;
            exchSel.title = 'Scalper strategies require Hyperliquid';
          } else {
            exchSel.disabled = false;
            exchSel.title = '';
          }
          // Show AgentSignal risk values as placeholders when trader has no override
          const risk = def.risk ?? {};
          if (risk.tp_pct    != null && !s.tp_pct)    document.getElementById('em_tp_pct').placeholder    = 'from strategy: ' + risk.tp_pct + '%';
          if (risk.trail_pct != null && !s.trail_pct) document.getElementById('em_trail_pct').placeholder = 'from strategy: ' + risk.trail_pct + '%';
          const riskSl = risk.sl_pct ?? risk.stop_loss_pct ?? null;
          if (riskSl != null && !s.sl_pct) document.getElementById('em_sl_pct').placeholder = 'from strategy: ' + riskSl + '%';
          if (candleInterval) {
            const candleMin = CANDLE_TO_MIN[candleInterval];
            const mismatch = candleMin && candleMin !== (s.interval_minutes ?? 60);
            hint.style.display = 'block';
            hint.style.color = mismatch ? 'rgba(251,191,36,0.7)' : 'rgba(255,255,255,0.3)';
            hint.innerHTML = '';
            const strong = document.createElement('strong');
            strong.textContent = candleInterval;
            hint.appendChild(document.createTextNode('Candle interval: '));
            hint.appendChild(strong);
            if (mismatch) {
              const link = document.createElement('a');
              link.href = '#';
              link.textContent = 'match';
              link.style.color = 'rgba(168,241,247,0.8)';
              link.style.marginLeft = '0.25rem';
              link.addEventListener('click', function(e) {
                e.preventDefault();
                document.getElementById('em_interval_minutes').value = candleMin;
                hint.style.color = 'rgba(255,255,255,0.3)';
                hint.textContent = 'Candle interval: ' + candleInterval + ' — matched';
              });
              hint.appendChild(document.createTextNode(' — '));
              hint.appendChild(link);
            } else {
              hint.appendChild(document.createTextNode(' — matched'));
            }
          }
        }
      } catch {}
    }

    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('editModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });

      document.getElementById('editModalSave').addEventListener('click', async () => {
      const btn = document.getElementById('editModalSave');
      btn.textContent = 'Saving…'; btn.disabled = true;
      const get = id => document.getElementById(id)?.value ?? '';
      const payload = {
        id: get('em_id'),
        name: get('em_name'),
        symbol: get('em_symbol'),
        leverage: parseInt(get('em_leverage')) || 1,
        position_size_usd: get('em_position_size_usd') ? parseFloat(get('em_position_size_usd')) : null,
        exchange: document.getElementById('em_exchange')?.value || 'hyperliquid',
        interval_minutes: parseInt(get('em_interval_minutes')) || 60,
        tp_pct: get('em_tp_pct') ? parseFloat(get('em_tp_pct')) : null,
        trail_pct: get('em_trail_pct') ? parseFloat(get('em_trail_pct')) : null,
        sl_pct: get('em_sl_pct') ? parseFloat(get('em_sl_pct')) : null,
        max_size_usd: get('em_max_size_usd') ? parseFloat(get('em_max_size_usd')) : null,
        cooldown_minutes: get('em_cooldown_minutes') ? parseInt(get('em_cooldown_minutes')) : null,
      };
      const res = await fetch('/api/upsert-strategy', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const d = await res.json();
      if (d.ok) { location.reload(); }
      else { btn.textContent = 'Save'; btn.disabled = false; alert(d.error); }
    });
    }); // DOMContentLoaded
    </script>

  `, "strategies");
}

function signalsPage() {
  const signals = getRecentSignalEvents(48);

  function timeAgo(createdAt) {
    const diffMs = Date.now() - new Date(createdAt + "Z").getTime();
    const m = Math.floor(diffMs / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  const feed = signals.length
    ? signals.map(s => {
        const sigClass = s.signal === "LONG" ? "long" : s.signal === "SHORT" ? "short" : "flat";
        const isCheck = s.type === "check";
        const price = s.price ? "$" + parseFloat(s.price).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—";
        const notes = s.notes ? `<div class="notif-meta">${s.notes}</div>` : "";
        const label = isCheck
          ? `<span class="notif-sig ${sigClass}" style="opacity:0.5">${s.signal} ✓</span>`
          : `<span class="notif-sig ${sigClass}">${s.prev_signal ? s.prev_signal + " → " : ""}${s.signal}</span>`;
        return `<div class="notif" style="${isCheck ? "opacity:0.6" : ""}">
          <div class="notif-dot ${sigClass}" style="${isCheck ? "opacity:0.4" : ""}"></div>
          <div class="notif-body">
            <div class="notif-top">
              <span class="notif-name">${s.strategy_name}</span>
              ${label}
            </div>
            ${notes}
          </div>
          <div class="notif-price">
            <div>${price}</div>
            <div class="notif-time">${timeAgo(s.updated_at ?? s.created_at)}</div>
          </div>
        </div>`;
      }).join("")
    : `<div style="color:rgba(255,255,255,0.25);font-style:italic;padding:1.5rem 0;text-align:center;font-size:0.82rem">No signals in the last 48 hours</div>`;

  return shell("Signals", `
    <p class="section-label">Signal Feed — Last 48 Hours</p>
    <div class="notif-feed">${feed}</div>
  `, "signals");
}

function historyPage() {
  const trades = getAllRecentTrades(100);
  const strategies = getStrategies();

  // Build exchange map: strategyId → exchange
  const stratMap = {};
  for (const s of strategies) stratMap[s.id] = s.exchange ?? "hyperliquid";

  const isPaper = process.env.ALPACA_PAPER === "true";

  // Split trades into live vs paper
  const liveTrades = trades.filter(t => {
    const exchange = stratMap[t.strategy_id] ?? "hyperliquid";
    return !(exchange === "alpaca" && isPaper);
  });
  const paperTrades = trades.filter(t => {
    const exchange = stratMap[t.strategy_id] ?? "hyperliquid";
    return exchange === "alpaca" && isPaper;
  });

  function calcStats(tList) {
    const closedTrades = tList.filter(t => t.pnl != null);
    const totalPnl = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnl), 0);
    const winners = closedTrades.filter(t => parseFloat(t.pnl) > 0).length;
    const winRate = closedTrades.length > 0 ? Math.round((winners / closedTrades.length) * 100) : null;
    return { totalPnl, winRate, tradeCount: tList.length, closedCount: closedTrades.length };
  }

  function renderStatBar(stats, id) {
    const pnlColor = stats.totalPnl >= 0 ? "#4ade80" : "#f87171";
    const pnlStr = stats.closedCount > 0
      ? `<span style="color:${pnlColor};font-weight:600">${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}</span>`
      : `<span style="color:rgba(255,255,255,0.3)">—</span>`;
    const wrStr = stats.winRate != null
      ? `<span style="color:rgba(255,255,255,0.7)">${stats.winRate}%</span>`
      : `<span style="color:rgba(255,255,255,0.3)">—</span>`;
    return `<div id="${id}" style="display:flex;gap:2rem;padding:0.75rem 1rem;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;margin-bottom:0.75rem;font-size:0.8rem">
      <div><span style="color:rgba(255,255,255,0.4);margin-right:0.4rem">Total P&amp;L</span>${pnlStr}</div>
      <div><span style="color:rgba(255,255,255,0.4);margin-right:0.4rem">Win Rate</span>${wrStr}</div>
      <div><span style="color:rgba(255,255,255,0.4);margin-right:0.4rem">Trades</span><span style="color:rgba(255,255,255,0.7)">${stats.tradeCount}</span></div>
    </div>`;
  }

  function renderTradeTable(tList, emptyMsg) {
    const rows = tList.length
      ? tList.map(t => {
          const isEntry = t.action.startsWith("ENTERED") || t.action.startsWith("SHORTED");
          const isCollect = t.action === 'COLLECT FEES';
          const pnl = t.pnl != null ? parseFloat(t.pnl) : null;
          const pnlStr = pnl != null
            ? `<span style="color:${pnl >= 0 ? "#4ade80" : "#f87171"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</span>`
            : "—";
          const actionColor = isCollect ? "#A8F1F7" : isEntry ? "#4ade80" : "#f87171";
          const strategyLabel = isCollect ? "Uniswap" : (t.strategy_name ?? (t.strategy_id === 'manual' ? 'Manual' : t.strategy_id ? t.strategy_id.slice(0,8) : '—'));
          return `<tr${isCollect ? ' style="background:rgba(168,241,247,0.03)"' : ''}>
            <td>${t.created_at.slice(0, 16)}</td>
            <td>${strategyLabel}</td>
            <td style="color:${actionColor}">${t.action}${isCollect ? ` <span style="color:rgba(255,255,255,0.35);font-size:0.72rem">(${t.asset})</span>` : ''}</td>
            <td>${t.price ? "$" + parseFloat(t.price).toLocaleString(undefined, {maximumFractionDigits: 2}) : "—"}</td>
            <td>${pnlStr}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="5" style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:1.5rem">${emptyMsg}</td></tr>`;
    return `<table>
      <thead><tr><th>Time</th><th>Strategy</th><th>Action</th><th>Price</th><th>P&amp;L</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  const liveStats = calcStats(liveTrades);
  const paperStats = calcStats(paperTrades);

  const sigSections = strategies.map(s => {
    const sigs = getSignalHistory(s.id, 20);
    const sigRows = sigs.map(sig => {
      const c = sig.signal === "LONG" ? "green" : sig.signal === "SHORT" ? "red" : "";
      return `<tr>
        <td>${sig.date}</td>
        <td><strong class="${c}">${sig.signal}</strong></td>
        <td>${sig.price ? "$" + parseFloat(sig.price).toLocaleString(undefined, {maximumFractionDigits: 0}) : "—"}</td>
        <td style="font-size:0.75rem;color:rgba(255,255,255,0.35)">${sig.notes ?? "—"}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="4" style="color:rgba(255,255,255,0.25);font-style:italic;padding:1rem">No signals yet</td></tr>`;

    return `<p class="section-label">${s.name} — Signal History</p>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th>Signal</th><th>Price</th><th>Notes</th></tr></thead>
        <tbody>${sigRows}</tbody>
      </table>
    </div>`;
  }).join("");

  return shell("History", `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
      <p class="section-label" style="margin:0">Trade Log</p>
      <div style="display:flex;gap:0.25rem;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.2rem">
        <button onclick="switchTab('live')" id="tab-live"
          style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:#A8F1F7;color:#000">
          Live
        </button>
        <button onclick="switchTab('paper')" id="tab-paper"
          style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">
          Paper
        </button>
      </div>
    </div>

    <div id="pane-live">
      ${renderStatBar(liveStats, "stats-live")}
      <div class="card">${renderTradeTable(liveTrades, "No live trades yet")}</div>
    </div>

    <div id="pane-paper" style="display:none">
      ${renderStatBar(paperStats, "stats-paper")}
      <div class="card">${renderTradeTable(paperTrades, "No paper trades yet")}</div>
    </div>

    <script>
      function switchTab(tab) {
        const isLive = tab === 'live';
        document.getElementById('pane-live').style.display = isLive ? '' : 'none';
        document.getElementById('pane-paper').style.display = isLive ? 'none' : '';
        document.getElementById('tab-live').style.background = isLive ? '#A8F1F7' : 'transparent';
        document.getElementById('tab-live').style.color = isLive ? '#000' : 'rgba(255,255,255,0.5)';
        document.getElementById('tab-paper').style.background = isLive ? 'transparent' : '#A8F1F7';
        document.getElementById('tab-paper').style.color = isLive ? 'rgba(255,255,255,0.5)' : '#000';
      }
    </script>

    ${sigSections}
  `, "history");
}

function settingsPage(saved = false, error = "", schwabAuthorized = false) {
  const val = (key) => getEnvValue(key);

  function field(label, name, value, type = "text", hint = "") {
    const isSecret = type === "password";
    const id = `field_${name}`;
    return `<div>
      <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">${label}</label>
      <div style="position:relative;display:flex;gap:0.4rem;align-items:center">
        <input id="${id}" name="${name}" type="${isSecret ? "password" : "text"}"
          value="${value.replace(/"/g, "&quot;")}"
          placeholder="${isSecret ? "••••••••••••••••" : ""}"
          autocomplete="off" style="width:100%;font-family:${isSecret ? "monospace" : "inherit"}" />
        ${isSecret ? `<button type="button" onclick="toggleSecret('${id}')" style="background:none;border:1px solid rgba(255,255,255,0.1);border-radius:5px;color:rgba(255,255,255,0.4);cursor:pointer;padding:0.35rem 0.55rem;font-size:0.7rem;white-space:nowrap;flex-shrink:0">Show</button>` : ""}
      </div>
      ${hint ? `<div style="font-size:0.68rem;color:rgba(255,255,255,0.3);margin-top:0.25rem">${hint}</div>` : ""}
    </div>`;
  }

  function pemField(label, name, value, hint = "") {
    // Decode stored \n back to real newlines for display in textarea
    const display = value.replace(/\\n/g, "\n");
    const id = `field_${name}`;
    return `<div>
      <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">${label}</label>
      <textarea id="${id}" name="${name}" rows="5" autocomplete="off"
        placeholder="-----BEGIN EC PRIVATE KEY-----&#10;...&#10;-----END EC PRIVATE KEY-----"
        style="width:100%;font-family:monospace;font-size:0.72rem;resize:vertical;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fafafa;padding:0.5rem"
      >${display.replace(/</g, "&lt;")}</textarea>
      ${hint ? `<div style="font-size:0.68rem;color:rgba(255,255,255,0.3);margin-top:0.25rem">${hint}</div>` : ""}
    </div>`;
  }

  function section(title, icon, fields) {
    return `<div class="card" style="margin-bottom:1rem">
      <div style="font-size:0.8rem;font-weight:700;color:#fafafa;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem">
        <span style="font-size:1rem">${icon}</span>${title}
      </div>
      <div style="display:flex;flex-direction:column;gap:0.85rem">${fields}</div>
    </div>`;
  }

  return shell("Settings", `
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:2rem">
      <img src="/public/logo.png" alt="AgentSignal" style="width:52px;height:52px;border-radius:12px" />
      <div>
        <div style="font-size:1.25rem;font-weight:700;color:#fafafa;letter-spacing:-0.03em">AgentSignal Trader</div>
        <div style="font-size:0.75rem;color:rgba(255,255,255,0.35);margin-top:0.1rem">Local trading agent — your keys never leave this machine</div>
      </div>
    </div>
    ${saved ? `<div style="color:#4ade80;font-size:0.82rem;margin-bottom:1rem;padding:0.6rem 0.85rem;background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.2);border-radius:8px">✓ Settings saved. Restart the trader processes for key changes to take effect.</div>` : ""}
    ${schwabAuthorized ? `<div style="color:#fbbf24;font-size:0.82rem;margin-bottom:1rem;padding:0.6rem 0.85rem;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:8px">✓ Schwab authorized successfully. Tokens stored and ready.</div>` : ""}
    ${error ? `<div style="color:#f87171;font-size:0.82rem;margin-bottom:1rem">${error}</div>` : ""}
    <form method="POST" action="/settings">

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem;margin-bottom:1rem">


        ${section("General", "⚙️", `
          ${field("Default Margin to Risk (USD)", "HL_POSITION_SIZE_USD", val("HL_POSITION_SIZE_USD") || "10", "text", "Margin per trade — notional = margin × leverage. Used when a strategy has no size override.")}
        `)}

        ${section("Hyperliquid", "⚡", `
          ${field("Private Key", "AGENT_PRIVATE_KEY", val("AGENT_PRIVATE_KEY"), "password", "0x-prefixed EVM key — trading + x402 payments")}
          <div id="walletInfo" style="font-size:0.72rem;color:rgba(255,255,255,0.3);padding:0.5rem 0.75rem;background:rgba(255,255,255,0.03);border-radius:6px;display:none">
            Wallet: <span id="walletAddr" style="font-family:monospace;color:rgba(168,241,247,0.7)"></span>
          </div>
        `)}

        ${section("Kraken", "🦑", `
          ${field("API Key", "KRAKEN_API_KEY", val("KRAKEN_API_KEY"), "password")}
          ${field("API Secret", "KRAKEN_API_SECRET", val("KRAKEN_API_SECRET"), "password")}
        `)}

        ${section("Alpaca", "🦙", `
          ${field("API Key", "ALPACA_API_KEY", val("ALPACA_API_KEY"), "password")}
          ${field("API Secret", "ALPACA_API_SECRET", val("ALPACA_API_SECRET"), "password")}
          <div style="display:flex;align-items:center;gap:0.6rem">
            <input type="checkbox" name="ALPACA_PAPER" value="true" id="alpacaPaper" ${val("ALPACA_PAPER") === "true" ? "checked" : ""} style="width:auto;accent-color:#A8F1F7" />
            <label for="alpacaPaper" style="font-size:0.78rem;color:rgba(255,255,255,0.5);cursor:pointer">Paper trading mode</label>
          </div>
        `)}

        ${section("Coinbase", "🔵", `
          ${field("API Key", "COINBASE_API_KEY", val("COINBASE_API_KEY"), "password")}
          ${field("API Passphrase", "COINBASE_API_PASSPHRASE", val("COINBASE_API_PASSPHRASE"), "password")}
          ${pemField("API Secret (PEM)", "COINBASE_API_SECRET", val("COINBASE_API_SECRET"), "EC private key from Coinbase Advanced Trade — paste the full PEM block")}
        `)}

        ${section("AgentSignal Account", "🔑", `
          ${field("API Key", "AGENT_API_KEY", val("AGENT_API_KEY"), "password",
            "From agentsignal.app/account — verifies your subscription tier. Alpha &amp; Trader subscribers skip x402 on signal fetches and unlock Premium Fade signals.")}
          ${(function() {
            const keySet = !!val("AGENT_API_KEY");
            if (!keySet) return '<div style="font-size:0.72rem;color:rgba(255,255,255,0.3);margin-top:0.15rem">No key set — signal fetches use x402 ($0.01 each)</div>';
            return '<div style="font-size:0.72rem;color:rgba(74,222,128,0.7);margin-top:0.15rem">Key configured — tier verified on next dashboard load</div>';
          })()}
        `)}

        ${(function() {
          const current = getPaymentNetwork();
          const currentLabel = X402_NETWORKS[current]?.label ?? current;
          return section("Signal Payments (x402)", "💳", `
            <input type="hidden" name="X402_PAYMENT_NETWORK" id="x402NetworkInput" value="${current}" />
            <div>
              <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Payment Network</label>
              <button type="button" onclick="document.getElementById('networkModal').classList.add('open')"
                style="width:100%;display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#fafafa;font-size:0.85rem;padding:0.45rem 0.75rem;cursor:pointer;text-align:left">
                <span id="x402NetworkDisplay">${currentLabel}</span>
                <span style="color:rgba(255,255,255,0.3);font-size:0.75rem">Change ›</span>
              </button>
              <div style="font-size:0.68rem;color:rgba(255,255,255,0.3);margin-top:0.25rem">Your wallet must hold USDC on this network to pay for signal fetches.</div>
            </div>
          `);
        })()}

        ${(function() {
          const sc = getSchwabClient();
          const status = sc ? sc.tokenStatus() : null;
          const authUrl = sc ? sc.getAuthUrl() : null;
          const statusHtml = !sc
            ? `<div style="font-size:0.72rem;color:rgba(255,255,255,0.3);margin-top:0.25rem">Enter API Key + App Secret above and save first.</div>`
            : status?.authorized
              ? `<div style="font-size:0.72rem;padding:0.5rem 0.75rem;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.2);border-radius:6px;color:#4ade80;margin-top:0.25rem">
                  ✓ Authorized · refresh token expires in ${status.refreshDaysLeft} days
                  ${parseFloat(status.refreshDaysLeft) < 2 ? ' · <strong style="color:#f87171">Re-authorize soon</strong>' : ''}
                </div>`
              : `<div style="font-size:0.72rem;color:rgba(255,255,255,0.35);margin-top:0.25rem">Not yet authorized — click Authorize below.</div>`;
          return section("Schwab", "📈", `
            ${field("API Key (Client ID)", "SCHWAB_API_KEY", val("SCHWAB_API_KEY"), "password")}
            ${field("App Secret", "SCHWAB_APP_SECRET", val("SCHWAB_APP_SECRET"), "password")}
            ${field("Redirect URI", "SCHWAB_REDIRECT_URI", val("SCHWAB_REDIRECT_URI") || "https://127.0.0.1:4101/schwab/callback", "text",
              "Register this exact URL in your Schwab Developer app settings. Must match exactly.")}
            ${statusHtml}
            <div style="margin-top:0.6rem;padding:0.75rem;background:rgba(251,191,36,0.04);border:1px solid rgba(251,191,36,0.15);border-radius:8px;font-size:0.75rem;color:rgba(255,255,255,0.5);line-height:1.6">
              <strong style="color:rgba(255,255,255,0.7)">To authorize:</strong><br>
              1. Register <code style="color:#fbbf24">https://127.0.0.1:4101/schwab/callback</code> as your Redirect URI in the Schwab developer portal<br>
              2. Save your API Key + App Secret above<br>
              3. In your terminal run: <code style="color:#fbbf24">node schwab-auth.mjs</code><br>
              4. Approve in the browser that opens — tokens auto-saved
            </div>
          `);
        })()}

        ${section("Alchemy (Optional)", "🔮", `
          ${field("API Key", "ALCHEMY_API_KEY", val("ALCHEMY_API_KEY"), "password", "Required for Uniswap V4 positions and P&L history on the Uniswap tab.")}
          <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);line-height:1.6;padding:0.75rem;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px">
            <strong style="color:rgba(255,255,255,0.7);display:block;margin-bottom:0.35rem">What this unlocks</strong>
            <div style="display:flex;flex-direction:column;gap:0.3rem">
              <span>✓ <strong style="color:rgba(255,255,255,0.6)">V3 positions</strong> — works without a key (uses public Base RPC)</span>
              <span style="color:rgba(255,255,255,0.55)">↳ <strong style="color:#A8F1F7">V4 positions</strong> — requires Alchemy (NFT enumeration API)</span>
              <span style="color:rgba(255,255,255,0.55)">↳ <strong style="color:#A8F1F7">P&L history</strong> — requires Alchemy (Transfer history API)</span>
            </div>
            <div style="margin-top:0.6rem;padding-top:0.6rem;border-top:1px solid rgba(255,255,255,0.06)">
              Free tier is sufficient — get a key at
              <a href="https://www.alchemy.com" target="_blank" rel="noopener noreferrer" style="color:#A8F1F7;text-decoration:none">alchemy.com</a>,
              create a Base app, and paste the API key above.
            </div>
          </div>
        `)}

      </div>

      <div style="display:flex;gap:0.75rem;margin-top:0.5rem">
        <button type="submit" style="background:#A8F1F7;color:#09090b;border:none;border-radius:8px;padding:0.6rem 1.5rem;font-weight:700;cursor:pointer;font-size:0.875rem">
          Save Settings
        </button>
        <a href="/strategies" style="display:inline-flex;align-items:center;padding:0.6rem 1rem;font-size:0.82rem;color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);border-radius:8px;text-decoration:none">Cancel</a>
      </div>
    </form>

    <script>
    function toggleSecret(id) {
      const el = document.getElementById(id);
      const btn = el.nextElementSibling;
      if (el.type === 'password') { el.type = 'text'; btn.textContent = 'Hide'; }
      else { el.type = 'password'; btn.textContent = 'Show'; }
    }
    // Derive wallet address from private key if ethers is available
    const pkField = document.getElementById('field_AGENT_PRIVATE_KEY');
    async function updateWalletInfo() {
      const pk = pkField.value.trim();
      if (!pk.startsWith('0x') || pk.length !== 66) {
        document.getElementById('walletInfo').style.display = 'none';
        return;
      }
      try {
        const res = await fetch('/api/wallet-address', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ pk }) });
        const d = await res.json();
        if (d.address) {
          document.getElementById('walletAddr').textContent = d.address;
          document.getElementById('walletInfo').style.display = 'block';
        }
      } catch {}
    }
    pkField?.addEventListener('change', updateWalletInfo);
    updateWalletInfo();
    </script>
  `, "settings");
}

function addStrategyPage(error = "") {
  return shell("Add Strategy", `
    <p class="section-label">Add Strategy</p>
    <div class="card" style="max-width:480px">
      <p style="font-size:0.85rem;color:rgba(255,255,255,0.5);margin-bottom:1.25rem">
        Find your strategy ID at <a href="${getSignalUrl()}/navigator" target="_blank">agentsignal.app/navigator</a>
        → Load & Edit → copy the ID from the Live Signal URL.
      </p>
      ${error ? `<p style="color:#f87171;font-size:0.8rem;margin-bottom:1rem">${error}</p>` : ""}
      <form method="POST" action="/add-strategy" style="display:flex;flex-direction:column;gap:0.85rem">
        <div>
          <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Strategy ID</label>
          <input name="id" placeholder="ba5a1fbc-7196-..." required style="width:100%" />
        </div>
        <div>
          <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Name</label>
          <input name="name" placeholder="BTC Momentum" required style="width:100%" />
        </div>
        <div>
          <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Symbol</label>
          <input name="symbol" placeholder="BTC-USD" value="BTC-USD" style="width:100%" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
          <div>
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Margin to Risk (USD)</label>
            <input name="position_size_usd" type="number" placeholder="e.g. 50" style="width:100%" />
          </div>
          <div>
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Leverage</label>
            <select name="leverage" style="width:100%">
              <option value="1">1x</option><option value="2">2x</option><option value="3">3x</option>
              <option value="5">5x</option><option value="10">10x</option><option value="20">20x</option><option value="50">50x</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
          <div>
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Exchange</label>
            <select name="exchange" style="width:100%">
              <option value="hyperliquid">Hyperliquid (perps)</option>
              <option value="kraken">Kraken</option>
              <option value="alpaca">Alpaca</option>
              <option value="coinbase">Coinbase</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Check Every</label>
            <select name="interval_minutes" style="width:100%">
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60" selected>1 hour</option>
              <option value="120">2 hours</option>
              <option value="240">4 hours</option>
              <option value="1440">Daily</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
          <div>
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Take Profit %</label>
            <input name="tp_pct" type="number" step="0.5" min="0.5" placeholder="e.g. 5 (optional)" style="width:100%" />
            <p style="font-size:0.68rem;color:rgba(255,255,255,0.25);margin:0.25rem 0 0">% gain before trail activates</p>
          </div>
          <div>
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Trail Stop %</label>
            <input name="trail_pct" type="number" step="0.1" min="0.1" placeholder="e.g. 0.5 (optional)" style="width:100%" />
            <p style="font-size:0.68rem;color:rgba(255,255,255,0.25);margin:0.25rem 0 0">% drop from peak to close</p>
          </div>
        </div>
        <div id="as_exchange_hint" style="font-size:0.67rem;color:rgba(168,241,247,0.6);display:none;margin-top:-0.5rem">
          Scalper strategies require Hyperliquid.
        </div>
        <button type="submit" style="background:#A8F1F7;color:#09090b;border:none;border-radius:8px;padding:0.6rem 1.25rem;font-weight:600;cursor:pointer;font-size:0.875rem;margin-top:0.25rem">
          Add Strategy
        </button>
      </form>
    </div>
    <script>
    (function() {
      const idInput  = document.querySelector('input[name="id"]');
      const exchSel  = document.querySelector('select[name="exchange"]');
      const hint     = document.getElementById('as_exchange_hint');
      if (!idInput || !exchSel) return;

      async function checkScalper(id) {
        id = id.trim();
        if (!id) return;
        try {
          const r = await fetch('/api/strategy-details/' + encodeURIComponent(id));
          if (!r.ok) return;
          const def = await r.json();
          const parseJ = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };
          const entry = parseJ(def.long_entry) ?? parseJ(def.entry);
          const exit  = parseJ(def.long_exit)  ?? parseJ(def.exit);
          const conds = [...(entry?.conditions ?? []), ...(exit?.conditions ?? [])];
          const isScalper = conds.some(c => c.source === 'trigger');
          exchSel.disabled = isScalper;
          hint.style.display = isScalper ? 'block' : 'none';
          if (isScalper) exchSel.value = 'hyperliquid';
        } catch {}
      }

      idInput.addEventListener('blur', e => checkScalper(e.target.value));
      // Re-enable before POST so the value is submitted
      idInput.closest('form').addEventListener('submit', () => { exchSel.disabled = false; });
    })();
    </script>
  `, "strategies");
}

// ── Local price-threshold evaluation (no x402) ───────────────────────────────

function computeRSIDash(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function computeSMADash(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function computeEMADash(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

async function tryLocalEvalDash(strategy) {
  try {
    const res = await fetch(`${getSignalUrl()}/api/strategy/${strategy.id}`);
    if (!res.ok) return null;
    const def = await res.json();
    const parseJ = v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return v; } };
    const hasConditions = r => r?.conditions?.length > 0;
    const entry      = hasConditions(parseJ(def.long_entry))  ? parseJ(def.long_entry)  : parseJ(def.entry);
    const exit       = hasConditions(parseJ(def.long_exit))   ? parseJ(def.long_exit)   : parseJ(def.exit);
    const shortEntry = hasConditions(parseJ(def.short_entry)) ? parseJ(def.short_entry) : null;
    const shortExit  = hasConditions(parseJ(def.short_exit))  ? parseJ(def.short_exit)  : null;

    const allConds = [
      ...(entry?.conditions ?? []), ...(exit?.conditions ?? []),
      ...(shortEntry?.conditions ?? []), ...(shortExit?.conditions ?? []),
    ];
    if (!allConds.length) return null;

    const priceFlds      = new Set(["close", "price", "last", "mark", "open", "high", "low"]);
    const indicatorFlds  = new Set(["rsi", "sma", "ema"]);
    const passthroughFlds = new Set(["pct_above_entry", "pct_below_entry"]);
    const knownFlds      = new Set([...priceFlds, ...indicatorFlds, ...passthroughFlds]);
    if (!allConds.every(c => knownFlds.has((c.field ?? "close").toLowerCase()))) return null;

    const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
    const { KrakenExchange }      = await import("./exchanges/kraken.mjs");
    const { AlpacaExchange }      = await import("./exchanges/alpaca.mjs");
    const exch = strategy.exchange === "kraken"
      ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
      : strategy.exchange === "alpaca"
      ? new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true")
      : new HyperliquidExchange(PRIVATE_KEY);

    const asset = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
    const needsCandles = allConds.some(c => indicatorFlds.has((c.field ?? "close").toLowerCase()));

    const [price, position] = await Promise.all([
      exch.getMidPrice(asset),
      exch.getPosition(asset).catch(() => null),
    ]);
    if (!price) return null;
    const hasPosition = parseFloat(position?.szi ?? "0") !== 0;

    // Compute indicators from candles if needed
    const indicatorValues = {};
    if (needsCandles && typeof exch.getCandles === "function") {
      const MINS_TO_IV = { 1:"1m",3:"3m",5:"5m",15:"15m",30:"30m",60:"1h",120:"2h",240:"4h",480:"8h",720:"12h",1440:"1d" };
      // navigator (source=price) → daily candles; scalper (source=trigger) → condition interval
      const defaultInterval = allConds.some(c => c.source === "trigger")
        ? (MINS_TO_IV[strategy.interval_minutes ?? 60] ?? "1h")
        : "1d";
      const intervals = new Set(allConds.map(c => c.interval ?? defaultInterval));
      const candlesByInterval = {};
      for (const iv of intervals) {
        const candles = await exch.getCandles(asset, iv, 100);
        candlesByInterval[iv] = candles.map(c => parseFloat(c.c));
      }
      for (const c of allConds) {
        const field  = (c.field ?? "close").toLowerCase();
        if (!indicatorFlds.has(field)) continue;
        const iv     = c.interval ?? defaultInterval;
        const period = parseInt(c.period ?? 14);
        const key    = `${field}_${period}_${iv}`;
        if (indicatorValues[key] !== undefined) continue;
        const closes = candlesByInterval[iv];
        if (!closes?.length) continue;
        switch (field) {
          case "rsi": indicatorValues[key] = computeRSIDash(closes, period); break;
          case "sma": indicatorValues[key] = computeSMADash(closes, period); break;
          case "ema": indicatorValues[key] = computeEMADash(closes, period); break;
        }
      }
    }

    const defaultInterval = allConds.some(c => c.source === "trigger")
      ? ({ 1:"1m",3:"3m",5:"5m",15:"15m",30:"30m",60:"1h",120:"2h",240:"4h",480:"8h",720:"12h",1440:"1d" }[strategy.interval_minutes ?? 60] ?? "1h")
      : "1d";

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

    // Funding gate (fail-closed)
    const risk = parseJ(def.risk) ?? {};
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
      } catch { /* fail closed */ }
    }
    const longGateOk  = risk.funding_long_gate  == null || (fundingRate !== null && fundingRate <= risk.funding_long_gate);
    const shortGateOk = risk.funding_short_gate == null || (fundingRate !== null && fundingRate >= risk.funding_short_gate);

    let signal;
    if (shortEntry) {
      if (hasPosition) {
        const isLong = parseFloat(position?.szi ?? "0") > 0;
        signal = isLong
          ? (evalRules(exit)      ? "FLAT" : "LONG")
          : (evalRules(shortExit) ? "FLAT" : "SHORT");
      } else {
        if      (evalRules(entry)      && longGateOk)  signal = "LONG";
        else if (evalRules(shortEntry) && shortGateOk) signal = "SHORT";
        else                                            signal = "FLAT";
      }
    } else {
      signal = hasPosition
        ? (evalRules(exit)  ? "FLAT" : "LONG")
        : (evalRules(entry) ? "LONG" : "FLAT");
    }

    return { signal, price };
  } catch {
    return null;
  }
}

// ── API handlers ──────────────────────────────────────────────────────────────

async function handleClose(body) {
  const { asset, exchange } = JSON.parse(body);

  // Find matching strategy for trade record
  const strategy = getStrategies().find(s =>
    s.symbol.replace(/-USD$/, "").replace(/\/USD$/, "") === asset &&
    (s.exchange ?? "hyperliquid") === (exchange ?? "hyperliquid")
  );

  if (exchange === "alpaca") {
    if (!process.env.ALPACA_API_KEY) return { ok: false, error: "ALPACA_API_KEY not set" };
    const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
    const alp = new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true");
    const position = await alp.getPosition(asset).catch(() => null);
    const result = await alp.closePosition(asset);
    if (strategy && position) {
      const size = Math.abs(parseFloat(position?.szi ?? "0"));
      const entryPx = parseFloat(position?.entryPx ?? "0");
      const midPrice = await alp.getMidPrice(asset).catch(() => 0);
      const pnl = size && entryPx ? parseFloat(((midPrice - entryPx) * size).toFixed(2)) : null;
      const { insertTrade } = await import("./db.mjs");
      insertTrade({ strategy_id: strategy.id, action: `CLOSED ${asset} @ ~$${midPrice.toLocaleString()} [manual]`, asset, size, price: midPrice, leverage: strategy.leverage ?? 1, pnl });
    }
    return { ok: true, asset, result };
  }

  if (!PRIVATE_KEY) return { ok: false, error: "AGENT_PRIVATE_KEY not set" };
  const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
  const exch = new HyperliquidExchange(PRIVATE_KEY);
  const position = await exch.getPosition(asset).catch(() => null);
  const midPrice = await exch.getMidPrice(asset).catch(() => 0);
  const result = await exch.closePosition(asset);
  if (strategy && position) {
    const size = Math.abs(parseFloat(position?.szi ?? "0"));
    const entryPx = parseFloat(position?.entryPx ?? "0");
    const dir = parseFloat(position?.szi ?? "0") >= 0 ? 1 : -1;
    const pnl = size && entryPx ? parseFloat(((midPrice - entryPx) * size * dir).toFixed(2)) : null;
    const { insertTrade } = await import("./db.mjs");
    insertTrade({ strategy_id: strategy.id, action: `CLOSED ${asset} @ ~$${midPrice.toLocaleString()} [manual]`, asset, size, price: midPrice, leverage: strategy.leverage ?? 1, pnl });
  }
  return { ok: true, asset, result };
}

async function handleToggle(body) {
  const { id, active } = JSON.parse(body);
  setStrategyActive(id, active);
  return { ok: true };
}

async function handleSubscribeStrategy(body) {
  if (!PRIVATE_KEY) return { ok: false, error: "AGENT_PRIVATE_KEY not set" };
  const { strategy_id, interval_minutes, period } = JSON.parse(body);
  if (!strategy_id || !interval_minutes || !period) return { ok: false, error: "strategy_id, interval_minutes, period required" };

  const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
  const days = PERIOD_DAYS[period];
  if (!days) return { ok: false, error: "Invalid period" };

  const url = `${getSignalUrl()}/api/strategy/${strategy_id}/subscribe?interval_minutes=${interval_minutes}&period=${period}`;

  const { x402Client } = await import("@x402/core/client");
  const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { http, createWalletClient } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const allChains = await import("viem/chains");

  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = new x402Client();

  const probe = await fetch(url, { method: "POST", headers: { "X-Wallet-Address": account.address } });
  if (probe.ok) return await probe.json();
  if (probe.status !== 402) throw new Error(`Subscribe API ${probe.status}`);

  const rawHeader = probe.headers.get("payment-required") ?? probe.headers.get("X-PAYMENT-REQUIRED");
  if (!rawHeader) throw new Error("No payment-required header in 402 response");
  const paymentRequired = decodePaymentRequiredHeader(rawHeader);

  const serverNetwork = paymentRequired.accepts?.[0]?.network ?? paymentRequired.accepts?.network;
  const networkCfg = X402_NETWORKS[serverNetwork] ?? X402_NETWORKS[getPaymentNetwork()] ?? X402_NETWORKS["eip155:8453"];
  const chain = allChains[networkCfg.viemChain];
  const walletClient = createWalletClient({ account, chain, transport: http(networkCfg.rpc) });
  const signer = Object.assign(walletClient, { address: account.address });
  client.register(serverNetwork, new ExactEvmScheme(signer));

  const calls = Math.round((60 / interval_minutes) * 24 * days);
  const priceUsd = (Math.round(calls * 0.01 * 100) / 100).toFixed(2);
  console.log(`[subscribe] 💳 Paying $${priceUsd} USDC on ${networkCfg.label ?? serverNetwork}`);

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeader = encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetch(url, { method: "POST", headers: { "payment-signature": paymentHeader, "X-Wallet-Address": account.address } });
  if (!paid.ok) {
    const errBody = await paid.text().catch(() => "");
    throw new Error(`Payment rejected (${paid.status}): ${errBody.slice(0, 200)}`);
  }
  return await paid.json();
}

async function handleExecute(body) {
  if (!PRIVATE_KEY) return { ok: false, error: "AGENT_PRIVATE_KEY not set" };
  const { id } = JSON.parse(body);
  const strategy = getStrategy(id);
  if (!strategy) return { ok: false, error: "Strategy not found" };

  const latest = getLatestSignal(id);
  if (!latest) return { ok: false, error: "No signal available. Run the trader first." };

  const { placeMarketOrder, closePosition, getPosition, getMidPrice, setLeverage } = await import("./hyperliquid.mjs");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(PRIVATE_KEY);

  const hlAsset = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  const leverage = strategy.leverage ?? 1;
  const sizeUsd  = strategy.position_size_usd ?? parseFloat(process.env.HL_POSITION_SIZE_USD ?? "10");
  const midPrice = await getMidPrice(hlAsset);
  const positionSize = parseFloat(((sizeUsd * leverage) / midPrice).toFixed(5));
  const position = await getPosition(account.address, hlAsset);
  const currentSize = parseFloat(position?.szi ?? "0");
  const isFlat = currentSize === 0;
  const isLong = currentSize > 0;
  const signal = latest.signal;

  let action = "HOLD";
  let result = null;

  if (signal === "LONG" && isFlat) {
    await setLeverage(PRIVATE_KEY, hlAsset, leverage);
    result = await placeMarketOrder(PRIVATE_KEY, hlAsset, "buy", positionSize);
    action = `ENTERED LONG ${positionSize} ${hlAsset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
  } else if ((signal === "FLAT" || signal === "SHORT") && !isFlat) {
    result = await closePosition(PRIVATE_KEY, hlAsset);
    action = `CLOSED ${Math.abs(currentSize)} ${hlAsset}`;
    if (signal === "SHORT") {
      await setLeverage(PRIVATE_KEY, hlAsset, leverage);
      result = await placeMarketOrder(PRIVATE_KEY, hlAsset, "sell", positionSize);
      action = `SHORTED ${positionSize} ${hlAsset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
    }
  } else {
    action = `HOLD — signal ${signal}, position ${currentSize}`;
  }

  return { ok: true, action };
}

async function handleRun(body) {
  if (!PRIVATE_KEY) return { ok: false, error: "AGENT_PRIVATE_KEY not set" };
  const { id } = JSON.parse(body);
  const strategy = getStrategy(id);
  if (!strategy) return { ok: false, error: "Strategy not found" };

  // Try local price evaluation first (free, no x402 cost)
  let signalData = await tryLocalEvalDash(strategy);

  if (!signalData) {
    // Fall back to x402 fetch
    const { x402Client } = await import("@x402/core/client");
    const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
    const { ExactEvmScheme } = await import("@x402/evm/exact/client");
    const { http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const allChains = await import("viem/chains");

    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = new x402Client();

    const defForUrl = await fetch(`${getSignalUrl()}/api/strategy/${id}`).then(r => r.ok ? r.json() : null).catch(() => null);
    const isScalperStrategy = defForUrl?.risk?.mode === "scalp";
    const url = isScalperStrategy
      ? `${getSignalUrl()}/api/scalper/${id}/signal`
      : `${getSignalUrl()}/api/strategy/${id}/signal`;
    try {
      const probe = await fetch(url);
      console.log(`[run-strategy] probe status: ${probe.status}`);
      if (probe.ok) {
        signalData = await probe.json();
      } else if (probe.status === 402) {
        const rawHeader = probe.headers.get("payment-required") ?? probe.headers.get("X-PAYMENT-REQUIRED");
        if (!rawHeader) throw new Error("No payment-required header in 402 response");
        const paymentRequired = decodePaymentRequiredHeader(rawHeader);

        const serverNetwork = paymentRequired.accepts?.[0]?.network ?? paymentRequired.accepts?.network;
        const networkCfg = X402_NETWORKS[serverNetwork] ?? X402_NETWORKS[getPaymentNetwork()] ?? X402_NETWORKS["eip155:8453"];
        const chain = allChains[networkCfg.viemChain];
        const walletClient = (await import("viem")).createWalletClient({ account, chain, transport: http(networkCfg.rpc) });
        const signer = Object.assign(walletClient, { address: account.address });
        client.register(serverNetwork, new ExactEvmScheme(signer));

        console.log(`[run-strategy] 💳 Paying on ${networkCfg.label ?? serverNetwork}`);
        const paymentPayload = await client.createPaymentPayload(paymentRequired);
        const paymentHeader = encodePaymentSignatureHeader(paymentPayload);
        const paid = await fetch(url, { headers: { "payment-signature": paymentHeader } });
        console.log(`[run-strategy] paid status: ${paid.status}`);
        if (paid.ok) {
          signalData = await paid.json();
        } else {
          const errBody = await paid.text().catch(() => "");
          throw new Error(`Payment rejected (${paid.status}): ${errBody.slice(0, 200)}`);
        }
      } else {
        throw new Error(`Unexpected probe status: ${probe.status}`);
      }
    } catch (err) {
      console.error(`[run-strategy] signal fetch error:`, err.message);
      return { ok: false, error: `Could not fetch signal: ${err.message}` };
    }
    if (!signalData) return { ok: false, error: "Could not fetch signal from AgentSignal" };
  }

  const signal = signalData.signal;
  const price  = signalData.price ?? null;
  const priorSignal = getLatestSignal(id);

  // Build notes from scores (same logic as trader.mjs)
  const c = signalData.compass;
  const scoreNotes = [
    c?.score            != null ? `COMPASS:${c.score}` : null,
    c?.radar_score      != null ? `RADAR:${c.radar_score}` : null,
    c?.crypto_radar_score != null ? `CRYPTO:${c.crypto_radar_score}` : null,
  ].filter(Boolean).join(" | ");

  // Save signal
  const { upsertSignal } = await import("./db.mjs");
  upsertSignal({ strategy_id: id, signal, price, date: signalData.date ?? new Date().toISOString().slice(0,10), notes: scoreNotes || null });

  // Only execute on flip (or first ever signal that's actionable)
  const prev = priorSignal?.signal ?? null;
  const isFlip = signal !== prev;
  const shouldAct = isFlip && (signal === "LONG" || signal === "SHORT" || (signal === "FLAT" && prev !== null));
  if (!shouldAct) return { ok: true, action: `Signal is ${signal} (no change from ${prev ?? "none"}) — no trade executed` };

  // Execute trade via exchange abstraction
  const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
  const { KrakenExchange } = await import("./exchanges/kraken.mjs");
  const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
  const exch = strategy.exchange === "kraken"
    ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
    : strategy.exchange === "alpaca"
    ? new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true")
    : new HyperliquidExchange(PRIVATE_KEY);

  const asset    = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  const leverage = strategy.leverage ?? 1;
  const sizeUsd  = strategy.position_size_usd ?? parseFloat(process.env.HL_POSITION_SIZE_USD ?? "10");
  const midPrice = await exch.getMidPrice(asset);
  const positionSize = parseFloat(((sizeUsd * leverage) / midPrice).toFixed(5));
  const position = await exch.getPosition(asset);
  const currentSize  = parseFloat(position?.szi ?? "0");
  const entryPrice   = parseFloat(position?.entryPx ?? "0");
  const isLong       = currentSize > 0;
  const isFlat       = currentSize === 0;

  let action = "HOLD";
  let pnl    = null;
  if (signal === "LONG" && isFlat) {
    await exch.setLeverage(asset, leverage);
    await exch.placeMarketOrder(asset, "buy", positionSize);
    action = `ENTERED LONG ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
  } else if (signal === "FLAT" && !isFlat) {
    if (entryPrice > 0) {
      const dir = isLong ? 1 : -1;
      pnl = parseFloat(((midPrice - entryPrice) * Math.abs(currentSize) * dir).toFixed(2));
    }
    await exch.closePosition(asset);
    action = `CLOSED ${Math.abs(currentSize)} ${asset} @ ~$${midPrice.toLocaleString()}`;
  } else if (signal === "SHORT" && !isFlat) {
    if (entryPrice > 0 && isLong) {
      pnl = parseFloat(((midPrice - entryPrice) * Math.abs(currentSize)).toFixed(2));
    }
    await exch.closePosition(asset);
    await exch.setLeverage(asset, leverage);
    await exch.placeMarketOrder(asset, "sell", positionSize);
    action = `SHORTED ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`;
  }

  const { insertTrade } = await import("./db.mjs");
  insertTrade({ strategy_id: id, action, asset, size: positionSize, price: midPrice, leverage, pnl });
  return { ok: true, action };
}

async function handleOpen(body) {
  const { id, side, limitPrice } = JSON.parse(body);
  if (side !== "buy" && side !== "sell") return { ok: false, error: "side must be buy or sell" };
  if (limitPrice !== undefined && (typeof limitPrice !== "number" || limitPrice <= 0)) return { ok: false, error: "limitPrice must be a positive number" };
  const strategy = getStrategy(id);
  if (!strategy) return { ok: false, error: "Strategy not found" };

  const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
  const { KrakenExchange } = await import("./exchanges/kraken.mjs");
  const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
  const { CoinbaseExchange } = await import("./exchanges/coinbase.mjs");
  const exch = strategy.exchange === "kraken"
    ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
    : strategy.exchange === "alpaca"
    ? new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true")
    : strategy.exchange === "coinbase"
    ? new CoinbaseExchange(process.env.COINBASE_API_KEY, process.env.COINBASE_API_SECRET, process.env.COINBASE_API_PASSPHRASE)
    : new HyperliquidExchange(PRIVATE_KEY);

  const asset    = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  const leverage = strategy.leverage ?? 1;
  const sizeUsd  = strategy.position_size_usd ?? parseFloat(process.env.HL_POSITION_SIZE_USD ?? "10");
  const midPrice = await exch.getMidPrice(asset);
  const positionSize = parseFloat(((sizeUsd * leverage) / midPrice).toFixed(5));
  const position = await exch.getPosition(asset);
  const currentSize = parseFloat(position?.szi ?? "0");

  if (currentSize !== 0) await exch.closePosition(asset);
  await exch.setLeverage(asset, leverage);
  if (limitPrice) {
    await exch.placeLimitOrder(asset, side, positionSize, limitPrice);
  } else {
    await exch.placeMarketOrder(asset, side, positionSize);
  }
  const orderType = limitPrice ? `limit @ $${limitPrice.toLocaleString()}` : `market @ ~$${midPrice.toLocaleString()}`;
  const action = `${side === "buy" ? "ENTERED LONG" : "SHORTED"} ${positionSize} ${asset} (${orderType}, ${leverage}x) [manual]`;

  const { insertTrade } = await import("./db.mjs");
  insertTrade({ strategy_id: id, action, asset, size: positionSize, price: midPrice, leverage });
  return { ok: true, action };
}

async function handleAddToPosition(body) {
  const { asset, exchange, side, sizeUsd } = JSON.parse(body);
  if (!asset || !side || !sizeUsd || sizeUsd <= 0) return { ok: false, error: "asset, side, sizeUsd required" };

  const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
  const { KrakenExchange }      = await import("./exchanges/kraken.mjs");
  const { AlpacaExchange }      = await import("./exchanges/alpaca.mjs");
  const { CoinbaseExchange }    = await import("./exchanges/coinbase.mjs");
  const exch = exchange === "kraken"
    ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
    : exchange === "alpaca"
    ? new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true")
    : exchange === "coinbase"
    ? new CoinbaseExchange(process.env.COINBASE_API_KEY, process.env.COINBASE_API_SECRET, process.env.COINBASE_API_PASSPHRASE)
    : new HyperliquidExchange(PRIVATE_KEY);

  const midPrice = await exch.getMidPrice(asset);
  const size = parseFloat((sizeUsd / midPrice).toFixed(5));
  await exch.placeMarketOrder(asset, side, size);
  const action = `ADD ${side === "buy" ? "LONG" : "SHORT"} +${size} ${asset} @ ~$${midPrice.toLocaleString()} ($${sizeUsd})`;
  const { insertTrade } = await import("./db.mjs");
  insertTrade({ strategy_id: "manual", action, asset, size, price: midPrice, leverage: 1 });
  return { ok: true, action };
}

async function handleCancelOrder(body) {
  const { exchange, orderId, asset } = JSON.parse(body);
  const exch = await getExchangeInstance(exchange);
  await exch.cancelOrder(orderId, asset);
  return { ok: true };
}

async function handleEditOrder(body) {
  const { exchange, orderId, asset, side, size, limitPrice, duration } = JSON.parse(body);
  const exch = await getExchangeInstance(exchange);
  await exch.editOrder(orderId, asset, side, size, limitPrice, duration);
  return { ok: true };
}

async function getExchangeInstance(exchange) {
  const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
  const { KrakenExchange } = await import("./exchanges/kraken.mjs");
  const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
  const { CoinbaseExchange } = await import("./exchanges/coinbase.mjs");
  const { SchwabExchange } = await import("./exchanges/schwab.mjs");
  return exchange === "Kraken"
    ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
    : exchange === "Alpaca"
    ? new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true")
    : exchange === "Coinbase"
    ? new CoinbaseExchange(process.env.COINBASE_API_KEY, process.env.COINBASE_API_SECRET, process.env.COINBASE_API_PASSPHRASE)
    : exchange === "Schwab"
    ? new SchwabExchange(process.env.SCHWAB_API_KEY, process.env.SCHWAB_APP_SECRET)
    : new HyperliquidExchange(PRIVATE_KEY);
}



// ── Premium Fade Page ────────────────────────────────────────────────────────

async function premiumFadePage() {
  const user = await getAgentSignalUser();

  if (!process.env.AGENT_API_KEY) {
    return shell("Premium Fade", `
      <div class="card" style="text-align:center;padding:3rem">
        <div style="font-size:2rem;margin-bottom:1rem">🔑</div>
        <p style="color:rgba(255,255,255,0.5);margin-bottom:1rem">Add your AgentSignal API key in Settings to access Premium Fade signals.</p>
        <a href="/settings" style="color:#A8F1F7;font-size:0.82rem">Go to Settings →</a>
      </div>`, "premium-fade");
  }

  if (!user?.valid || user.tier !== "alpha") {
    const tierLabel = user?.tier ?? "unknown";
    return shell("Premium Fade", `
      <div class="card" style="text-align:center;padding:3rem">
        <div style="font-size:2rem;margin-bottom:1rem">🚫</div>
        <p style="color:rgba(255,255,255,0.5);margin-bottom:0.5rem">Premium Fade signals require an <strong style="color:#fbbf24">Alpha</strong> subscription.</p>
        <p style="color:rgba(255,255,255,0.3);font-size:0.78rem;margin-bottom:1rem">Your current tier: <strong>${tierLabel}</strong></p>
        <a href="https://agentsignal.app/account" target="_blank" rel="noopener noreferrer" style="color:#A8F1F7;font-size:0.82rem">Upgrade at agentsignal.app →</a>
      </div>`, "premium-fade");
  }

  let signals = { recent: [], open: [], tickers: [], noTickers: false };
  let fetchError = null;
  try {
    const res = await fetch(`${getSignalUrl()}/api/premium-fade/my`, {
      headers: { "Authorization": "Bearer " + process.env.AGENT_API_KEY },
    });
    const data = await res.json();
    if (!res.ok) fetchError = data.error ?? "API returned " + res.status;
    else signals = data;
  } catch (e) { fetchError = e.message; }

  const schwab = getSchwabClient();
  const schwabReady = !!schwab?.isAuthorized();

  // Fetch short option positions from Schwab
  let shortOptionPositions = [];
  if (schwabReady) {
    try {
      const raw = await schwab.getAccounts(true);
      const accounts = Array.isArray(raw) ? raw : [];
      for (const a of accounts) {
        for (const p of (a.securitiesAccount?.positions ?? [])) {
          if (p.instrument?.assetType === "OPTION" && parseFloat(p.shortQuantity ?? 0) > 0) {
            shortOptionPositions.push(p);
          }
        }
      }
    } catch {}
  }

  // Parse OCC symbol → { underlying, expiry, type, strike }
  function parseOCC(sym) {
    const root   = sym.slice(0, 6).trim();
    const expiry = "20" + sym.slice(6, 8) + "-" + sym.slice(8, 10) + "-" + sym.slice(10, 12);
    const type   = sym[12] === "C" ? "call" : "put";
    const strike = parseInt(sym.slice(13), 10) / 1000;
    return { underlying: root, expiry, type, strike };
  }

  // Build a lookup map: "TICKER|type|strike|expiry" → signal
  const signalMap = {};
  for (const s of (signals.open ?? [])) {
    if (s.ticker && s.option_type && s.strike && s.expiration) {
      const key = s.ticker + "|" + s.option_type + "|" + parseFloat(s.strike) + "|" + s.expiration;
      signalMap[key] = s;
    }
  }

  const positionRows = shortOptionPositions.map(p => {
    const sym      = p.instrument?.symbol ?? "";
    const occ      = parseOCC(sym);
    const shortQty = parseFloat(p.shortQuantity ?? 0);
    const entry    = parseFloat(p.averagePrice ?? 0);
    const mv       = parseFloat(p.marketValue ?? 0);          // negative = liability
    const current  = shortQty > 0 ? Math.abs(mv) / shortQty / 100 : 0;
    const unrealPnl = (entry - current) * shortQty * 100;
    const dayPnl   = parseFloat(p.currentDayProfitLoss ?? 0);
    const typeColor = occ.type === "call" ? "#4ade80" : "#f87171";
    const pnlColor  = unrealPnl >= 0 ? "#4ade80" : "#f87171";
    const key = occ.underlying + "|" + occ.type + "|" + occ.strike + "|" + occ.expiry;
    const sig = signalMap[key];
    const targetCell = sig?.target_price != null
      ? `<span style="color:#4ade80">$${parseFloat(sig.target_price).toFixed(2)}</span>`
      : "—";
    const stopCell = sig?.stop_price != null
      ? `<span style="color:#f87171">$${parseFloat(sig.stop_price).toFixed(2)}</span>`
      : "—";
    const closeBtn = `<button onclick="openFadeModal('${occ.underlying}','${occ.type}',${occ.strike},'${occ.expiry}','BUY_TO_CLOSE',this)" style="font-size:0.68rem;padding:0.2rem 0.6rem;border-radius:5px;border:1px solid rgba(248,113,113,0.35);background:rgba(248,113,113,0.07);color:#f87171;cursor:pointer;white-space:nowrap">Close</button>`;
    return `<tr>
      <td style="font-weight:600">${occ.underlying} <span style="color:rgba(255,255,255,0.35);font-size:0.72rem">$${occ.strike % 1 === 0 ? occ.strike.toFixed(0) : occ.strike.toFixed(2)} ${occ.type.toUpperCase()}</span></td>
      <td style="font-size:0.75rem;color:rgba(255,255,255,0.5)">${occ.expiry}</td>
      <td style="text-align:right">${shortQty}</td>
      <td style="text-align:right;color:#fbbf24">$${entry.toFixed(2)}</td>
      <td style="text-align:right;color:rgba(255,255,255,0.6)">$${current.toFixed(2)}</td>
      <td style="text-align:right;color:${pnlColor};font-weight:600">${unrealPnl >= 0 ? "+" : ""}$${Math.abs(unrealPnl).toFixed(2)}</td>
      <td style="text-align:right;color:${dayPnl >= 0 ? "#4ade80" : "#f87171"}">${dayPnl >= 0 ? "+" : ""}$${Math.abs(dayPnl).toFixed(2)}</td>
      <td style="text-align:right">${targetCell}</td>
      <td style="text-align:right">${stopCell}</td>
      <td>${closeBtn}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" style="color:rgba(255,255,255,0.25);text-align:center;padding:1rem">No written positions</td></tr>`;

  const statusColor = { open: "#A8F1F7", target_hit: "#4ade80", stopped_out: "#f87171", expired: "rgba(255,255,255,0.25)", closed: "rgba(255,255,255,0.4)" };
  const statusLabel = { open: "Open", target_hit: "Target Hit", stopped_out: "Stopped Out", expired: "Expired", closed: "Closed" };

  function signalRow(s) {
    const color = statusColor[s.status] ?? "rgba(255,255,255,0.5)";
    const label = statusLabel[s.status] ?? s.status;
    const isOpen = s.status === "open";
    const typeColor = s.option_type === "call" ? "#4ade80" : "#f87171";
    const vel = s.velocity_pct != null ? (s.velocity_pct > 0 ? "+" : "") + s.velocity_pct.toFixed(1) + "%" : "—";
    const iv  = s.curr_iv != null ? (s.curr_iv * 100).toFixed(1) + "%" : "—";
    const pnl = s.pnl != null ? (s.pnl >= 0 ? "+" : "") + "$" + Math.abs(s.pnl).toFixed(2) : "";
    const writeBtn = isOpen && schwabReady && s.ticker && s.option_type && s.strike && s.expiration
      ? `<button onclick="openFadeModal('${s.ticker}','${s.option_type}',${parseFloat(s.strike)},'${s.expiration}','SELL_TO_OPEN',this)" style="font-size:0.68rem;padding:0.2rem 0.6rem;border-radius:5px;border:1px solid rgba(251,191,36,0.35);background:rgba(251,191,36,0.07);color:#fbbf24;cursor:pointer;white-space:nowrap">Write</button>`
      : "";
    return `<tr style="${isOpen ? "" : "opacity:0.65"}">
      <td style="font-weight:600">${s.ticker}</td>
      <td style="color:${typeColor};font-weight:600">${(s.option_type ?? "").toUpperCase()}</td>
      <td>$${parseFloat(s.strike ?? 0).toFixed(0)}</td>
      <td style="font-size:0.75rem;color:rgba(255,255,255,0.55)">${s.expiration ?? "—"}</td>
      <td style="text-align:right">${s.dte ?? "—"}</td>
      <td style="text-align:right;color:${(s.velocity_pct ?? 0) > 0 ? "#4ade80" : "#f87171"}">${vel}</td>
      <td style="text-align:right">${iv}</td>
      <td style="text-align:right;color:#fbbf24">${s.entry_price != null ? "$" + parseFloat(s.entry_price).toFixed(2) : "—"}</td>
      <td style="text-align:right;color:#4ade80">${s.target_price != null ? "$" + parseFloat(s.target_price).toFixed(2) : "—"}</td>
      <td style="text-align:right;color:#f87171">${s.stop_price != null ? "$" + parseFloat(s.stop_price).toFixed(2) : "—"}</td>
      <td><span style="color:${color};font-size:0.72rem;font-weight:600">${label}</span></td>
      ${pnl ? `<td style="color:${s.pnl >= 0 ? "#4ade80" : "#f87171"};font-weight:600">${pnl}</td>` : "<td>—</td>"}
      <td>${writeBtn}</td>
    </tr>`;
  }

  const cols = 13;
  const openRows   = (signals.open   ?? []).map(signalRow).join("") || `<tr><td colspan="${cols}" style="color:rgba(255,255,255,0.25);text-align:center;padding:1rem">No open signals</td></tr>`;
  const recentRows = (signals.recent ?? []).map(signalRow).join("") || `<tr><td colspan="${cols}" style="color:rgba(255,255,255,0.25);text-align:center;padding:1rem">No recent closed signals</td></tr>`;

  const tableHead = `<thead><tr>
    <th>Ticker</th><th>Type</th><th>Strike</th><th>Expiry</th>
    <th style="text-align:right">DTE</th><th style="text-align:right">Velocity</th>
    <th style="text-align:right">IV</th><th style="text-align:right">Entry</th>
    <th style="text-align:right">Target</th><th style="text-align:right">Stop</th>
    <th>Status</th><th>P&L</th>${schwabReady ? "<th></th>" : ""}
  </tr></thead>`;

  return shell("Premium Fade", `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
      <div>
        <h1 style="font-size:1.5rem;font-weight:700;color:#fafafa;letter-spacing:-0.03em">Premium Fade Signals</h1>
        <p style="font-size:0.78rem;color:rgba(255,255,255,0.35);margin-top:0.2rem">${user.email} · ${user.tier}</p>
      </div>
      <a href="/premium-fade" style="font-size:0.78rem;color:rgba(255,255,255,0.4);padding:0.35rem 0.75rem;border:1px solid rgba(255,255,255,0.1);border-radius:6px;text-decoration:none">↻ Refresh</a>
    </div>
    <div style="display:flex;align-items:center;gap:1.25rem;margin-bottom:1.5rem">
      <span style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.35)">Exchange</span>
      <label style="display:flex;align-items:center;gap:0.45rem;cursor:pointer">
        <input type="radio" name="fadeExchange" value="Schwab" ${schwabReady ? "checked" : "disabled"}
          onchange="_fadeExchange=this.value"
          style="accent-color:#A8F1F7;width:14px;height:14px;cursor:pointer" />
        <span style="font-size:0.82rem;color:${schwabReady ? "#fafafa" : "rgba(255,255,255,0.3)"}">Schwab</span>
        ${!schwabReady ? `<span style="font-size:0.68rem;color:rgba(255,255,255,0.25)">(not connected)</span>` : ""}
      </label>
      <label style="display:flex;align-items:center;gap:0.45rem;cursor:not-allowed">
        <input type="radio" name="fadeExchange" value="Alpaca" disabled
          style="accent-color:#A8F1F7;width:14px;height:14px;cursor:not-allowed;opacity:0.3" />
        <span style="font-size:0.82rem;color:rgba(255,255,255,0.3)">Alpaca</span>
        <span style="font-size:0.68rem;color:rgba(255,255,255,0.2)">coming soon</span>
      </label>
    </div>
    ${fetchError ? `<div style="color:#f87171;margin-bottom:1rem;font-size:0.82rem">⚠ ${fetchError}</div>` : ""}
    ${signals.tickers?.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:1.25rem">${signals.tickers.map(t => `<span style="padding:0.15rem 0.55rem;border-radius:999px;background:rgba(168,241,247,0.08);border:1px solid rgba(168,241,247,0.2);font-size:0.72rem;color:#A8F1F7;font-weight:600">${t}</span>`).join("")}</div>` : ""}
    ${schwabReady ? `
    <div class="section-label">Positions</div>
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Contract</th><th>Expiry</th><th style="text-align:right">Qty</th>
          <th style="text-align:right">Entry</th><th style="text-align:right">Current</th>
          <th style="text-align:right">Unrealized P&L</th><th style="text-align:right">Day P&L</th>
          <th style="text-align:right">Target</th><th style="text-align:right">Stop</th><th></th>
        </tr></thead>
        <tbody>${positionRows}</tbody>
      </table>
    </div>` : ""}
    ${signals.noTickers ? `<div class="card" style="text-align:center;padding:2rem"><p style="color:rgba(255,255,255,0.4);margin-bottom:0.5rem">No tickers in your watchlist yet.</p><a href="${getSignalUrl()}/premium-fade" target="_blank" rel="noopener noreferrer" style="color:#A8F1F7;font-size:0.82rem">Add tickers at agentsignal.app/premium-fade →</a></div>` : `
    <div class="section-label">Active Signals</div>
    <div class="card" style="padding:0;overflow:hidden">
      <div style="overflow:auto;max-height:800px">
        <table style="min-width:100%">${tableHead}<tbody>${openRows}</tbody></table>
      </div>
    </div>
    <div class="section-label" style="margin-top:1.5rem">Signal History (30 days)</div>
    <div class="card" style="overflow-x:auto">
      <table>${tableHead}<tbody>${recentRows}</tbody></table>
    </div>`}

    ${schwabReady ? `
    <!-- Fade order modal (write + close) -->
    <div id="fadeWriteModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center">
      <div style="background:#111113;border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:1.75rem;max-width:380px;width:90%">
        <div id="fadeWriteTitle" style="font-size:1rem;font-weight:700;color:#fafafa;margin-bottom:1.25rem"></div>
        <div id="fadeWriteDetails" style="padding:0.85rem 1rem;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;font-size:0.85rem;color:rgba(255,255,255,0.75);line-height:1.8;margin-bottom:1rem"></div>
        <div style="margin-bottom:1rem">
          <label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.35rem">Limit Price</label>
          <input id="fadeWritePrice" type="number" step="0.01" min="0.01"
            oninput="updateFadeCredit()"
            style="width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:0.5rem 0.75rem;color:#fafafa;font-size:0.95rem;outline:none" />
          <div id="fadeWriteCredit" style="margin-top:0.4rem;font-size:0.78rem;color:rgba(255,255,255,0.4)"></div>
        </div>
        <div id="fadeWriteError" style="color:#f87171;font-size:0.75rem;margin-bottom:0.75rem;display:none"></div>
        <div style="display:flex;gap:0.5rem">
          <button onclick="closeFadeWrite()" style="flex:1;padding:0.55rem;border-radius:8px;background:transparent;border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.5);font-size:0.82rem;cursor:pointer">Cancel</button>
          <button id="fadeWriteSubmit" onclick="submitFadeWrite()" style="flex:1;padding:0.55rem;border-radius:8px;font-size:0.82rem;font-weight:600;cursor:pointer"></button>
        </div>
      </div>
    </div>
    <script>
    var _fadeData = null;
    var _fadeExchange = 'Schwab';

    async function openFadeModal(ticker, type, strike, expiry, instruction, btn) {
      var orig = btn.textContent;
      btn.disabled = true; btn.textContent = '…';
      try {
        var r = await fetch('/schwab/option-mid?ticker=' + encodeURIComponent(ticker) +
          '&type=' + encodeURIComponent(type) + '&strike=' + strike + '&expiry=' + encodeURIComponent(expiry));
        var d = await r.json();
        if (d.error) throw new Error(d.error);
        _fadeData = { ...d, instruction: instruction };

        var isSTO = instruction === 'SELL_TO_OPEN';
        var typeLabel = type[0].toUpperCase() + type.slice(1).toLowerCase();
        var accentColor = isSTO ? '#fbbf24' : '#f87171';

        document.getElementById('fadeWriteTitle').textContent = isSTO ? 'Sell to Open' : 'Buy to Close';
        document.getElementById('fadeWriteDetails').innerHTML =
          '<strong style="color:#fafafa">' + ticker + ' $' + strike + ' ' + typeLabel + '</strong>' +
          ' &nbsp;<span style="color:rgba(255,255,255,0.35);font-size:0.8rem">' + expiry + '</span><br>' +
          'Bid: <span style="color:rgba(255,255,255,0.6)">$' + d.bid.toFixed(2) + '</span>' +
          ' &nbsp;·&nbsp; Mid: <strong style="color:' + accentColor + '">$' + d.mid.toFixed(2) + '</strong>' +
          ' &nbsp;·&nbsp; Ask: <span style="color:rgba(255,255,255,0.6)">$' + d.ask.toFixed(2) + '</span>';

        var priceInput = document.getElementById('fadeWritePrice');
        priceInput.value = d.mid.toFixed(2);

        var submitBtn = document.getElementById('fadeWriteSubmit');
        submitBtn.textContent = isSTO ? 'Sell to Open' : 'Buy to Close';
        submitBtn.style.cssText = isSTO
          ? 'flex:1;padding:0.55rem;border-radius:8px;font-size:0.82rem;font-weight:600;cursor:pointer;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.35);color:#fbbf24'
          : 'flex:1;padding:0.55rem;border-radius:8px;font-size:0.82rem;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.35);color:#f87171';
        submitBtn.disabled = false;

        document.getElementById('fadeWriteError').style.display = 'none';
        updateFadeCredit();
        document.getElementById('fadeWriteModal').style.display = 'flex';
      } catch(e) {
        alert('Could not fetch price: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    }

    function updateFadeCredit() {
      if (!_fadeData) return;
      var price = parseFloat(document.getElementById('fadeWritePrice').value) || 0;
      var isSTO = _fadeData.instruction === 'SELL_TO_OPEN';
      var total = (price * 100).toFixed(2);
      document.getElementById('fadeWriteCredit').textContent = isSTO
        ? 'Credit: $' + total + ' per contract'
        : 'Cost: $' + total + ' per contract';
    }

    function closeFadeWrite() {
      document.getElementById('fadeWriteModal').style.display = 'none';
      _fadeData = null;
    }

    async function submitFadeWrite() {
      if (!_fadeData) return;
      var price = parseFloat(document.getElementById('fadeWritePrice').value);
      if (!price || price <= 0) {
        document.getElementById('fadeWriteError').textContent = 'Enter a valid limit price.';
        document.getElementById('fadeWriteError').style.display = 'block';
        return;
      }
      var btn = document.getElementById('fadeWriteSubmit');
      btn.disabled = true; btn.textContent = 'Placing…';
      document.getElementById('fadeWriteError').style.display = 'none';
      try {
        var r = await fetch('/schwab/write', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ optionSymbol: _fadeData.symbol, contracts: 1, limitPrice: price, instruction: _fadeData.instruction })
        });
        var d = await r.json();
        if (d.error) throw new Error(d.error);
        btn.textContent = '✓ Order placed';
        btn.style.color = '#4ade80';
        setTimeout(closeFadeWrite, 1200);
      } catch(e) {
        document.getElementById('fadeWriteError').textContent = e.message;
        document.getElementById('fadeWriteError').style.display = 'block';
        btn.disabled = false;
        btn.textContent = _fadeData.instruction === 'SELL_TO_OPEN' ? 'Sell to Open' : 'Buy to Close';
      }
    }
    </script>` : ""}
  `, "premium-fade");
}

// ── Uniswap Page ─────────────────────────────────────────────────────────────

function renderUniswapPage() {
  return shell("Uniswap Positions", `
<style>
.uni-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 1.5rem; }
@media (max-width: 640px) { .uni-summary { grid-template-columns: repeat(2, 1fr); } }
.uni-stat { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 0.85rem 1.1rem; }
.uni-stat .label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.4); margin-bottom: 0.3rem; }
.uni-stat .value { font-size: 1.2rem; font-weight: 700; letter-spacing: -0.02em; }
.uni-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.uni-table th { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.45); text-align: left; padding: 0.55rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: 600; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; }
.uni-table th:not(:first-child) { text-align: right; }
.uni-table td { padding: 0.7rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.06); color: rgba(255,255,255,0.85); vertical-align: middle; }
.uni-table td:not(:first-child) { text-align: right; }
.uni-table tbody tr { cursor: pointer; transition: background 0.12s; }
.uni-table tbody tr:hover td { background: rgba(255,255,255,0.04); }
.uni-badge-inrange { background: rgba(74,222,128,0.1); color: #4ade80; border: 1px solid rgba(74,222,128,0.25); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.68rem; font-weight: 600; white-space: nowrap; }
.uni-badge-outrange { background: rgba(248,113,113,0.1); color: #f87171; border: 1px solid rgba(248,113,113,0.25); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.68rem; font-weight: 600; white-space: nowrap; }
.uni-badge-closed { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.35); border: 1px solid rgba(255,255,255,0.1); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.68rem; white-space: nowrap; }
.uni-badge-v4 { background: rgba(167,139,250,0.12); color: #a78bfa; border: 1px solid rgba(167,139,250,0.25); padding: 0.12rem 0.4rem; border-radius: 4px; font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-left: 0.35rem; }
.uni-badge-v3 { background: rgba(99,179,237,0.1); color: #63b3ed; border: 1px solid rgba(99,179,237,0.25); padding: 0.12rem 0.4rem; border-radius: 4px; font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-left: 0.35rem; }
.uni-expand-row td { background: rgba(0,0,0,0.25); border-bottom: 1px solid rgba(255,255,255,0.08); }
.uni-detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.25rem; font-size: 0.78rem; }
@media (max-width: 640px) { .uni-detail-grid { grid-template-columns: 1fr; } }
.uni-detail-section .dlabel { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.4); margin-bottom: 0.5rem; }
.uni-detail-row { display: flex; justify-content: space-between; margin-bottom: 0.3rem; color: rgba(255,255,255,0.7); }
.uni-detail-row .dval { color: #fafafa; font-weight: 500; font-variant-numeric: tabular-nums; }
.uni-pnl-section { border-top: 1px solid rgba(255,255,255,0.08); margin-top: 1rem; padding-top: 1rem; }
.uni-pnl-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; font-size: 0.78rem; }
@media (max-width: 640px) { .uni-pnl-grid { grid-template-columns: repeat(2, 1fr); } }
.uni-pnl-item .plabel { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.4); margin-bottom: 0.3rem; }
.uni-pnl-item .pval { font-size: 0.95rem; font-weight: 700; color: #fafafa; }
.uni-pnl-item .psub { font-size: 0.7rem; color: rgba(255,255,255,0.35); margin-top: 0.15rem; }
.uni-collect-btn { font-size: 0.72rem; padding: 0.3rem 0.75rem; border-radius: 6px; border: 1px solid rgba(168,241,247,0.3); color: #A8F1F7; background: transparent; cursor: pointer; transition: background 0.15s; white-space: nowrap; }
.uni-collect-btn:hover:not(:disabled) { background: rgba(168,241,247,0.08); }
.uni-collect-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.uni-fees-box { margin-top: 0.75rem; padding: 0.75rem; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; font-size: 0.75rem; color: rgba(255,255,255,0.6); }
.uni-fees-box .flabel { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.35); margin-bottom: 0.4rem; margin-top: 0.6rem; }
.uni-fees-box .flabel:first-child { margin-top: 0; }
.uni-fees-row { display: flex; gap: 1.5rem; flex-wrap: wrap; }
.pos-avatar { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; font-size: 9px; font-weight: 700; color: #fff; flex-shrink: 0; }
.uni-loading-row td { text-align: center; padding: 3rem; color: rgba(255,255,255,0.4); font-size: 0.85rem; }
.uni-chevron { color: rgba(255,255,255,0.3); transition: transform 0.2s; display: inline-block; font-size: 0.7rem; }
.uni-chevron.open { transform: rotate(180deg); }
</style>

<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem">
  <div>
    <h1 style="font-size:1.5rem;font-weight:700;color:#fafafa;letter-spacing:-0.03em">Uniswap Positions</h1>
    <p id="uniWalletLine" style="font-size:0.78rem;color:rgba(255,255,255,0.4);margin-top:0.25rem">V3 + V4 · Base</p>
  </div>
  <button onclick="loadPositions()" id="uniRefreshBtn"
    style="display:flex;align-items:center;gap:0.4rem;padding:0.4rem 0.9rem;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:rgba(255,255,255,0.6);cursor:pointer;font-size:0.8rem;transition:all 0.15s"
    onmouseover="this.style.borderColor='rgba(255,255,255,0.25)';this.style.color='#fafafa'"
    onmouseout="this.style.borderColor='rgba(255,255,255,0.12)';this.style.color='rgba(255,255,255,0.6)'">
    <span id="uniRefreshIcon">↻</span> Refresh
  </button>
</div>

<div id="uniSummary" class="uni-summary" style="display:none">
  <div class="uni-stat"><div class="label">Positions</div><div class="value" id="sumCount" style="color:#fafafa">—</div></div>
  <div class="uni-stat"><div class="label">In Range</div><div class="value" id="sumInRange" style="color:#4ade80">—</div></div>
  <div class="uni-stat"><div class="label">Total Liquidity</div><div class="value" id="sumLiquidity" style="color:#a78bfa">—</div></div>
  <div class="uni-stat"><div class="label">Uncollected Fees</div><div class="value" id="sumFees" style="color:#A8F1F7">—</div></div>
</div>

<div id="uniError" style="display:none;align-items:center;gap:0.75rem;padding:0.85rem 1rem;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:8px;color:#f87171;font-size:0.82rem;margin-bottom:1rem">
  ⚠ <span id="uniErrorMsg"></span>
</div>

<div id="uniTableWrap" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;overflow:hidden">
  <table class="uni-table">
    <thead>
      <tr>
        <th style="text-align:left">Pair</th>
        <th style="text-align:left">Status</th>
        <th>Liquidity</th>
        <th>Fees</th>
        <th>Return</th>
        <th style="width:2rem"></th>
      </tr>
    </thead>
    <tbody id="uniTableBody">
      <tr class="uni-loading-row"><td colspan="6">Loading positions…</td></tr>
    </tbody>
  </table>
</div>

<script>
const _uniPositions = [];
let _uniAddress = '';

function uFmt(n, prefix) {
  if (n === null || n === undefined) return '—';
  const p = prefix !== undefined ? prefix : '$';
  return p + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}
function uFmtPnl(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  return (n >= 0 ? '+$' : '-$') + abs;
}
function uColorClass(n) { return n === null ? '' : n >= 0 ? 'color:#4ade80' : 'color:#f87171'; }
function uStatusBadge(pos) {
  if (!pos.hasLiquidity) return '<span class="uni-badge-closed">Closed</span>';
  if (pos.inRange === null) return '<span class="uni-badge-closed">Unknown</span>';
  return pos.inRange
    ? '<span class="uni-badge-inrange">In Range</span>'
    : '<span class="uni-badge-outrange">Out of Range</span>';
}
function uVersionBadge(v) {
  return v === 'v4' ? '<span class="uni-badge-v4">v4</span>' : '<span class="uni-badge-v3">v3</span>';
}

async function loadPositions() {
  const btn = document.getElementById('uniRefreshBtn');
  const icon = document.getElementById('uniRefreshIcon');
  icon.style.display = 'inline-block';
  icon.style.animation = 'spin 1s linear infinite';
  btn.disabled = true;
  document.getElementById('uniError').style.display = 'none';
  document.getElementById('uniSummary').style.display = 'none';
  document.getElementById('uniTableBody').innerHTML = '<tr class="uni-loading-row"><td colspan="6">Loading positions…</td></tr>';

  try {
    const [v3Res, v4Res] = await Promise.allSettled([
      fetch('/uniswap/positions').then(r => r.json()),
      fetch('/uniswap/v4/positions').then(r => r.json()),
    ]);

    const v3Positions = (v3Res.status === 'fulfilled' && v3Res.value.positions) ? v3Res.value.positions : [];
    const v4Positions = (v4Res.status === 'fulfilled' && v4Res.value.positions) ? v4Res.value.positions : [];
    const allPositions = [...v3Positions, ...v4Positions];

    _uniPositions.length = 0;
    allPositions.forEach(p => _uniPositions.push(p));

    // Get wallet address for display
    try {
      const addrRes = await fetch('/uniswap/wallet');
      const addrData = await addrRes.json();
      _uniAddress = addrData.address || '';
      const short = _uniAddress ? _uniAddress.slice(0,6) + '…' + _uniAddress.slice(-4) : '';
      document.getElementById('uniWalletLine').textContent = 'V3 + V4 · Base' + (short ? ' · ' + short : '');
    } catch {}

    if (allPositions.length === 0) {
      const noAlchemy = v4Res.status === 'fulfilled' && v4Res.value.noAlchemy;
      document.getElementById('uniTableBody').innerHTML =
        '<tr><td colspan="6" style="text-align:center;padding:3rem;color:rgba(255,255,255,0.35);font-size:0.85rem">' +
        'No Uniswap positions found on Base' +
        (noAlchemy ? '<br><span style="font-size:0.72rem;color:rgba(255,255,255,0.25)">Add ALCHEMY_API_KEY to .env to also check V4 positions</span>' : '') +
        '</td></tr>';
      return;
    }

    // Summary tiles
    const totalLiq = allPositions.reduce((s, p) => s + (p.totalLiquidityUsd ?? 0), 0);
    const totalFees = allPositions.reduce((s, p) => s + (p.totalFeesUsd ?? 0), 0);
    const inRangeCount = allPositions.filter(p => p.inRange).length;
    const hasPrices = allPositions.some(p => p.totalLiquidityUsd !== null);
    document.getElementById('sumCount').textContent = allPositions.length;
    document.getElementById('sumInRange').textContent = inRangeCount;
    document.getElementById('sumLiquidity').textContent = hasPrices ? uFmt(totalLiq) : '—';
    document.getElementById('sumFees').textContent = hasPrices ? uFmt(totalFees) : '—';
    document.getElementById('uniSummary').style.display = 'grid';

    // Render table
    renderUniTable(allPositions);
  } catch (e) {
    document.getElementById('uniErrorMsg').textContent = e.message || 'Failed to load positions';
    document.getElementById('uniError').style.display = 'flex';
    document.getElementById('uniTableBody').innerHTML = '<tr class="uni-loading-row"><td colspan="6" style="color:rgba(248,113,113,0.6)">Failed to load</td></tr>';
  } finally {
    icon.style.animation = '';
    btn.disabled = false;
  }
}

function renderUniTable(positions) {
  const tbody = document.getElementById('uniTableBody');
  if (!positions.length) {
    tbody.innerHTML = '<tr class="uni-loading-row"><td colspan="6">No positions found</td></tr>';
    return;
  }
  tbody.innerHTML = positions.map((p, idx) => {
    const avatarBg0 = ['#4f46e5','#7c3aed','#0891b2','#059669','#d97706'][idx % 5];
    const avatarBg1 = ['#7c3aed','#0891b2','#059669','#d97706','#4f46e5'][(idx + 2) % 5];
    const liqVal = p.totalLiquidityUsd !== null ? uFmt(p.totalLiquidityUsd) : '—';
    const liqSub = p.totalLiquidityUsd !== null && (p.amount0 > 0 || p.amount1 > 0)
      ? '<div style="font-size:0.68rem;color:rgba(255,255,255,0.35);margin-top:0.1rem">' +
        p.amount0.toFixed(3) + ' ' + p.token0.symbol + ' + ' + p.amount1.toFixed(3) + ' ' + p.token1.symbol + '</div>'
      : '';
    const feesColor = p.hasFees ? '#A8F1F7' : 'rgba(255,255,255,0.3)';
    const feesSub = p.hasFees
      ? '<div style="font-size:0.68rem;color:rgba(255,255,255,0.35);margin-top:0.1rem">' +
        parseFloat(p.fees0).toFixed(3) + ' ' + p.token0.symbol + ' + ' + parseFloat(p.fees1).toFixed(3) + ' ' + p.token1.symbol + '</div>'
      : '';

    return '<tr id="urow-' + p.tokenId + '" data-id="' + p.tokenId + '" onclick="toggleUniRow(this.dataset.id)">' +
      '<td><div style="display:flex;align-items:center;gap:0.6rem">' +
      '<div style="display:flex;margin-right:2px">' +
      '<div class="pos-avatar" style="background:' + avatarBg0 + ';margin-right:-4px;z-index:1">' + p.token0.symbol.slice(0,2).toUpperCase() + '</div>' +
      '<div class="pos-avatar" style="background:' + avatarBg1 + '">' + p.token1.symbol.slice(0,2).toUpperCase() + '</div>' +
      '</div>' +
      '<div><div style="font-weight:600;color:#fafafa">' + p.token0.symbol + '/' + p.token1.symbol + uVersionBadge(p.version) + '</div>' +
      '<div style="font-size:0.68rem;color:rgba(255,255,255,0.35)">' + p.feeDisplay + ' · #' + p.tokenId + '</div></div>' +
      '</div></td>' +
      '<td>' + uStatusBadge(p) + '</td>' +
      '<td style="text-align:right"><div style="color:#fafafa;font-weight:500">' + liqVal + '</div>' + liqSub + '</td>' +
      '<td style="text-align:right"><div style="color:' + feesColor + ';font-weight:500">' + uFmt(p.totalFeesUsd) + '</div>' + feesSub + '</td>' +
      '<td style="text-align:right"><span id="upct-' + p.tokenId + '" style="color:rgba(255,255,255,0.3);font-size:0.8rem">—</span></td>' +
      '<td style="text-align:center"><span class="uni-chevron" id="uchev-' + p.tokenId + '">▾</span></td>' +
      '</tr>' +
      '<tr id="uexp-' + p.tokenId + '" style="display:none"><td colspan="6" style="padding:0">' +
      '<div style="padding:1.25rem 1.25rem 1.5rem" id="uexpbody-' + p.tokenId + '">Loading…</div>' +
      '</td></tr>';
  }).join('');
}

const _expandedRows = new Set();
const _pnlCache = {};

function toggleUniRow(tokenId) {
  const row = document.getElementById('uexp-' + tokenId);
  const chev = document.getElementById('uchev-' + tokenId);
  if (_expandedRows.has(tokenId)) {
    row.style.display = 'none';
    chev.classList.remove('open');
    _expandedRows.delete(tokenId);
  } else {
    row.style.display = '';
    chev.classList.add('open');
    _expandedRows.add(tokenId);
    const pos = _uniPositions.find(p => p.tokenId === tokenId);
    if (pos) renderExpandedRow(pos);
  }
}

function renderExpandedRow(pos) {
  const container = document.getElementById('uexpbody-' + pos.tokenId);
  container.innerHTML =
    '<div class="uni-detail-grid">' +
    // Price Range
    '<div class="uni-detail-section">' +
    '<div class="dlabel">Price Range</div>' +
    '<div class="uni-detail-row"><span>Min</span><span class="dval" style="font-size:0.75rem;font-family:monospace">' + pos.priceLower + ' <span style="color:rgba(255,255,255,0.3)">' + pos.token1.symbol + '/' + pos.token0.symbol + '</span></span></div>' +
    '<div class="uni-detail-row"><span>Max</span><span class="dval" style="font-size:0.75rem;font-family:monospace">' + pos.priceUpper + ' <span style="color:rgba(255,255,255,0.3)">' + pos.token1.symbol + '/' + pos.token0.symbol + '</span></span></div>' +
    '</div>' +
    // Liquidity Breakdown
    '<div class="uni-detail-section">' +
    '<div class="dlabel">Liquidity Breakdown</div>' +
    '<div class="uni-detail-row"><span>' + pos.token0.symbol + '</span><span class="dval">' + pos.amount0.toFixed(4) + (pos.amount0Usd !== null ? ' <span style="color:rgba(255,255,255,0.35);font-size:0.72rem">(' + uFmt(pos.amount0Usd) + ')</span>' : '') + '</span></div>' +
    '<div class="uni-detail-row"><span>' + pos.token1.symbol + '</span><span class="dval">' + pos.amount1.toFixed(4) + (pos.amount1Usd !== null ? ' <span style="color:rgba(255,255,255,0.35);font-size:0.72rem">(' + uFmt(pos.amount1Usd) + ')</span>' : '') + '</span></div>' +
    '</div>' +
    // Fees Breakdown + Collect
    '<div class="uni-detail-section">' +
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem">' +
    '<div class="dlabel">Uncollected Fees</div>' +
    (pos.hasFees && pos.version === 'v3' ? '<button class="uni-collect-btn" id="ucollect-' + pos.tokenId + '" data-tid="' + pos.tokenId + '" onclick="doCollect(event,this.dataset.tid)" title="Collect fees on-chain using AGENT_PRIVATE_KEY">Collect fees</button>' : '') +
    (pos.hasFees && pos.version === 'v4' ? '<a href="https://app.uniswap.org/positions/v4/base/' + pos.tokenId + '" target="_blank" rel="noopener noreferrer" class="uni-collect-btn" style="text-decoration:none;display:inline-block">Collect fees ↗</a>' : '') +
    '</div>' +
    '<div class="uni-detail-row"><span>' + pos.token0.symbol + '</span><span class="dval" style="color:#A8F1F7">' + parseFloat(pos.fees0).toFixed(4) + (pos.fees0Usd !== null ? ' <span style="color:rgba(255,255,255,0.35);font-size:0.72rem">(' + uFmt(pos.fees0Usd) + ')</span>' : '') + '</span></div>' +
    '<div class="uni-detail-row"><span>' + pos.token1.symbol + '</span><span class="dval" style="color:#A8F1F7">' + parseFloat(pos.fees1).toFixed(4) + (pos.fees1Usd !== null ? ' <span style="color:rgba(255,255,255,0.35);font-size:0.72rem">(' + uFmt(pos.fees1Usd) + ')</span>' : '') + '</span></div>' +
    '</div>' +
    '</div>' +
    '<div class="uni-pnl-section"><div id="upnl-' + pos.tokenId + '" style="color:rgba(255,255,255,0.35);font-size:0.8rem">Loading P&L…</div></div>';

  loadPnl(pos);
}

async function loadPnl(pos) {
  const container = document.getElementById('upnl-' + pos.tokenId);
  if (_pnlCache[pos.tokenId]) {
    renderPnl(pos, _pnlCache[pos.tokenId]);
    return;
  }
  try {
    const params = new URLSearchParams({
      version: pos.version, tokenId: pos.tokenId,
      token0: pos.token0.address, token1: pos.token1.address,
      decimals0: pos.token0.decimals, decimals1: pos.token1.decimals,
      walletAddress: _uniAddress, fee: pos.fee,
    });
    if (pos.version === 'v4') {
      params.set('tickLower', pos.tickLower); params.set('tickUpper', pos.tickUpper);
      params.set('tickSpacing', pos.tickSpacing ?? 0); params.set('hooks', pos.hooks ?? '0x0000000000000000000000000000000000000000');
      params.set('liquidity', pos.liquidity);
    }
    const res = await fetch('/uniswap/pnl?' + params.toString());
    const data = await res.json();
    if (data.error) { container.textContent = 'P&L: ' + data.error; return; }
    _pnlCache[pos.tokenId] = data;
    renderPnl(pos, data);
  } catch (e) { container.textContent = 'P&L error: ' + e.message; }
}

function renderPnl(pos, pnl) {
  const container = document.getElementById('upnl-' + pos.tokenId);
  if (!container) return;

  const current = pos.totalLiquidityUsd;
  const uncollected = pos.totalFeesUsd ?? 0;
  const unrealized = current !== null && pnl.entryTotalUsd != null ? current - pnl.entryTotalUsd : null;
  const collected = pnl.totalCollectedUsd ?? 0;
  const totalReturn = unrealized !== null ? unrealized + collected + uncollected : null;
  const pctReturn = totalReturn !== null && pnl.entryTotalUsd ? (totalReturn / pnl.entryTotalUsd) * 100 : null;
  const daysIn = pnl.mintTimestamp ? (Date.now() / 1000 - pnl.mintTimestamp) / 86400 : null;
  const annualized = pctReturn !== null && daysIn ? (pctReturn / daysIn) * 365 : null;
  const feeApr = pnl.entryTotalUsd && daysIn
    ? (((pnl.totalCollectedUsd ?? 0) + uncollected) / pnl.entryTotalUsd) * (365 / daysIn) * 100 : null;

  const entryDate = pnl.mintTimestamp ? new Date(pnl.mintTimestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  // Update return column in table
  if (pctReturn !== null) {
    const pctEl = document.getElementById('upct-' + pos.tokenId);
    if (pctEl) {
      pctEl.textContent = (pctReturn >= 0 ? '+' : '') + pctReturn.toFixed(2) + '%';
      pctEl.style.color = pctReturn >= 0 ? '#4ade80' : '#f87171';
      pctEl.style.fontWeight = '600';
    }
  }

  const openCols = pos.hasLiquidity
    ? '<div class="uni-pnl-grid">' +
      '<div class="uni-pnl-item"><div class="plabel">Entry Value</div><div class="pval">' + uFmt(pnl.entryTotalUsd) + '</div><div class="psub">' + entryDate + '</div>' +
      (pnl.entryAmount0 > 0 ? '<div class="psub">' + pnl.entryAmount0.toFixed(3) + ' ' + pos.token0.symbol + (pnl.entryPrice0 ? ' @$' + pnl.entryPrice0.toFixed(3) : '') + '</div>' : '') +
      (pnl.entryAmount1 > 0 ? '<div class="psub">' + pnl.entryAmount1.toFixed(3) + ' ' + pos.token1.symbol + (pnl.entryPrice1 ? ' @$' + pnl.entryPrice1.toFixed(3) : '') + '</div>' : '') +
      '</div>' +
      '<div class="uni-pnl-item"><div class="plabel">Current Value</div><div class="pval">' + uFmt(current) + '</div></div>' +
      '<div class="uni-pnl-item"><div class="plabel">Unrealized P&L</div><div class="pval" style="' + uColorClass(unrealized) + '">' + uFmtPnl(unrealized) + '</div><div class="psub">(incl. IL)</div></div>' +
      '<div class="uni-pnl-item"><div class="plabel">Total Return</div><div class="pval" style="' + uColorClass(totalReturn) + '">' + uFmtPnl(totalReturn) + '</div>' +
      (pctReturn !== null ? '<div class="psub" style="' + uColorClass(pctReturn) + '">' + (pctReturn >= 0 ? '+' : '') + pctReturn.toFixed(2) + '%</div>' : '') +
      (annualized !== null && daysIn ? '<div class="psub">' + (annualized >= 0 ? '+' : '') + annualized.toFixed(1) + '% APR (total)</div>' : '') +
      (feeApr !== null && daysIn ? '<div class="psub" style="color:#A8F1F7">' + (feeApr >= 0 ? '+' : '') + feeApr.toFixed(1) + '% APR (fees · ' + Math.round(daysIn) + 'd)</div>' : '') +
      '</div></div>'
    : '<div class="uni-pnl-grid" style="grid-template-columns:repeat(3,1fr)">' +
      '<div class="uni-pnl-item"><div class="plabel">Entry Value</div><div class="pval">' + uFmt(pnl.entryTotalUsd) + '</div><div class="psub">' + entryDate + '</div></div>' +
      '<div class="uni-pnl-item"><div class="plabel">Total Collected</div><div class="pval">' + uFmt(collected > 0 ? collected : null) + '</div></div>' +
      '<div class="uni-pnl-item"><div class="plabel">Net P&L</div><div class="pval" style="' + uColorClass(totalReturn) + '">' + uFmtPnl(totalReturn) + '</div>' +
      (pctReturn !== null ? '<div class="psub" style="' + uColorClass(totalReturn) + '">' + (pctReturn >= 0 ? '+' : '') + pctReturn.toFixed(2) + '%</div>' : '') +
      (annualized !== null && daysIn ? '<div class="psub">' + (annualized >= 0 ? '+' : '') + annualized.toFixed(1) + '% APR · ' + Math.round(daysIn) + 'd</div>' : '') +
      '</div></div>';

  let feesHtml = '';
  if (!pnl.v4CollectedUnavailable && (pnl.fees0 > 0 || pnl.fees1 > 0 || pnl.collectionsCount > 0)) {
    feesHtml = '<div class="uni-fees-box">' +
      '<div class="flabel">Fees earned (taxable income)</div>' +
      '<div class="uni-fees-row">' +
      '<span>' + pos.token0.symbol + ': <span style="color:#A8F1F7">' + pnl.fees0.toFixed(4) + (pnl.fees0Usd ? ' (' + uFmt(pnl.fees0Usd) + ')' : '') + '</span></span>' +
      '<span>' + pos.token1.symbol + ': <span style="color:#A8F1F7">' + pnl.fees1.toFixed(4) + (pnl.fees1Usd ? ' (' + uFmt(pnl.fees1Usd) + ')' : '') + '</span></span>' +
      '</div>' +
      '<div class="flabel">Principal returned</div>' +
      '<div class="uni-fees-row">' +
      '<span>' + pos.token0.symbol + ': <span style="color:rgba(255,255,255,0.75)">' + (pnl.principal0 ?? 0).toFixed(4) + (pnl.principal0Usd ? ' (' + uFmt(pnl.principal0Usd) + ')' : '') + '</span></span>' +
      '<span>' + pos.token1.symbol + ': <span style="color:rgba(255,255,255,0.75)">' + (pnl.principal1 ?? 0).toFixed(4) + (pnl.principal1Usd ? ' (' + uFmt(pnl.principal1Usd) + ')' : '') + '</span></span>' +
      '</div>' +
      (pos.hasLiquidity ? '<div class="uni-fees-row" style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid rgba(255,255,255,0.06)"><span>Uncollected: <span style="color:#A8F1F7">' + uFmt(uncollected > 0 ? uncollected : null) + '</span></span></div>' : '') +
      '</div>';
  } else if (pnl.v4CollectedUnavailable) {
    feesHtml = '<div style="font-size:0.72rem;color:rgba(255,255,255,0.3);margin-top:0.5rem">Collected fees not tracked (V4)</div>';
  }

  container.innerHTML =
    '<div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.4);margin-bottom:0.75rem">P&L Summary</div>' +
    openCols + feesHtml;
}

async function doCollect(e, tokenId) {
  e.stopPropagation();
  const btn = document.getElementById('ucollect-' + tokenId);
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Collecting…';
  try {
    const pos = _uniPositions.find(p => p.tokenId === tokenId);
    const body = {
      tokenId,
      token0: pos ? { address: pos.token0.address, symbol: pos.token0.symbol, decimals: pos.token0.decimals } : null,
      token1: pos ? { address: pos.token1.address, symbol: pos.token1.symbol, decimals: pos.token1.decimals } : null,
    };
    const res = await fetch('/uniswap/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.error) {
      btn.textContent = '✗ ' + (data.error.slice(0, 40));
      btn.style.color = '#f87171';
      btn.style.borderColor = 'rgba(248,113,113,0.4)';
    } else {
      const swapNote = data.swapHash ? ' + swapped ' + data.wethSwapped.toFixed(4) + ' WETH' : '';
      btn.textContent = '✓ $' + data.usdcTotal.toFixed(2) + ' USDC' + swapNote;
      btn.style.color = '#4ade80';
      btn.style.borderColor = 'rgba(74,222,128,0.4)';
      setTimeout(() => loadPositions(), 4000);
    }
  } catch (err) {
    btn.textContent = '✗ Error';
    btn.style.color = '#f87171';
  }
}

// Spin animation for refresh button
const _uniStyle = document.createElement('style');
_uniStyle.textContent = '@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }';
document.head.appendChild(_uniStyle);

loadPositions();
</script>
`, "uniswap");
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  const send = (html) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); };
  const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  const redirect = (to) => { res.writeHead(302, { Location: to }); res.end(); };

  const readBody = () => new Promise(r => { let b = ""; req.on("data", d => b += d); req.on("end", () => r(b)); });

  try {
    if (url.startsWith("/public/") && method === "GET") {
      const filePath = resolve(__dirname, "." + url);
      if (existsSync(filePath) && filePath.startsWith(resolve(__dirname, "public"))) {
        const ext = url.split(".").pop();
        const mime = { png: "image/png", svg: "image/svg+xml", ico: "image/x-icon" }[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
        res.end(readFileSync(filePath));
        return;
      }
    }

    if (url === "/" || url === "") return redirect("/positions");

    if (url === "/portfolio") return send(await portfolioPage());
    if (url === "/positions") return send(await positionsPage());
    if (url === "/strategies") return send(strategiesPage());
    if (url === "/signals") return send(signalsPage());
    if (url === "/history") return send(historyPage());
    if (url.startsWith("/settings") && method === "GET") {
      const schwabOk = new URL("http://x" + url).searchParams.get("schwab") === "authorized";
      return send(settingsPage(false, "", schwabOk));
    }
    if (url === "/settings" && method === "POST") {
      const body = await readBody();
      const params = new URLSearchParams(body);
      const updates = {};
      for (const key of ["AGENT_PRIVATE_KEY","HL_POSITION_SIZE_USD",
                          "KRAKEN_API_KEY","KRAKEN_API_SECRET",
                          "ALPACA_API_KEY","ALPACA_API_SECRET",
                          "COINBASE_API_KEY","COINBASE_API_SECRET","COINBASE_API_PASSPHRASE",
                          "X402_PAYMENT_NETWORK","ALCHEMY_API_KEY",
                          "SCHWAB_API_KEY","SCHWAB_APP_SECRET","SCHWAB_REDIRECT_URI",
                          "AGENT_API_KEY"]) {
        let v = params.get(key)?.trim();
        if (!v) continue;
        // PEM keys contain real newlines from the textarea — encode to \n for single-line .env storage
        if (key === "COINBASE_API_SECRET" && v.includes("\n")) {
          v = v.replace(/\r?\n/g, "\\n");
        }
        updates[key] = v;
      }
      // Checkbox — present = true, absent = false
      updates["ALPACA_PAPER"] = params.get("ALPACA_PAPER") === "true" ? "true" : "false";
      try {
        writeEnvValues(updates);
        return send(settingsPage(true));
      } catch (e) {
        return send(settingsPage(false, e.message));
      }
    }

    if (url === "/add-strategy" && method === "GET") return send(addStrategyPage());
    if (url === "/add-strategy" && method === "POST") {
      const body = await readBody();
      const params = new URLSearchParams(body);
      const id = params.get("id")?.trim();
      if (!id) return send(addStrategyPage("Strategy ID is required"));
      upsertStrategy({
        id,
        name: params.get("name") || "My Strategy",
        symbol: (params.get("symbol") || "BTC-USD").toUpperCase(),
        leverage: parseInt(params.get("leverage") ?? "1") || 1,
        position_size_usd: params.get("position_size_usd") ? parseFloat(params.get("position_size_usd")) : null,
        exchange: params.get("exchange") || "hyperliquid",
        interval_minutes: parseInt(params.get("interval_minutes") ?? "60") || 60,
        tp_pct: params.get("tp_pct") ? parseFloat(params.get("tp_pct")) : null,
        trail_pct: params.get("trail_pct") ? parseFloat(params.get("trail_pct")) : null,
      });
      return redirect("/strategies");
    }

    // API routes
    if (url === "/api/close" && method === "POST") {
      const body = await readBody();
      return json(await handleClose(body).catch(e => ({ ok: false, error: e.message })));
    }
    if (url === "/api/toggle" && method === "POST") {
      const body = await readBody();
      return json(await handleToggle(body).catch(e => ({ ok: false, error: e.message })));
    }
    if (url === "/api/subscribe-strategy" && method === "POST") {
      const body = await readBody();
      return json(await handleSubscribeStrategy(body).catch(e => ({ ok: false, error: e.message })));
    }
    if (url === "/api/execute" && method === "POST") {
      const body = await readBody();
      return json(await handleExecute(body).catch(e => ({ ok: false, error: e.message })));
    }
    if (url === "/api/run" && method === "POST") {
      const body = await readBody();
      return json(await handleRun(body).catch(e => ({ ok: false, error: e.message })));
    }
    if (url === "/api/add-to-position" && method === "POST") {
      const body = await readBody();
      return json(await handleAddToPosition(body).catch(e => ({ ok: false, error: e.message })));
    }

    if (url === "/api/open" && method === "POST") {
      const body = await readBody();
      return json(await handleOpen(body).catch(e => ({ ok: false, error: e.message })));
    }
    if (url === "/api/sell-for-usdc" && method === "POST") {
      const body = await readBody();
      try {
        const { exchange, asset, amount } = JSON.parse(body);
        if (!exchange || !asset || !amount) return json({ ok: false, error: "exchange, asset, amount required" });
        const { KrakenExchange }   = await import("./exchanges/kraken.mjs");
        const { CoinbaseExchange } = await import("./exchanges/coinbase.mjs");
        const exch = exchange === "kraken"
          ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
          : new CoinbaseExchange(process.env.COINBASE_API_KEY, process.env.COINBASE_API_SECRET, process.env.COINBASE_API_PASSPHRASE);
        const result = await exch.placeMarketOrder(asset, "sell", amount);
        return json({ ok: true, result });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url === "/api/set-subscription-period" && method === "POST") {
      const body = await readBody();
      try {
        const { strategy_id, period } = JSON.parse(body);
        if (!strategy_id) return json({ ok: false, error: "strategy_id required" });
        setSubscriptionPeriod(strategy_id, period ?? null);
        return json({ ok: true });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url === "/api/upsert-strategy" && method === "POST") {
      const body = await readBody();
      try {
        const s = JSON.parse(body);
        if (!s.id) return json({ ok: false, error: "id required" });
        const old = getStrategy(s.id);
        upsertStrategy(s);
        // If interval changed, adjust subscription expiry on AgentSignal
        if (old && s.interval_minutes && old.interval_minutes !== s.interval_minutes && PRIVATE_KEY) {
          try {
            const { privateKeyToAccount } = await import("viem/accounts");
            const account = privateKeyToAccount(PRIVATE_KEY);
            const adjustUrl = getSignalUrl() + '/api/strategy/' + s.id + '/subscription/adjust';
            const r = await fetch(adjustUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Wallet-Address': account.address },
              body: JSON.stringify({ new_interval_minutes: s.interval_minutes }),
            });
            const adj = await r.json();
            if (r.status === 402 && adj.upcharge_required) {
              console.warn('[adjust-sub] upcharge required: $' + adj.upcharge_usd + ' — ' + adj.message);
              return json({ ok: false, error: 'Faster interval requires upcharge of $' + adj.upcharge_usd.toFixed(2) + '. Purchase a new subscription at ' + s.interval_minutes + '-min interval to upgrade.' });
            }
            if (r.ok) {
              console.log('[adjust-sub] interval', old.interval_minutes, '→', s.interval_minutes,
                '| expiry', adj.old_expires_at, '→', adj.new_expires_at);
            }
          } catch (e) { console.warn('[adjust-sub] skipped:', e.message); }
        }
        return json({ ok: true });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url === "/api/cancel-order" && method === "POST") {
      const body = await readBody();
      return json(await handleCancelOrder(body).catch(e => ({ ok: false, error: e.message })));
    }

    if (url === "/api/edit-order" && method === "POST") {
      const body = await readBody();
      return json(await handleEditOrder(body).catch(e => ({ ok: false, error: e.message })));
    }

    if (url === "/api/pm2-status" && method === "GET") {
      try {
        const { exec } = await import("child_process");
        const out = await new Promise((resolve, reject) => {
          exec("/opt/homebrew/bin/pm2 jlist", { timeout: 5000 }, (err, stdout) => {
            if (err) reject(err); else resolve(stdout);
          });
        });
        const list = JSON.parse(out);
        const scheduled = list.some(p =>
          (p.name === "trader" || p.name === "trader-crypto")
        );
        const running = list.some(p =>
          (p.name === "trader" || p.name === "trader-crypto") &&
          p.pm2_env?.status === "online"
        );
        return json({ scheduled, running });
      } catch {
        return json({ running: false });
      }
    }

    if (url === "/api/pm2-start" && method === "POST") {
      try {
        const { exec } = await import("child_process");
        await new Promise((resolve, reject) => {
          exec(`/opt/homebrew/bin/pm2 restart trader trader-crypto`, { timeout: 15000 }, (err) => {
            if (err) reject(err); else resolve();
          });
        });
        exec("/opt/homebrew/bin/pm2 save");
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (url.startsWith("/api/strategy/") && method === "DELETE") {
      const id = url.replace("/api/strategy/", "");
      deleteStrategy(id);
      return json({ ok: true });
    }

    if (url.startsWith("/api/funding-rate/") && method === "GET") {
      const asset = decodeURIComponent(url.replace("/api/funding-rate/", "")).toUpperCase();
      try {
        const { getFundingRate } = await import("./hyperliquid.mjs");
        const data = await getFundingRate(asset);
        if (!data) return json({ error: "Asset not found" }, 404);
        return json(data);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.startsWith("/api/strategy-details/") && method === "GET") {
      const id = url.replace("/api/strategy-details/", "");
      try {
        const r = await fetch(`${getSignalUrl()}/api/strategy/${id}`);
        const data = await r.json();
        return json(data, r.status);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (url === "/api/wallet-address" && method === "POST") {
      try {
        const { pk } = JSON.parse(await readBody());
        const { privateKeyToAccount } = await import("viem/accounts");
        const account = privateKeyToAccount(pk);
        return json({ address: account.address });
      } catch { return json({ error: "Invalid key" }, 400); }
    }

    // ── Schwab option writing ─────────────────────────────────────────────────

    if (url.startsWith("/schwab/option-mid") && method === "GET") {
      try {
        const sc = getSchwabClient();
        if (!sc?.isAuthorized()) return json({ error: "Schwab not authorized" }, 401);
        const qs     = new URL("http://x" + url).searchParams;
        const ticker = qs.get("ticker");
        const type   = (qs.get("type") || "CALL").toUpperCase();
        const strike = parseFloat(qs.get("strike") || "0");
        const expiry = qs.get("expiry"); // YYYY-MM-DD
        if (!ticker || !strike || !expiry) return json({ error: "ticker, strike, expiry required" }, 400);
        const raw = await sc.getOptionChain(ticker, { contractType: type, strikeCount: 100, fromDate: expiry, toDate: expiry });
        const map = type === "PUT" ? raw?.putExpDateMap : raw?.callExpDateMap;
        if (!map) return json({ error: "No chain data for " + ticker }, 404);
        for (const strikes of Object.values(map)) {
          for (const contracts of Object.values(strikes)) {
            for (const c of contracts) {
              if (Math.abs(c.strikePrice - strike) < 0.01 && !c.nonStandard) {
                const mid = parseFloat((((c.bid ?? 0) + (c.ask ?? 0)) / 2).toFixed(2));
                return json({ symbol: c.symbol, mid, bid: c.bid ?? 0, ask: c.ask ?? 0, dte: c.daysToExpiration ?? null });
              }
            }
          }
        }
        return json({ error: "Contract not found for " + ticker + " $" + strike + " " + type + " " + expiry }, 404);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.startsWith("/schwab/chains") && method === "GET") {
      try {
        const sc = getSchwabClient();
        if (!sc?.isAuthorized()) return json({ error: "Schwab not authorized" }, 401);
        const qs = new URL("http://x" + url).searchParams;
        const symbol = qs.get("symbol");
        const type   = (qs.get("type") || "CALL").toUpperCase();
        if (!symbol) return json({ error: "symbol required" }, 400);
        // Fetch ~60 DTE window
        const from = new Date(); from.setDate(from.getDate() + 1);
        const to   = new Date(); to.setDate(to.getDate() + 90);
        const fmt  = d => d.toISOString().slice(0, 10);
        const raw  = await sc.getOptionChain(symbol, { contractType: type, strikeCount: 20, fromDate: fmt(from), toDate: fmt(to) });
        if (!raw) return json({ error: "No chain data" }, 404);
        const map  = type === "PUT" ? raw.putExpDateMap : raw.callExpDateMap;
        if (!map) return json({ expirations: [], byExpiry: {} });
        const byExpiry = {};
        for (const [expKey, strikes] of Object.entries(map)) {
          const expDate = expKey.split(":")[0]; // "2026-06-12:18" → "2026-06-12"
          const contracts = [];
          for (const [, ctrs] of Object.entries(strikes)) {
            for (const c of ctrs) {
              if (c.nonStandard) continue;
              contracts.push({
                symbol: c.symbol,
                strike: c.strikePrice,
                bid:    c.bid ?? 0,
                ask:    c.ask ?? 0,
                mid:    parseFloat(((( c.bid ?? 0) + (c.ask ?? 0)) / 2).toFixed(2)),
                delta:  c.delta ?? null,
                dte:    c.daysToExpiration ?? null,
              });
            }
          }
          if (contracts.length) byExpiry[expDate] = contracts.sort((a, b) => a.strike - b.strike);
        }
        const expirations = Object.keys(byExpiry).sort();
        return json({ expirations, byExpiry });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url === "/schwab/write" && method === "POST") {
      try {
        const sc = getSchwabClient();
        if (!sc?.isAuthorized()) return json({ error: "Schwab not authorized" }, 401);
        const { optionSymbol, contracts, limitPrice, instruction = "SELL_TO_OPEN" } = JSON.parse(await readBody());
        if (!optionSymbol || !contracts || !limitPrice) return json({ error: "optionSymbol, contracts, limitPrice required" }, 400);
        const validInstructions = ["SELL_TO_OPEN", "BUY_TO_CLOSE"];
        if (!validInstructions.includes(instruction)) return json({ error: "invalid instruction" }, 400);
        const nums = await sc.getAccountNumbers();
        const hash = process.env.SCHWAB_ACCOUNT_HASH || nums?.[0]?.hashValue;
        if (!hash) return json({ error: "No account hash found" }, 500);
        await sc.placeOrder(hash, {
          orderType:          "LIMIT",
          session:            "NORMAL",
          duration:           "GOOD_TILL_CANCEL",
          price:              parseFloat(parseFloat(limitPrice).toFixed(2)),
          orderStrategyType:  "SINGLE",
          orderLegCollection: [{
            instruction,
            quantity:    parseInt(contracts),
            instrument:  { symbol: optionSymbol, assetType: "OPTION" },
          }],
        });
        return json({ ok: true });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── Uniswap ────────────────────────────────────────────────────────────────

    if (url === "/premium-fade" && method === "GET") return send(await premiumFadePage());
    if (url === "/uniswap" && method === "GET") return send(renderUniswapPage());

    if (url === "/uniswap/wallet" && method === "GET") {
      try {
        if (!PRIVATE_KEY) return json({ address: null });
        const { privateKeyToAccount } = await import("viem/accounts");
        const acct = privateKeyToAccount(PRIVATE_KEY);
        return json({ address: acct.address });
      } catch { return json({ address: null }); }
    }

    if (url === "/uniswap/positions" && method === "GET") {
      try {
        if (!PRIVATE_KEY) return json({ error: "AGENT_PRIVATE_KEY not set" }, 400);
        const { privateKeyToAccount } = await import("viem/accounts");
        const { address } = privateKeyToAccount(PRIVATE_KEY);
        return json(await getV3Positions(address));
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url === "/uniswap/v4/positions" && method === "GET") {
      try {
        if (!PRIVATE_KEY) return json({ error: "AGENT_PRIVATE_KEY not set" }, 400);
        const { privateKeyToAccount } = await import("viem/accounts");
        const { address } = privateKeyToAccount(PRIVATE_KEY);
        return json(await getV4Positions(address));
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.startsWith("/uniswap/pnl") && method === "GET") {
      try {
        if (!PRIVATE_KEY) return json({ error: "AGENT_PRIVATE_KEY not set" }, 400);
        const { privateKeyToAccount } = await import("viem/accounts");
        const { address } = privateKeyToAccount(PRIVATE_KEY);
        const qp = Object.fromEntries(new URL("http://x" + url).searchParams.entries());
        // Map client param names → getPnl param names; wallet comes from server
        qp.token0Raw = qp.token0;
        qp.token1Raw = qp.token1;
        qp.walletRaw = address;
        return json(await getPnl(qp));
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url === "/uniswap/collect" && method === "POST") {
      try {
        if (!PRIVATE_KEY) return json({ error: "AGENT_PRIVATE_KEY not set" }, 400);
        const { tokenId, token0, token1 } = JSON.parse(await readBody());
        if (!tokenId) return json({ error: "tokenId required" }, 400);
        const { privateKeyToAccount } = await import("viem/accounts");
        const { address } = privateKeyToAccount(PRIVATE_KEY);
        const result = await collectAndSwap(tokenId, address, PRIVATE_KEY, token0, token1);
        // Record in trade history
        insertTrade({
          strategy_id: 'uniswap',
          action: 'COLLECT FEES',
          asset: result.pool,
          size: result.usdcTotal,
          price: 1,
          leverage: 1,
          pnl: result.usdcTotal,
          result: {
            tokenId,
            collectHash: result.collectHash,
            swapHash: result.swapHash,
            collected0: result.collected0,
            collected1: result.collected1,
            sym0: result.sym0,
            sym1: result.sym1,
            wethSwapped: result.wethSwapped,
            usdcFromSwap: result.usdcFromSwap,
            directUsdc: result.directUsdc,
            usdcTotal: result.usdcTotal,
          },
        });
        return json(result);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    redirect("/positions");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(err.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n🤖 AgentSignal Trader Dashboard`);
  console.log(`   http://localhost:${PORT}\n`);
});
