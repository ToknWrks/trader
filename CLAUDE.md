# CLAUDE.md — AgentSignal Trader

## Overview

Standalone local trading agent for [agentsignal.app](https://agentsignal.app) strategies.
Fetches live signals via x402, detects flips, and executes market orders on Hyperliquid perps.
Your private key never leaves your machine.

- **Repo**: `github.com/ToknWrks/trader`
- **AgentSignal app**: `/Users/lancepitman/AgentSignal/` (separate repo)
- **Dashboard**: `http://localhost:4100` (run `npm run dashboard`)

## Roadmap

### Phase 1 — Hardening
- [ ] Balance pre-flight check — guard against orders with insufficient funds
- [ ] Circuit breaker — halt trade runner on repeated exchange errors

### Phase 2 — AgentSignal Integration (Vercel)
- [ ] Migrate UI: `dashboard.mjs` → Next.js App Router + React components
- [ ] Migrate scheduling: PM2 cron → Vercel Cron Jobs → API routes
- [ ] Migrate database: SQLite → Neon Postgres
- [ ] Migrate wallet: `AGENT_PRIVATE_KEY` → browser wallet (Wagmi/RainbowKit)
- [ ] x402 payment flow: client-side wallet signs, API route relays

### Phase 3 — Key Management (VultiSig MPC) ✅ COMPLETE
- [x] Fast Vault (2-of-2) — `VAULT_ACTIVE=true`, `VULT_FILE_PATH`
- [x] VultiSig SDK for HL EIP-712 signing
- [x] VultiSig for x402 payment signing
- [x] Circuit breaker: halt if VultiServer unreachable

### Phase 3b — VPS-hosted Trader
- [ ] Vault onboarding UI in AgentSignal dashboard
- [ ] Per-user Neon Postgres DB
- [ ] VPS cron replacing PM2
- [ ] Multi-tenancy model (shared process vs per-user)

See `docs/vps-trader.md` for full architecture, open questions, and Engine comparison.

### Phase 4 — Ticker Signal Engine (Bring-Your-Own-Key AI)
- [ ] `ticker-signal/` scaffold (providers/, prompts/, score.mjs)
- [ ] Venice provider (primary — privacy-preserving)
- [ ] Alchemy + CoinGecko providers (on-chain + market data)
- [ ] xAI/Grok or Anthropic provider (inference)
- [ ] Composite score (−5 to +5) as new condition source: `{ "source": "ticker_signal", "field": "score", "op": "<=", "value": -2 }`
- [ ] Settings page for user-supplied inference API keys
- [ ] Score surfaced read-only on AgentSignal strategy detail page

---

## To Do

- [ ] **Balance pre-flight check** — in `runGuards()` before orders: call `getAccountState()`, read `marginSummary.withdrawable`, compare to `sizeUsd / leverage`. Block + log if insufficient. Add `getBalance()` to `HyperliquidExchange` and other exchange classes.

## Commands

```bash
npm run setup        # interactive setup wizard (first-time)
npm run dashboard    # local control panel at localhost:4100
npm run restart      # restart dashboard + PM2 processes
npm start            # start all PM2 processes
npm run trade        # manual one-shot run (all strategies)
node trader.mjs --dry-run          # simulate without executing
node trader.mjs --crypto-only      # only crypto strategies
node trader.mjs --stocks-only      # only stock/ETF strategies
```

## Files

| File | Purpose |
|---|---|
| `trader.mjs` | Main runner — fetch signal, detect flip, execute |
| `dashboard.mjs` | Local web dashboard (HTTP server, no framework) |
| `db.mjs` | SQLite via better-sqlite3: strategies, signals, trades |
| `hyperliquid.mjs` | Hyperliquid client (`@nktkas/hyperliquid` + viem) |
| `vultisig-vault.mjs` | VultiSig Fast Vault signing |
| `setup.mjs` | Interactive setup wizard |
| `ecosystem.config.cjs` | PM2 config (3 processes) |

## PM2 Schedule

| Process | Args | Cron | When |
|---|---|---|---|
| `trader` | `--stocks-only` | `31 13 * * 1-5` | 9:31 AM ET, weekdays |
| `trader-crypto` | `--crypto-only` | `0 * * * *` | top of every hour, 24/7 |
| `trader-dashboard` | — | always-on | — |

## Crypto Detection

`isCrypto(symbol)` strips `-USD`/`/USD` and checks against `CRYPTO_TICKERS` set (50 tickers). Mirrored in `dashboard.mjs` for activation modal schedule display.

## Entry Gate & Adaptive Risk (scalpers)

`confirmEntry()` in `trader.mjs` — runs before every new scalper entry, never blocks exits. Fails open on candle fetch errors.

| Layer | Check | Threshold |
|---|---|---|
| L1 RSI band | RSI(14) on strategy interval | LONG: 40–65 · SHORT: 35–60 |
| L2 EMA50 trend | Price vs EMA(50) | LONG must be above, SHORT below |
| L3 ATR regime | ATR(14) vs ATR(50) | Block if ATR(14) > 1.5× ATR(50) |
| L4 BTC macro | BTC 4h candle change | Block if BTC down > 2.5% |

**Adaptive SL:** `1.5 × ATR(14) / price × 100`, clamped [3%, 15%], written to `strategies.sl_pct` at entry. See `docs/entry-gate.md` for full tuning guide, threshold rationale, and known limitations.

## Signal Flow

1. Fetch from `AGENT_SIGNAL_URL/api/strategy/:id/signal` via x402 ($0.01 USDC on Base)
2. Store in SQLite `signals` table
3. Compare to prior — if unchanged, hold
4. If flipped: FLAT→LONG = buy, LONG→FLAT = close, LONG→SHORT = close+short

## Hyperliquid Notes

- **SDK**: `@nktkas/hyperliquid` + viem WalletClient — do NOT use custom EIP-712 (derives wrong address)
- **Asset index**: `order.a` must be a number — use `InfoClient.meta()` to resolve ticker → index
- **unifiedAccount mode**: spot + perp USDC are ONE balance. `clearinghouseState.withdrawable` = 0 and meaningless. Real available = `spotUsdc − marginSummary.totalMarginUsed`. Do NOT use `withdrawable + spot` (double-counts). `usdClassTransfer` is blocked.
- **default mode**: perp and spot are separate. Sweep spot→perp with `usdClassTransfer({ toPerp: true })` before withdraw.
- Dashboard funding code branches on abstraction mode — unified skips Spot→Perp button.

## x402 Payments

- `$0.01` USDC per signal fetch on Base mainnet
- Requires USDC on Base at the signing wallet address
- Dashboard positions page shows Base USDC balance + estimated total spend

## Dashboard Features

- Activate/deactivate strategies (styled confirm modal — no browser `confirm()`)
- Status column ℹ popover explaining execution flow
- Activation modal shows correct schedule (hourly vs market open) by symbol
- `parseSchedules()` reads cron from `ecosystem.config.cjs` at runtime
- Positions page: open HL positions + x402 spend tracker

## SQLite Schema (`data/trader.db`)

```sql
strategies (id, name, symbol, leverage, position_size_usd, active, sl_pct, tp_pct, trail_pct, risk_mode)
signals    (strategy_id, date, signal, price, notes)  -- UNIQUE(strategy_id, date)
trades     (strategy_id, date, action, asset, size, price, leverage, pnl, result_json)
```

- `active` is INTEGER 0/1 (not boolean)

## Environment Variables (`.env`)

```
AGENT_PRIVATE_KEY      # 0x-prefixed EVM key (fallback when VAULT_ACTIVE=false)
AGENT_SIGNAL_URL       # https://agentsignal.app (or http://localhost:3001 for local dev)
HL_POSITION_SIZE_USD   # notional trade size in USD (e.g. 10)
VAULT_ACTIVE           # true = use VultiSig Fast Vault instead of raw key
VULT_FILE_PATH         # path to vault file (required when VAULT_ACTIVE=true)
COINGECKO_API_KEY      # optional, for rate limit relief
```

## Liquidation Note

Trader executes on signal flips only — no real-time position monitoring. If price moves sharply between runs at leverage, Hyperliquid's engine handles liquidation. The entry gate (L3 ATR regime + L4 BTC macro) reduces the chance of entering into a move that leads to liquidation, but does not prevent it once in a position.
