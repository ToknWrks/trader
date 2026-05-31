#!/usr/bin/env node
/**
 * dashboard.mjs — AgentSignal Trader local dashboard
 * Open: http://localhost:4100
 */

import { createServer } from "http";
import { readFileSync, writeFileSync } from "fs";
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
  getSnapshots, insertSnapshot,
} from "./db.mjs";

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
      <img src="${getSignalUrl()}/icon.png" alt="" onerror="this.style.display='none'" />
      AgentSignal Trader
    </div>
    <div class="nav-links">
      <a class="nav-link ${active === "portfolio" ? "active" : ""}" href="/portfolio">Portfolio</a>
      <a class="nav-link ${active === "positions" ? "active" : ""}" href="/positions">Positions</a>
      <a class="nav-link ${active === "strategies" ? "active" : ""}" href="/strategies">Strategies</a>
      <a class="nav-link ${active === "signals" ? "active" : ""}" href="/signals">Signals</a>
      <a class="nav-link ${active === "history" ? "active" : ""}" href="/history">History</a>
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
            </select>
          </div>
          <div>
            <label style="font-size:0.72rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.25rem">Check Every</label>
            <select id="em_interval_minutes" style="width:100%">
              <option value="5">5 min</option><option value="15">15 min</option><option value="30">30 min</option>
              <option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="1440">Daily</option>
            </select>
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
      return '<span style="color:#A8F1F7">' + (c.source || '') + '</span> ' + (c.field || '') + ' ' + (c.op || '') + ' ' + (c.value !== undefined ? c.value : '');
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
      const sched = isCrypto(s.symbol) ? SCHEDULES.crypto : SCHEDULES.stocks;
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
      let entry = null, exit = null;
      try {
        const res = await fetch('/api/strategy-details/' + s.id);
        if (res.ok) {
          const full = await res.json();
          entry = typeof full.entry === 'string' ? JSON.parse(full.entry) : full.entry;
          exit  = typeof full.exit  === 'string' ? JSON.parse(full.exit)  : full.exit;
        }
      } catch {}

      pop.innerHTML = '<strong>' + s.name + '</strong>'
        + '<div style="margin:0.4rem 0 0;font-family:monospace;font-size:0.7rem;color:rgba(255,255,255,0.35);word-break:break-all">' + s.id + '</div>'
        + '<div style="margin-top:0.75rem;display:flex;flex-direction:column;gap:0.5rem">'
        + '<div><span style="color:rgba(255,255,255,0.4);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em">Symbol</span><br>' + s.symbol + ' · ' + s.leverage + 'x · ' + size + '</div>'
        + (entry ? '<div><span style="color:rgba(255,255,255,0.4);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em">Entry</span><br><span style="font-size:0.75rem">' + renderRules(entry) + '</span></div>' : '')
        + (exit  ? '<div><span style="color:rgba(255,255,255,0.4);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em">Exit</span><br><span style="font-size:0.75rem">'  + renderRules(exit)  + '</span></div>' : '')
        + '</div>'
        + '<div class="sched">⏱ ' + sched.label + '</div>';
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

function renderEquityCurve(snapshots, positionValue, marginValue, spotUsdc = 0) {
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
    ${statBlock("Margin", fmt2(marginValue))}
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

  // ── Summary calculations ────────────────────────────────────────────────────
  const cbTotalUsd = Object.values(coinbaseUsdValues).reduce((s, v) => s + (v ?? 0), 0);
  const krTotalUsd = Object.values(krakenUsdValues).reduce((s, v) => s + (v ?? 0), 0);
  const totalValue = accountValue + usdcSpot + cbTotalUsd + krTotalUsd;

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
    const unrealizedPnl = (hlData?.assetPositions ?? [])
      .reduce((s, p) => s + parseFloat(p.position?.unrealizedPnl ?? "0"), 0);
    insertSnapshot({ net_liq: usdcSpot, unrealized_pnl: unrealizedPnl, realized_pnl: ytdPnl, total_value: usdcSpot });
  }

  const hlPositionValue = (hlData?.assetPositions ?? [])
    .filter(p => parseFloat(p.position?.szi ?? "0") !== 0)
    .reduce((s, p) => s + parseFloat(p.position?.positionValue ?? "0"), 0);

  const equityCurveHtml = renderEquityCurve(getSnapshots(90), hlPositionValue, accountValue - usdcSpot, usdcSpot);

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
    </div>
    <div style="display:flex;gap:0.25rem;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.2rem;margin-bottom:1.25rem">
      <button id="ptab-hl"     onclick="switchPTab('hl')"     style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:#A8F1F7;color:#000">Hyperliquid</button>
      ${process.env.COINBASE_API_KEY ? `<button id="ptab-cb" onclick="switchPTab('cb')" style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">Coinbase</button>` : ""}
      ${process.env.KRAKEN_API_KEY   ? `<button id="ptab-kr" onclick="switchPTab('kr')" style="font-size:0.75rem;font-weight:600;padding:0.3rem 0.9rem;border-radius:6px;border:none;cursor:pointer;transition:all 0.15s;background:transparent;color:rgba(255,255,255,0.5)">Kraken</button>` : ""}
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

    <div id="ppane-orders" style="display:none">
      ${openOrders.length > 0 ? `<div class="card"><table>
        <thead><tr><th>Exchange</th><th>Asset</th><th>Side</th><th>Size</th><th>Limit Price</th><th></th></tr></thead>
        <tbody>${openOrders.map(o => `<tr>
          <td style="color:rgba(255,255,255,0.4);font-size:0.78rem">${o.exchange}</td>
          <td style="font-weight:600">${o.asset}</td>
          <td><span class="${o.side === "buy" ? "pos-long" : "pos-short"}">${o.side === "buy" ? "▲ BUY" : "▼ SELL"}</span></td>
          <td>${o.size.toFixed(4)}</td>
          <td>$${o.limitPrice.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</td>
          <td><button class="btn btn-red" onclick="cancelOrder('${o.exchange}','${o.id}','${o.asset}',this)">Cancel</button></td>
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
    <p class="hint">Auto-refreshes every 30s · <a href="/portfolio">Refresh now</a></p>
    <script>
      setTimeout(() => location.reload(), 30000);
      function switchPTab(tab) {
        ['hl','cb','kr','orders'].forEach(t => {
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
      async function cancelOrder(exchange, orderId, asset, btn) {
        if (!confirm('Cancel this ' + asset + ' limit order on ' + exchange + '?')) return;
        btn.textContent = 'Cancelling…'; btn.disabled = true;
        const res = await fetch('/api/cancel-order', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ exchange, orderId, asset }) });
        const d = await res.json();
        if (d.ok) { btn.textContent = 'Cancelled ✓'; setTimeout(() => location.reload(), 800); }
        else { btn.textContent = 'Error'; btn.disabled = false; alert(d.error); }
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
        : `<button class="btn btn-red" onclick="closePos(this, '${b.coin}', 'hyperliquid')">Force Exit</button>`;
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
        <td><button class="btn btn-red" onclick="closePos(this, '${pos.coin}', 'hyperliquid')">Force Exit</button></td>
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
        <td><button class="btn btn-red" onclick="closePos(this, '${p.symbol}', 'alpaca')">Force Exit</button></td>
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
    <script>
    const TV_SYMBOLS = ${JSON.stringify(Object.fromEntries(strategies.map(s => [s.id, tvSymbol(s.symbol, s.exchange)])))};

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
      if (!isOpen && !body.querySelector('iframe')) {
        const tv = TV_SYMBOLS[id] || 'BINANCE:BTCUSDT';

        // Derive up to 2 indicator studies from strategy conditions
        let studies = [];
        try {
          const res = await fetch('/api/strategy-details/' + id);
          if (res.ok) {
            const full = await res.json();
            const entry = typeof full.entry === 'string' ? JSON.parse(full.entry) : full.entry;
            const exit  = typeof full.exit  === 'string' ? JSON.parse(full.exit)  : full.exit;
            const allConds = [...(entry?.conditions ?? []), ...(exit?.conditions ?? [])];
            const seen = new Set();
            for (const c of allConds) {
              const study = FIELD_TO_STUDY[c.field];
              if (study && !seen.has(study)) { seen.add(study); studies.push(study); }
              if (studies.length >= 2) break;
            }
          }
        } catch {}

        const studyParams = studies.map(s => '&studies=' + encodeURIComponent(s)).join('');
        body.innerHTML = '<iframe src="https://www.tradingview.com/widgetembed/?symbol=' + encodeURIComponent(tv) + '&interval=15&theme=dark&style=1&hide_side_toolbar=0&allow_symbol_change=1&save_image=0&locale=en&hide_legend=0&hide_volume=0' + studyParams + '" width="100%" height="480" frameborder="0" allowtransparency="true" scrolling="no" style="display:block"></iframe>';
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

    function openEditModal(s) {
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
      f('em_max_size_usd', s.max_size_usd);
      f('em_cooldown_minutes', s.cooldown_minutes);
      document.getElementById('editModal').classList.add('open');
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
        exchange: get('em_exchange') || 'hyperliquid',
        interval_minutes: parseInt(get('em_interval_minutes')) || 60,
        tp_pct: get('em_tp_pct') ? parseFloat(get('em_tp_pct')) : null,
        trail_pct: get('em_trail_pct') ? parseFloat(get('em_trail_pct')) : null,
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
          const pnl = t.pnl != null ? parseFloat(t.pnl) : null;
          const pnlStr = pnl != null
            ? `<span style="color:${pnl >= 0 ? "#4ade80" : "#f87171"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</span>`
            : "—";
          return `<tr>
            <td>${t.created_at.slice(0, 16)}</td>
            <td>${t.strategy_name ?? t.strategy_id.slice(0,8)}</td>
            <td style="color:${isEntry ? "#4ade80" : "#f87171"}">${t.action}</td>
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

function settingsPage(saved = false, error = "") {
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
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
      <p class="section-label" style="margin:0">Settings</p>
    </div>
    ${saved ? `<div style="color:#4ade80;font-size:0.82rem;margin-bottom:1rem;padding:0.6rem 0.85rem;background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.2);border-radius:8px">✓ Settings saved. Restart the trader processes for key changes to take effect.</div>` : ""}
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
        <button type="submit" style="background:#A8F1F7;color:#09090b;border:none;border-radius:8px;padding:0.6rem 1.25rem;font-weight:600;cursor:pointer;font-size:0.875rem;margin-top:0.25rem">
          Add Strategy
        </button>
      </form>
    </div>
  `, "strategies");
}

// ── Local price-threshold evaluation (no x402) ───────────────────────────────

async function tryLocalEvalDash(strategy) {
  try {
    const res = await fetch(`${getSignalUrl()}/api/strategy/${strategy.id}`);
    if (!res.ok) return null;
    const def = await res.json();
    const entry = typeof def.entry === "string" ? JSON.parse(def.entry) : def.entry;
    const exit  = typeof def.exit  === "string" ? JSON.parse(def.exit)  : def.exit;

    const allConds = [...(entry?.conditions ?? []), ...(exit?.conditions ?? [])];
    if (!allConds.length) return null;
    const priceFlds = new Set(["close", "price", "last", "mark", "open", "high", "low"]);
    if (!allConds.every(c => priceFlds.has((c.field ?? "close").toLowerCase()))) return null;

    const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
    const { KrakenExchange }      = await import("./exchanges/kraken.mjs");
    const { AlpacaExchange }      = await import("./exchanges/alpaca.mjs");
    const exch = strategy.exchange === "kraken"
      ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
      : strategy.exchange === "alpaca"
      ? new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true")
      : new HyperliquidExchange(PRIVATE_KEY);

    const asset = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
    const [price, position] = await Promise.all([
      exch.getMidPrice(asset),
      exch.getPosition(asset).catch(() => null),
    ]);
    if (!price) return null;

    const hasPosition = parseFloat(position?.szi ?? "0") !== 0;

    const evalRules = (rules, p) => {
      if (!rules?.conditions?.length) return false;
      const results = rules.conditions.map(c => {
        const v = parseFloat(c.value);
        switch (c.op) {
          case "<=": return p <= v;
          case ">=": return p >= v;
          case "<":  return p <  v;
          case ">":  return p >  v;
          default:   return false;
        }
      });
      return rules.operator === "AND" ? results.every(Boolean) : results.some(Boolean);
    };

    // Scalper model: derived from actual position + conditions, not signal history
    const signal = hasPosition
      ? (evalRules(exit, price) ? "FLAT" : "LONG")
      : (evalRules(entry, price) ? "LONG" : "FLAT");

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

    const url = `${getSignalUrl()}/api/strategy/${id}/signal`;
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

async function handleCancelOrder(body) {
  const { exchange, orderId, asset } = JSON.parse(body);
  const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
  const { KrakenExchange } = await import("./exchanges/kraken.mjs");
  const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
  const { CoinbaseExchange } = await import("./exchanges/coinbase.mjs");
  const exch = exchange === "Kraken"
    ? new KrakenExchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET)
    : exchange === "Alpaca"
    ? new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true")
    : exchange === "Coinbase"
    ? new CoinbaseExchange(process.env.COINBASE_API_KEY, process.env.COINBASE_API_SECRET, process.env.COINBASE_API_PASSPHRASE)
    : new HyperliquidExchange(PRIVATE_KEY);
  await exch.cancelOrder(orderId, asset);
  return { ok: true };
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
    if (url === "/" || url === "") return redirect("/positions");

    if (url === "/portfolio") return send(await portfolioPage());
    if (url === "/positions") return send(await positionsPage());
    if (url === "/strategies") return send(strategiesPage());
    if (url === "/signals") return send(signalsPage());
    if (url === "/history") return send(historyPage());
    if (url === "/settings" && method === "GET") return send(settingsPage());
    if (url === "/settings" && method === "POST") {
      const body = await readBody();
      const params = new URLSearchParams(body);
      const updates = {};
      for (const key of ["AGENT_PRIVATE_KEY","HL_POSITION_SIZE_USD",
                          "KRAKEN_API_KEY","KRAKEN_API_SECRET",
                          "ALPACA_API_KEY","ALPACA_API_SECRET",
                          "COINBASE_API_KEY","COINBASE_API_SECRET","COINBASE_API_PASSPHRASE",
                          "X402_PAYMENT_NETWORK"]) {
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
        upsertStrategy(s);
        return json({ ok: true });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url === "/api/cancel-order" && method === "POST") {
      const body = await readBody();
      return json(await handleCancelOrder(body).catch(e => ({ ok: false, error: e.message })));
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
