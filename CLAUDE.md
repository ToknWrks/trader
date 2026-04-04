# CLAUDE.md — AgentSignal Trader

## Overview

Standalone local trading agent for [agentsignal.app](https://agentsignal.app) strategies.
Fetches live signals via x402, detects flips, and executes market orders on Hyperliquid perps.
Your private key never leaves your machine.

- **Repo**: `github.com/ToknWrks/trader`
- **AgentSignal app**: `/Users/lancepitman/AgentSignal/` (separate repo)
- **Dashboard**: `http://localhost:4100` (run `npm run dashboard`)

## Commands

```bash
npm run setup        # interactive setup wizard (first-time)
npm run dashboard    # local control panel at localhost:4100
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
| `setup.mjs` | Interactive setup wizard |
| `ecosystem.config.cjs` | PM2 config (3 processes) |

## PM2 Schedule

| Process | Args | Cron | When |
|---|---|---|---|
| `trader` | `--stocks-only` | `31 13 * * 1-5` | 9:31 AM ET, weekdays |
| `trader-crypto` | `--crypto-only` | `0 * * * *` | top of every hour, 24/7 |
| `trader-dashboard` | — | always-on | — |

Crypto strategies run hourly because Hyperliquid is a 24/7 market. Stock/ETF strategies run once at market open.

## Crypto Detection

`isCrypto(symbol)` in `trader.mjs` strips `-USD`/`/USD` suffix and checks against `CRYPTO_TICKERS` set (50 tickers). Same list is mirrored in `dashboard.mjs` for the activation modal schedule display.

## Signal Flow

1. Fetch signal from `AGENT_SIGNAL_URL/api/strategy/:id/signal` via x402 ($0.001 USDC on Base)
2. Store in SQLite `signals` table
3. Compare to prior signal — if unchanged, hold
4. If flipped: FLAT→LONG = buy, LONG→FLAT = close, LONG→SHORT = close+short

## Hyperliquid Notes

- **SDK**: `@nktkas/hyperliquid` with viem WalletClient — do NOT use custom EIP-712 (derives wrong address)
- **Asset index**: `order.a` must be a number. Use `InfoClient.meta()` to resolve ticker → index
- **Unified account**: spot USDC is directly usable as perp collateral (no transfer needed)
- **Position size**: `HL_POSITION_SIZE_USD` → converted to asset units at runtime via `getMidPrice()`

## x402 Payments

- `$0.001` USDC per signal fetch, paid on Base mainnet
- Requires USDC on Base at the `AGENT_PRIVATE_KEY` wallet address
- Dashboard positions page shows current Base USDC balance + estimated total spend

## Dashboard Features

- Activate/deactivate strategies (styled confirm modal — no browser `confirm()`)
- Status column ℹ popover explaining execution flow
- Activation modal shows correct schedule (hourly vs market open) based on strategy symbol
- `parseSchedules()` reads cron from `ecosystem.config.cjs` at runtime — not hardcoded
- Positions page: open Hyperliquid positions + x402 spend tracker

## SQLite Schema (`data/trader.db`)

```sql
strategies (id, name, symbol, leverage, position_size_usd, active)
signals    (strategy_id, date, signal, price, notes)  -- UNIQUE(strategy_id, date)
trades     (strategy_id, date, action, asset, size, price, leverage, result_json)
```

- `active` is INTEGER 0/1 (not boolean)

## Environment Variables (`.env`)

```
AGENT_PRIVATE_KEY      # 0x-prefixed EVM key — used for both HL signing and x402 payments
AGENT_SIGNAL_URL       # https://agentsignal.app (or http://localhost:3001 for local dev)
HL_POSITION_SIZE_USD   # notional trade size in USD (e.g. 10)
COINGECKO_API_KEY      # optional, for rate limit relief
```

## Liquidation Note

The trader executes on signal flips only — it does not monitor positions in real time. If leverage is used and price moves sharply between runs, Hyperliquid's own engine handles liquidation at the exchange level. The agentsignal.app backtest simulates liquidation risk so you can assess historical exposure before going live.
