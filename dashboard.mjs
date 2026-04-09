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
  getStrategies, getStrategy, upsertStrategy, setStrategyActive,
  deleteStrategy, getSignalHistory, getAllRecentTrades, getLatestSignal,
  countSignals, countFetchesToday, countFetchesTotal, getRecentSignalEvents,
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
    const CRYPTO_TICKERS = new Set(["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","MATIC","POL","LINK","UNI","ATOM","LTC","DOGE","SHIB","TRX","TON","SUI","APT","OP","ARB","INJ","SEI","TIA","JUP","WIF","BONK","PEPE","NEAR","FIL","ICP","HBAR","VET","ALGO","XLM","XMR","ETC","BCH","AAVE","CRV","MKR","SNX","LDO","RETH","STETH","WBTC","VVV","VULT"]);
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
    function showToggleModal(btn, id, active, symbol) {
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
      \` : \`
        <p>The trader will <strong>stop executing trades</strong> for this strategy. Any open positions on Hyperliquid will remain open until you close them manually.</p>
      \`;
      const confirmBtn = document.getElementById('modalConfirm');
      confirmBtn.className = confirmClass;
      confirmBtn.textContent = confirmLabel;
      _pendingToggle = { btn, id, active };
      document.getElementById('toggleModal').classList.add('open');
    }

    document.getElementById('modalConfirm').addEventListener('click', async () => {
      if (!_pendingToggle) return;
      const { btn, id, active } = _pendingToggle;
      closeModal();
      btn.disabled = true; btn.textContent = 'Saving...';
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

// ── Pages ─────────────────────────────────────────────────────────────────────

async function positionsPage() {
  let hlData = null, spotData = null, alpacaPositions = [];
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
    }
  } catch {}

  // Fetch Alpaca positions if credentials are set
  if (process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET) {
    try {
      const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
      const alp = new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true");
      alpacaPositions = await alp._request("GET", "/v2/positions") ?? [];
    } catch (e) {
      console.error("[dashboard] Alpaca positions fetch error:", e.message);
    }
  }

  const positions = (hlData?.assetPositions ?? []).filter(p => parseFloat(p.position?.szi ?? "0") !== 0);
  const accountValue = parseFloat(hlData?.marginSummary?.accountValue ?? "0");
  const withdrawable = parseFloat(hlData?.withdrawable ?? "0");
  const usdcSpot = parseFloat(spotData?.balances?.find(b => b.coin === "USDC")?.total ?? "0");

  // x402 spend stats
  const fetchesToday = countFetchesToday();
  const fetchesTotal = countFetchesTotal();
  const wallet = PRIVATE_KEY
    ? (await import("viem/accounts")).privateKeyToAccount(PRIVATE_KEY)
    : null;
  const networkUsdc = wallet ? await getNetworkUsdcBalance(wallet.address) : null;
  const payNetwork = getPaymentNetwork();
  const payNetworkLabel = X402_NETWORKS[payNetwork]?.label ?? payNetwork;

  const stats = `
    <div class="stat-row">
      <div class="stat"><div class="label">Account Value</div><div class="value">$${accountValue.toFixed(2)}</div></div>
      <div class="stat"><div class="label">Spot USDC</div><div class="value cyan">$${usdcSpot.toFixed(2)}</div></div>
      <div class="stat"><div class="label">Withdrawable</div><div class="value">$${withdrawable.toFixed(2)}</div></div>
    </div>`;

  const posRows = positions.length
    ? positions.map(p => {
        const pos = p.position;
        const size = parseFloat(pos.szi);
        const isLong = size > 0;
        const pnl = parseFloat(pos.unrealizedPnl ?? "0");
        const liqPx = parseFloat(pos.liquidationPx ?? "0");
        return `<tr>
          <td><strong>${pos.coin}</strong></td>
          <td><span class="${isLong ? "pos-long" : "pos-short"}">${isLong ? "▲ LONG" : "▼ SHORT"}</span></td>
          <td>${Math.abs(size)}</td>
          <td>$${parseFloat(pos.entryPx ?? "0").toLocaleString(undefined, {maximumFractionDigits: 2})}</td>
          <td class="${pnl >= 0 ? "green" : "red"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</td>
          <td>$${parseFloat(pos.positionValue ?? "0").toFixed(2)}</td>
          <td class="red">${liqPx > 0 ? "$" + liqPx.toLocaleString(undefined, {maximumFractionDigits: 2}) : "—"}</td>
          <td><button class="btn btn-red" onclick="closePos(this, '${pos.coin}', 'hyperliquid')">Force Exit</button></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8" style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:1.5rem">No open positions</td></tr>`;

  const alpacaRows = alpacaPositions.length
    ? alpacaPositions.map(p => {
        const qty = parseFloat(p.qty ?? "0");
        const isLong = p.side === "long" || qty > 0;
        const pnl = parseFloat(p.unrealized_pl ?? "0");
        const entryPx = parseFloat(p.avg_entry_price ?? "0");
        const mktVal = parseFloat(p.market_value ?? "0");
        return `<tr>
          <td><strong>${p.symbol}</strong></td>
          <td><span class="${isLong ? "pos-long" : "pos-short"}">${isLong ? "▲ LONG" : "▼ SHORT"}</span></td>
          <td>${Math.abs(qty)}</td>
          <td>$${entryPx.toLocaleString(undefined, {maximumFractionDigits: 4})}</td>
          <td class="${pnl >= 0 ? "green" : "red"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</td>
          <td>$${mktVal.toFixed(2)}</td>
          <td class="red">—</td>
          <td><button class="btn btn-red" onclick="closePos(this, '${p.symbol}', 'alpaca')">Force Exit</button></td>
        </tr>`;
      }).join("")
    : null;

  return shell("Positions", `
    ${!PRIVATE_KEY ? '<p style="color:#f87171;margin-bottom:1rem">⚠️ AGENT_PRIVATE_KEY not set — run <code>npm run setup</code></p>' : ""}
    <p class="section-label">Account</p>
    ${stats}
    <p class="section-label">Hyperliquid Positions</p>
    <div class="card">
      <table>
        <thead><tr><th>Asset</th><th>Side</th><th>Size</th><th>Entry</th><th>Unrealized P&L</th><th>Value</th><th>Liq. Price</th><th></th></tr></thead>
        <tbody>${posRows}</tbody>
      </table>
    </div>
    ${alpacaRows !== null ? `
    <p class="section-label" style="margin-top:1.5rem">Alpaca Positions${process.env.ALPACA_PAPER === "true" ? ' <span style="font-size:0.65rem;color:rgba(255,255,255,0.35);text-transform:none;letter-spacing:0">(paper)</span>' : ""}</p>
    <div class="card">
      <table>
        <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Unrealized P&L</th><th>Market Value</th><th>Liq. Price</th><th></th></tr></thead>
        <tbody>${alpacaRows || `<tr><td colspan="8" style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:1.5rem">No open positions</td></tr>`}</tbody>
      </table>
    </div>` : ""}
    <p class="section-label" style="margin-top:2rem">x402 Signal Spend · <span style="color:rgba(255,255,255,0.35);font-size:0.65rem;text-transform:none;letter-spacing:0">${payNetworkLabel}</span></p>
    <div class="stat-row">
      <div class="stat"><div class="label">Today's Fetches</div><div class="value">${fetchesToday.total.toLocaleString()}</div></div>
      <div class="stat"><div class="label">Today's Spend</div><div class="value cyan">$${fetchesToday.spend.toFixed(3)}</div></div>
      <div class="stat"><div class="label">All-Time Fetches</div><div class="value" style="font-size:0.95rem">${fetchesTotal.total.toLocaleString()}</div></div>
      <div class="stat"><div class="label">All-Time Spend</div><div class="value" style="font-size:0.95rem">$${fetchesTotal.spend.toFixed(2)}</div></div>
      <div class="stat"><div class="label">${payNetworkLabel} USDC</div><div class="value ${networkUsdc !== null && networkUsdc < 0.05 ? "red" : "cyan"}">${networkUsdc !== null ? "$" + networkUsdc.toFixed(4) : "—"}</div></div>
    </div>
    ${networkUsdc !== null && networkUsdc < 0.05 ? `<p style="font-size:0.78rem;color:#f87171;margin-bottom:1.5rem">⚠️ Low ${payNetworkLabel} USDC — top up to continue fetching signals.</p>` : ""}
    <p class="hint">Auto-refreshes every 30s · <a href="/positions">Refresh now</a></p>
    <script>
      setTimeout(() => location.reload(), 30000);
      async function closePos(btn, asset, exchange) {
        const exchLabel = exchange === 'alpaca' ? 'Alpaca' : 'Hyperliquid';
        if (!confirm('Force close ' + asset + ' position on ' + exchLabel + '?')) return;
        btn.textContent = 'Closing...'; btn.disabled = true;
        const res = await fetch('/api/close', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({asset, exchange}) });
        const d = await res.json();
        if (d.ok) { btn.textContent = 'Closed ✓'; btn.style.color='#4ade80'; setTimeout(()=>location.reload(),1500); }
        else { btn.textContent = 'Error'; btn.disabled = false; alert(d.error); }
      }
    </script>
  `, "positions");
}

function tvSymbol(symbol) {
  const base = symbol.replace(/-USD$/i, "").replace(/\/USD$/i, "").toUpperCase();
  const crypto = { BTC:"BINANCE:BTCUSDT",ETH:"BINANCE:ETHUSDT",SOL:"BINANCE:SOLUSDT",BNB:"BINANCE:BNBUSDT",XRP:"BINANCE:XRPUSDT",ADA:"BINANCE:ADAUSDT",AVAX:"BINANCE:AVAXUSDT",DOGE:"BINANCE:DOGEUSDT",LINK:"BINANCE:LINKUSDT",DOT:"BINANCE:DOTUSDT",MATIC:"BINANCE:MATICUSDT",POL:"BINANCE:POLUSDT",UNI:"BINANCE:UNIUSDT",ATOM:"BINANCE:ATOMUSDT",LTC:"BINANCE:LTCUSDT",SHIB:"BINANCE:SHIBUSDT",TRX:"BINANCE:TRXUSDT",SUI:"BINANCE:SUIUSDT",APT:"BINANCE:APTUSDT",INJ:"BINANCE:INJUSDT",NEAR:"BINANCE:NEARUSDT",ARB:"BINANCE:ARBUSDT",OP:"BINANCE:OPUSDT",WIF:"BINANCE:WIFUSDT",PEPE:"BINANCE:PEPEUSDT",BONK:"BINANCE:BONKUSDT" };
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
        const tv = tvSymbol(s.symbol);
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
                <span>${s.leverage}x leverage · ${size} · ${s.exchange === "kraken" ? "Kraken" : s.exchange === "alpaca" ? "Alpaca" : "Hyperliquid"} · every ${s.interval_minutes >= 1440 ? "day" : s.interval_minutes + "min"}${s.tp_pct ? ` · TP ${s.tp_pct}% → trail ${s.trail_pct ?? 0.5}%` : ""}</span>
                ${latest?.date ? `<span>Signal: ${latest.date}</span>` : ""}
                <span style="font-family:monospace">${s.id.slice(0,8)}…
                  <button onclick="copyId('${s.id}', this);event.stopPropagation()" style="background:none;border:1px solid rgba(255,255,255,0.1);border-radius:3px;color:rgba(255,255,255,0.3);cursor:pointer;font-size:0.6rem;padding:0.05rem 0.3rem;margin-left:0.2rem;vertical-align:middle">copy</button>
                </span>
                <button class="info-btn strategy-info-btn" data-strategy="${sdJson}" title="Conditions" onclick="showStrategyInfo(this);event.stopPropagation()"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
              </div>
            </div>
            <div style="display:flex;gap:0.4rem;align-items:center;flex-shrink:0" onclick="event.stopPropagation()">
              ${s.active
                ? `<button class="btn btn-red" onclick="showToggleModal(this, '${s.id}', false, '${s.symbol}')">Deactivate</button>`
                : `<button class="btn btn-green" onclick="showToggleModal(this, '${s.id}', true, '${s.symbol}')">Activate</button>`}
              <button class="btn btn-cyan" onclick="runNow(this, '${s.id}', '${s.name.replace(/'/g, "\\'")}')">▶ Run Now</button>
              <button class="btn btn-green" onclick="openPosition(this, '${s.id}', 'buy', '${s.symbol}')">Open Long</button>
              <button class="btn btn-red" onclick="openPosition(this, '${s.id}', 'sell', '${s.symbol}')">Open Short</button>
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
    const TV_SYMBOLS = ${JSON.stringify(Object.fromEntries(strategies.map(s => [s.id, tvSymbol(s.symbol)])))};

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
    function openPosition(btn, id, side, symbol) {
      const label = side === 'buy' ? 'Open Long' : 'Open Short';
      const color = side === 'buy' ? '#4ade80' : '#f87171';
      const confirmCls = side === 'buy' ? 'modal-confirm-green' : 'modal-confirm-red';
      document.getElementById('openModalTitle').textContent = label + ' — ' + symbol;
      document.getElementById('openModalBody').innerHTML =
        '<p>This places a <strong>market order immediately</strong>, regardless of the current signal.</p>' +
        '<div class="flow" style="margin-top:0.75rem">' +
          '<div class="flow-step"><span class="num">1</span><span>Any existing position will be closed first</span></div>' +
          '<div class="flow-step"><span class="num">2</span><span>A new ' + label.toLowerCase() + ' market order will be placed</span></div>' +
        '</div>';
      const confirmBtn = document.getElementById('openModalConfirm');
      confirmBtn.textContent = label;
      confirmBtn.className = confirmCls;
      confirmBtn.onclick = async () => {
        confirmBtn.textContent = 'Placing order…';
        confirmBtn.disabled = true;
        document.getElementById('openModal').classList.remove('open');
        btn.textContent = 'Executing…'; btn.disabled = true;
        try {
          const res = await fetch('/api/open', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id, side}) });
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
          ${field("Default Position Size (USD)", "HL_POSITION_SIZE_USD", val("HL_POSITION_SIZE_USD") || "10", "text", "Per-trade size used when a strategy has no size override")}
        `)}

        ${section("Hyperliquid", "⚡", `
          ${field("Private Key", "AGENT_PRIVATE_KEY", val("AGENT_PRIVATE_KEY"), "password", "0x-prefixed EVM key — trading + x402 payments")}
          <div id="walletInfo" style="font-size:0.72rem;color:rgba(255,255,255,0.3);padding:0.5rem 0.75rem;background:rgba(255,255,255,0.03);border-radius:6px;display:none">
            Wallet: <span id="walletAddr" style="font-family:monospace;color:rgba(168,241,247,0.7)"></span>
          </div>
        `)}

        ${section("Kraken", "🦀", `
          ${field("API Key", "KRAKEN_API_KEY", val("KRAKEN_API_KEY"), "text", `kraken.com → Security → API — enable Trade`)}
          ${field("API Secret", "KRAKEN_API_SECRET", val("KRAKEN_API_SECRET"), "password", "Base64-encoded, shown once at creation")}
        `)}

        ${section("Alpaca", "🦙", `
          ${field("API Key", "ALPACA_API_KEY", val("ALPACA_API_KEY"), "text", `alpaca.markets → Your Account → API Keys`)}
          ${field("API Secret", "ALPACA_API_SECRET", val("ALPACA_API_SECRET"), "password", "Shown once at creation")}
          <div>
            <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer;font-size:0.82rem;color:rgba(255,255,255,0.6)">
              <input type="checkbox" name="ALPACA_PAPER" value="true" ${val("ALPACA_PAPER") === "true" ? "checked" : ""} style="width:auto;accent-color:#A8F1F7" />
              Paper trading mode <span style="font-size:0.7rem;color:rgba(255,255,255,0.3)">(paper-api.alpaca.markets)</span>
            </label>
          </div>
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
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Position Size (USD)</label>
            <input name="position_size_usd" type="number" placeholder="e.g. 100" style="width:100%" />
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
              <option value="kraken">Kraken (spot / margin)</option>
              <option value="alpaca">Alpaca (stocks / crypto)</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.75rem;color:rgba(255,255,255,0.4);display:block;margin-bottom:0.3rem">Check Every</label>
            <select name="interval_minutes" style="width:100%">
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

// ── API handlers ──────────────────────────────────────────────────────────────

async function handleClose(body) {
  const { asset, exchange } = JSON.parse(body);
  if (exchange === "alpaca") {
    if (!process.env.ALPACA_API_KEY) return { ok: false, error: "ALPACA_API_KEY not set" };
    const { AlpacaExchange } = await import("./exchanges/alpaca.mjs");
    const alp = new AlpacaExchange(process.env.ALPACA_API_KEY, process.env.ALPACA_API_SECRET, process.env.ALPACA_PAPER === "true");
    const result = await alp.closePosition(asset);
    return { ok: true, asset, result };
  }
  if (!PRIVATE_KEY) return { ok: false, error: "AGENT_PRIVATE_KEY not set" };
  const { HyperliquidExchange } = await import("./exchanges/hyperliquid.mjs");
  const exch = new HyperliquidExchange(PRIVATE_KEY);
  const result = await exch.closePosition(asset);
  return { ok: true, asset, result };
}

async function handleToggle(body) {
  const { id, active } = JSON.parse(body);
  setStrategyActive(id, active);
  return { ok: true };
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
  const positionSize = parseFloat((sizeUsd / midPrice).toFixed(5));
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

  // Fetch live signal
  const { x402Client } = await import("@x402/core/client");
  const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");
  const { createPublicClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const allChains = await import("viem/chains");

  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = new x402Client();

  const url = `${getSignalUrl()}/api/strategy/${id}/signal`;
  let signalData = null;
  try {
    const probe = await fetch(url);
    console.log(`[run-strategy] probe status: ${probe.status}`);
    if (probe.ok) {
      signalData = await probe.json();
    } else if (probe.status === 402) {
      const rawHeader = probe.headers.get("X-PAYMENT-REQUIRED");
      if (!rawHeader) throw new Error("No X-PAYMENT-REQUIRED header");
      const paymentRequired = decodePaymentRequiredHeader(rawHeader);

      // Network comes from the server's 402 response — no local setting needed
      const serverNetwork = paymentRequired.accepts?.[0]?.network ?? paymentRequired.accepts?.network;
      const networkCfg = X402_NETWORKS[serverNetwork] ?? X402_NETWORKS[getPaymentNetwork()] ?? X402_NETWORKS["eip155:42161"];
      const chain = allChains[networkCfg.viemChain];
      const publicClient = createPublicClient({ chain, transport: http(networkCfg.rpc) });
      const signer = toClientEvmSigner(account, publicClient);
      client.register(serverNetwork, new ExactEvmScheme(signer));

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const paid = await fetch(url, { headers: { "X-PAYMENT": encodePaymentSignatureHeader(paymentPayload) } });
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
  const positionSize = parseFloat((sizeUsd / midPrice).toFixed(5));
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
      pnl = parseFloat(((midPrice - entryPrice) * Math.abs(currentSize) * leverage * dir).toFixed(2));
    }
    await exch.closePosition(asset);
    action = `CLOSED ${Math.abs(currentSize)} ${asset} @ ~$${midPrice.toLocaleString()}`;
  } else if (signal === "SHORT" && !isFlat) {
    if (entryPrice > 0 && isLong) {
      pnl = parseFloat(((midPrice - entryPrice) * Math.abs(currentSize) * leverage).toFixed(2));
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
  const { id, side } = JSON.parse(body);
  if (side !== "buy" && side !== "sell") return { ok: false, error: "side must be buy or sell" };
  const strategy = getStrategy(id);
  if (!strategy) return { ok: false, error: "Strategy not found" };

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
  const positionSize = parseFloat((sizeUsd / midPrice).toFixed(5));
  const position = await exch.getPosition(asset);
  const currentSize = parseFloat(position?.szi ?? "0");

  if (currentSize !== 0) await exch.closePosition(asset);
  await exch.setLeverage(asset, leverage);
  await exch.placeMarketOrder(asset, side, positionSize);
  const action = `${side === "buy" ? "ENTERED LONG" : "SHORTED"} ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x) [manual]`;

  const { insertTrade } = await import("./db.mjs");
  insertTrade({ strategy_id: id, action, asset, size: positionSize, price: midPrice, leverage });
  return { ok: true, action };
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
                          "X402_PAYMENT_NETWORK"]) {
        const v = params.get(key)?.trim();
        if (v) updates[key] = v;
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
