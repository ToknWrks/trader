#!/usr/bin/env node
/**
 * dashboard.mjs — AgentSignal Trader local dashboard
 * Open: http://localhost:4100
 */

import { createServer } from "http";
import { readFileSync } from "fs";
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
const AGENT_SIGNAL_URL = process.env.AGENT_SIGNAL_URL ?? "https://agentsignal.app";

// ── Schedule ──────────────────────────────────────────────────────────────────

function parseSchedule() {
  try {
    const content = readFileSync(resolve(__dirname, "ecosystem.config.cjs"), "utf8");
    const match = content.match(/cron_restart:\s*["']([^"']+)["']/);
    if (!match) return { cron: "—", label: "on schedule", detail: "Check ecosystem.config.cjs" };
    const [, cron] = match;
    const [minute, hour, , , days] = cron.split(" ");
    const utcH = parseInt(hour), utcM = parseInt(minute);
    // Approximate ET (EDT = UTC-4, EST = UTC-5 — show both)
    const edtH = utcH - 4, estH = utcH - 5;
    const fmt = (h, m) => `${((h + 24) % 24) % 12 || 12}:${String(m).padStart(2,"0")} ${h % 24 >= 12 ? "PM" : "AM"}`;
    const daysLabel = days === "1-5" ? "weekdays" : days === "*" ? "every day" : `days ${days}`;
    return {
      cron,
      label: `${fmt(edtH, utcM)} ET / ${fmt(estH, utcM)} EST on ${daysLabel}`,
      detail: `Cron: ${cron} — runs at ${hour}:${String(utcM).padStart(2,"0")} UTC on ${daysLabel}`,
    };
  } catch {
    return { cron: "—", label: "on schedule", detail: "Could not read ecosystem.config.cjs" };
  }
}

const SCHEDULE = parseSchedule();

import {
  getStrategies, getStrategy, upsertStrategy, setStrategyActive,
  deleteStrategy, getSignalHistory, getAllRecentTrades, getLatestSignal,
} from "./db.mjs";

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
`;

function shell(title, body, active = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — AgentSignal Trader</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div class="logo">
      <img src="${AGENT_SIGNAL_URL}/agentsignal-logo.png" alt="" onerror="this.style.display='none'" />
      AgentSignal Trader
    </div>
    <div class="nav-links">
      <a class="nav-link ${active === "positions" ? "active" : ""}" href="/positions">Positions</a>
      <a class="nav-link ${active === "strategies" ? "active" : ""}" href="/strategies">Strategies</a>
      <a class="nav-link ${active === "history" ? "active" : ""}" href="/history">History</a>
      <a class="nav-link" href="${AGENT_SIGNAL_URL}/navigator" target="_blank">Navigator ↗</a>
    </div>
  </header>
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

  <!-- Status info popover -->
  <div class="info-popover" id="infoPopover">
    <strong>How it works</strong>
    <div style="margin-top:0.5rem">
      <div style="display:flex;gap:0.4rem;margin-bottom:0.3rem"><span style="color:#A8F1F7;font-weight:700">1.</span> Strategy activates — no order is placed yet.</div>
      <div style="display:flex;gap:0.4rem;margin-bottom:0.3rem"><span style="color:#A8F1F7;font-weight:700">2.</span> Trader fetches the latest signal from agentsignal.app (pays $0.001 via x402).</div>
      <div style="display:flex;gap:0.4rem;margin-bottom:0.3rem"><span style="color:#A8F1F7;font-weight:700">3.</span> If the signal has <strong>flipped</strong> (e.g. FLAT → LONG), a market order is placed on Hyperliquid.</div>
      <div style="display:flex;gap:0.4rem"><span style="color:#A8F1F7;font-weight:700">4.</span> If signal hasn't changed, the trader holds and does nothing.</div>
    </div>
    <div class="sched">⏱ Runs automatically: ${SCHEDULE.label}<br><span style="opacity:0.5">${SCHEDULE.detail}</span></div>
  </div>

  <script>
    const SCHEDULE = ${JSON.stringify(SCHEDULE)};

    function closeModal() {
      document.getElementById('toggleModal').classList.remove('open');
    }
    document.getElementById('toggleModal').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });

    let _pendingToggle = null;
    function showToggleModal(btn, id, active) {
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
        <div class="modal-schedule">⏱ Next auto-run: \${SCHEDULE.label}<br><span style="opacity:0.6;font-size:0.7rem">\${SCHEDULE.detail}</span></div>
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

    function toggleInfoPopover(btn) {
      const pop = document.getElementById('infoPopover');
      if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
      const rect = btn.getBoundingClientRect();
      pop.style.top = (rect.bottom + 8 + window.scrollY) + 'px';
      pop.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';
      pop.classList.add('open');
    }
    document.addEventListener('click', function(e) {
      const pop = document.getElementById('infoPopover');
      if (pop.classList.contains('open') && !pop.contains(e.target) && !e.target.closest('.info-btn')) {
        pop.classList.remove('open');
      }
    });
  </script>
</body>
</html>`;
}

// ── Pages ─────────────────────────────────────────────────────────────────────

async function positionsPage() {
  let hlData = null, spotData = null;
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

  const positions = (hlData?.assetPositions ?? []).filter(p => parseFloat(p.position?.szi ?? "0") !== 0);
  const accountValue = parseFloat(hlData?.marginSummary?.accountValue ?? "0");
  const withdrawable = parseFloat(hlData?.withdrawable ?? "0");
  const usdcSpot = parseFloat(spotData?.balances?.find(b => b.coin === "USDC")?.total ?? "0");

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
          <td><button class="btn btn-red" onclick="closePos(this, '${pos.coin}')">Force Exit</button></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8" style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:1.5rem">No open positions</td></tr>`;

  return shell("Positions", `
    ${!PRIVATE_KEY ? '<p style="color:#f87171;margin-bottom:1rem">⚠️ AGENT_PRIVATE_KEY not set — run <code>npm run setup</code></p>' : ""}
    <p class="section-label">Account</p>
    ${stats}
    <p class="section-label">Open Positions</p>
    <div class="card">
      <table>
        <thead><tr><th>Asset</th><th>Side</th><th>Size</th><th>Entry</th><th>Unrealized P&L</th><th>Value</th><th>Liq. Price</th><th></th></tr></thead>
        <tbody>${posRows}</tbody>
      </table>
    </div>
    <p class="hint">Auto-refreshes every 30s · <a href="/positions">Refresh now</a></p>
    <script>
      setTimeout(() => location.reload(), 30000);
      async function closePos(btn, asset) {
        if (!confirm('Force close ' + asset + ' position on Hyperliquid?')) return;
        btn.textContent = 'Closing...'; btn.disabled = true;
        const res = await fetch('/api/close', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({asset}) });
        const d = await res.json();
        if (d.ok) { btn.textContent = 'Closed ✓'; btn.style.color='#4ade80'; setTimeout(()=>location.reload(),1500); }
        else { btn.textContent = 'Error'; btn.disabled = false; alert(d.error); }
      }
    </script>
  `, "positions");
}

function strategiesPage() {
  const strategies = getStrategies();

  const rows = strategies.length
    ? strategies.map(s => {
        const latest = getLatestSignal(s.id);
        const sig = latest?.signal ?? "—";
        const sigClass = sig === "LONG" ? "badge-long" : sig === "SHORT" ? "badge-short" : "badge-flat";
        const execLabel = sig === "LONG" ? `Open Long (${s.leverage}x)` : sig === "SHORT" ? `Open Short (${s.leverage}x)` : sig === "FLAT" ? "Close Position" : "Execute";
        const execColor = sig === "LONG" ? "btn-green" : sig === "SHORT" ? "btn-red" : "btn-red";
        return `<tr>
          <td><strong>${s.name}</strong><br><span style="font-size:0.7rem;color:rgba(255,255,255,0.3)">${s.id.slice(0,8)}...</span></td>
          <td class="cyan">${s.symbol}</td>
          <td>${sig !== "—" ? `<span class="${sigClass}">${sig}</span>` : "—"}${latest?.date ? `<br><span style="font-size:0.65rem;color:rgba(255,255,255,0.25)">${latest.date}</span>` : ""}</td>
          <td>${s.position_size_usd ? "$" + s.position_size_usd : `$${process.env.HL_POSITION_SIZE_USD ?? 10} <span style="font-size:0.65rem;color:rgba(255,255,255,0.3)">(default)</span>`}</td>
          <td>${s.leverage}x</td>
          <td>
            ${s.active
              ? `<span class="badge-active">● ACTIVE</span>`
              : `<span class="badge-inactive">○ INACTIVE</span>`}
          </td>
          <td style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
            ${s.active
              ? `<button class="btn btn-red" onclick="showToggleModal(this, '${s.id}', false)">Deactivate</button>`
              : `<button class="btn btn-green" onclick="showToggleModal(this, '${s.id}', true)">Activate</button>`}
            ${sig !== "—" ? `<button class="btn ${execColor}" onclick="execStrategy(this, '${s.id}','${execLabel}','${sig === "FLAT" ? "close" : "open"}')">${execLabel}</button>` : ""}
            <button class="btn btn-red" onclick="deleteStrat('${s.id}')">Delete</button>
          </td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:1.5rem">No strategies yet. <a href="/add-strategy">Add one →</a></td></tr>`;

  return shell("Strategies", `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <p class="section-label" style="margin:0">Strategies</p>
      <a href="/add-strategy" class="nav-link btn-cyan" style="font-size:0.78rem;padding:0.3rem 0.75rem;border-radius:6px;border:1px solid rgba(168,241,247,0.3);color:#A8F1F7">+ Add Strategy</a>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Strategy</th><th>Symbol</th><th>Signal</th><th>Size</th><th>Leverage</th><th>Status <button class="info-btn" onclick="toggleInfoPopover(this)" title="How it works"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button></th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <script>
      async function execStrategy(btn, id, label, type) {
        const msg = (type === 'close' ? 'Close position?' : 'Open position?') + '\\n\\n' + label;
        if (!confirm(msg)) return;
        btn.disabled = true; btn.textContent = 'Executing...';
        const res = await fetch('/api/execute', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) });
        const d = await res.json();
        if (d.ok) { btn.textContent = '✓ Done'; btn.style.color='#4ade80'; setTimeout(()=>location.reload(),1500); }
        else { btn.disabled = false; btn.textContent = label; alert(d.error); }
      }
      async function deleteStrat(id) {
        if (!confirm('Remove this strategy from the trader?\\n\\nThis does not close any open positions.')) return;
        await fetch('/api/strategy/' + id, { method: 'DELETE' });
        location.reload();
      }
    </script>
  `, "strategies");
}

function historyPage() {
  const trades = getAllRecentTrades(50);
  const strategies = getStrategies();

  const tradeRows = trades.length
    ? trades.map(t => {
        const isEntry = t.action.startsWith("ENTERED") || t.action.startsWith("SHORTED");
        return `<tr>
          <td>${t.created_at.slice(0, 16)}</td>
          <td>${t.strategy_name ?? t.strategy_id.slice(0,8)}</td>
          <td style="color:${isEntry ? "#4ade80" : "#f87171"}">${t.action}</td>
          <td>${t.price ? "$" + parseFloat(t.price).toLocaleString(undefined, {maximumFractionDigits: 2}) : "—"}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" style="color:rgba(255,255,255,0.25);font-style:italic;text-align:center;padding:1.5rem">No trades yet</td></tr>`;

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
    <p class="section-label">Trade Log</p>
    <div class="card">
      <table>
        <thead><tr><th>Time</th><th>Strategy</th><th>Action</th><th>Price</th></tr></thead>
        <tbody>${tradeRows}</tbody>
      </table>
    </div>
    ${sigSections}
  `, "history");
}

function addStrategyPage(error = "") {
  return shell("Add Strategy", `
    <p class="section-label">Add Strategy</p>
    <div class="card" style="max-width:480px">
      <p style="font-size:0.85rem;color:rgba(255,255,255,0.5);margin-bottom:1.25rem">
        Find your strategy ID at <a href="${AGENT_SIGNAL_URL}/navigator" target="_blank">agentsignal.app/navigator</a>
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
        <button type="submit" style="background:#A8F1F7;color:#09090b;border:none;border-radius:8px;padding:0.6rem 1.25rem;font-weight:600;cursor:pointer;font-size:0.875rem;margin-top:0.25rem">
          Add Strategy
        </button>
      </form>
    </div>
  `, "strategies");
}

// ── API handlers ──────────────────────────────────────────────────────────────

async function handleClose(body) {
  if (!PRIVATE_KEY) return { ok: false, error: "AGENT_PRIVATE_KEY not set" };
  const { asset } = JSON.parse(body);
  const { closePosition } = await import("./hyperliquid.mjs");
  const result = await closePosition(PRIVATE_KEY, asset);
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
    if (url === "/history") return send(historyPage());

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
    if (url.startsWith("/api/strategy/") && method === "DELETE") {
      const id = url.replace("/api/strategy/", "");
      deleteStrategy(id);
      return json({ ok: true });
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
