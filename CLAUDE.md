# CLAUDE.md — AgentSignal Trader

## Overview

Standalone local trading agent for [agentsignal.app](https://agentsignal.app) strategies.
Fetches live signals via x402, detects flips, and executes market orders on Hyperliquid perps.
Your private key never leaves your machine.

- **Repo**: `github.com/ToknWrks/trader`
- **AgentSignal app**: `/Users/lancepitman/AgentSignal/` (separate repo)
- **Dashboard**: `http://localhost:4100` (run `npm run dashboard`)

## Roadmap

### Phase 1 — Hardening (local trader)
- [ ] Balance pre-flight check — guard against orders with insufficient funds
- [ ] Circuit breaker — halt trade runner on repeated exchange errors

### Phase 2 — AgentSignal Integration (Vercel)
- [ ] Migrate UI: `dashboard.mjs` → Next.js App Router + React components
- [ ] Migrate scheduling: PM2 cron → Vercel Cron Jobs → API routes
- [ ] Migrate database: SQLite (`better-sqlite3`) → Neon Postgres
- [ ] Migrate wallet: `AGENT_PRIVATE_KEY` in `.env` → browser wallet (Wagmi/RainbowKit)
- [ ] x402 payment flow: client-side wallet signs, API route relays

### Phase 3 — Key Management (VultiSig MPC) ✅ COMPLETE (local trader)
- [x] Fast Vault (2-of-2) setup — replaces raw private key (`VAULT_ACTIVE=true`, `VULT_FILE_PATH`)
- [x] Replace viem `signTypedData()` with VultiSig SDK for HL EIP-712 signing
- [x] Replace viem WalletClient with VultiSig for x402 payment signing
- [x] Circuit breaker: halt runner if VultiServer unreachable
- [ ] **Phase 3b — VPS-hosted Trader** — run the Trader on a VPS so users don't need a local machine. Fast Vault remains the key model: VPS holds device share, VultiServer holds server share. Neither alone can sign. Users onboard via vault setup in the AgentSignal UI — no npm install, no local setup. See architectural notes below.

### Phase 4 — Ticker Signal Engine (Bring-Your-Own-Key AI)
- [ ] `ticker-signal/` module scaffold (providers/, prompts/, score.mjs)
- [ ] Venice provider (primary — privacy-preserving, no data retention)
- [ ] Alchemy + CoinGecko providers (on-chain + market data)
- [ ] xAI/Grok or Anthropic provider (inference)
- [ ] Composite score (−5 to +5) wired into strategy condition evaluator
- [ ] Settings page for user-supplied inference API keys
- [ ] Score surfaced read-only on AgentSignal strategy detail page

### Phase 3b — VPS-hosted Trader (architectural notes)

**Problem:** requiring users to run trader locally is the biggest adoption blocker. Most people will not `npm install` and configure a local process.

**Proposed solution:** run the Trader on an AgentSignal-managed VPS. Users set up a Fast Vault via the AgentSignal UI (no CLI), and the VPS trader process uses that vault for all signing.

**Why Fast Vault on VPS is safe (unlike Engine's model):**
- VPS holds one share of the Fast Vault key — useless alone
- VultiServer (Vultisig infrastructure) holds the other share
- A VPS breach exposes only one share — cannot sign without VultiServer
- Engine almost certainly holds a complete hot wallet key on their VPS — a single point of failure
- Circuit breaker: if VultiServer is unreachable, Trader halts rather than failing silently

**What changes vs current local Trader:**
- Scheduling: PM2 cron → server-side cron (Vercel Cron Jobs or VPS cron)
- Database: SQLite → Neon Postgres (shared, per-user)
- Vault onboarding: CLI setup → UI flow in AgentSignal dashboard
- Key storage: `.env` file → vault share on VPS (never a complete key)
- x402 payments: still signed by vault on VPS

**What stays the same:**
- All exchange client logic (`hyperliquid.mjs`, etc.)
- Signal fetch + flip detection logic
- Entry gate + adaptive risk layer
- VultiSig signing path (already implemented)

**Differentiation vs Engine:**
- Fast Vault: no single server holds a complete signing key
- Deterministic signals with backtests vs LLM prose interpretation
- Open source execution layer users can audit or self-host
- Per-call x402 pricing vs subscription lock-in

---

## To Do

- [ ] **Balance pre-flight check** — Add a balance/margin check to `runGuards()` (or `executeTrade()`) before submitting orders. For Hyperliquid, call `getAccountState()` and read `marginSummary.withdrawable` (or `accountValue`); compare against `sizeUsd / leverage` (required initial margin). Block the trade and log clearly if insufficient funds. Add a `getBalance()` method to `HyperliquidExchange` (and other exchange classes) to standardise the interface.

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

## Entry Gate & Adaptive Risk (scalpers)

`confirmEntry()` in `trader.mjs` runs before every new scalper entry. Exits (FLAT signals) are never blocked. Fails open — a candle fetch error allows the entry so a network blip can't strand the strategy.

### Four layers (run in order — first block wins)

| Layer | What it checks | Threshold | Block condition |
|---|---|---|---|
| L1 RSI band | RSI(14) on the strategy's own interval | LONG: 40–65 · SHORT: 35–60 | Outside band → block. Prevents overbought chasing and oversold panic entries |
| L2 EMA50 trend | Price vs EMA(50) on the strategy's interval | — | LONG below EMA50, or SHORT above EMA50 → block. Only trade with the trend |
| L3 ATR regime | ATR(14) vs ATR(50) on the strategy's interval | Ratio > 1.5× | Elevated volatility → block. ATR(14) blowing out vs its own average signals a stress event |
| L4 BTC macro | BTC 4h candle change (always HL, always 4h) | Drop > 2.5% | BTC down hard → block all alt entries. Most alt liquidation events are BTC-led |

### Adaptive SL

At each passing entry, SL is computed as `1.5 × ATR(14) / price × 100`, clamped between 3% and 15%. This value is written to `strategies.sl_pct` in the DB so `checkTpTrail` uses it on every subsequent run for that trade. The SL adapts to conditions at entry time — tighter in calm markets, wider in volatile ones — without requiring manual adjustment.

### Tuning guide

**Too many blocked entries (strategy rarely trades):**
- Widen RSI band: e.g. `[35, 70]` for longs
- Raise ATR ratio threshold: `1.8×` or `2.0×`
- Raise BTC drop threshold: `-3.5%`

**Too many losing trades (gate not filtering enough):**
- Tighten RSI band: e.g. `[45, 60]` for longs
- Lower ATR ratio threshold: `1.2×`
- Lower BTC drop threshold: `-1.5%`

**Adaptive SL too tight (stops firing on normal retracements):**
- Raise the multiplier: `2.0 × ATR(14)` instead of `1.5`
- Or raise the minimum clamp: `Math.max(5, ...)` instead of `3`

**Adaptive SL too wide (not protecting against big moves):**
- Lower the multiplier: `1.0 × ATR(14)`
- Or lower the max clamp: `Math.min(10, ...)` instead of `15`

### What this does NOT protect against

- Manual entries that bypass the runner entirely — dashboard trades skip all gates
- Gaps/flash crashes that blow through the SL price before the next 4h check
- Sustained BTC drawdowns where BTC drops 2% per candle repeatedly (L4 catches the first candle; subsequent ones may not trigger if each individual drop is under the threshold)

The ticker signal engine (Phase 4 roadmap) is the next evolution — adds AI-scored sentiment, on-chain flows, and funding rate analysis as a fifth gate.

## Signal Flow

1. Fetch signal from `AGENT_SIGNAL_URL/api/strategy/:id/signal` via x402 ($0.01 USDC on Base)
2. Store in SQLite `signals` table
3. Compare to prior signal — if unchanged, hold
4. If flipped: FLAT→LONG = buy, LONG→FLAT = close, LONG→SHORT = close+short

## Hyperliquid Notes

- **SDK**: `@nktkas/hyperliquid` with viem WalletClient — do NOT use custom EIP-712 (derives wrong address)
- **Asset index**: `order.a` must be a number. Use `InfoClient.meta()` to resolve ticker → index
- **Account abstraction mode matters** (`info.userAbstraction({ user })` → `unifiedAccount | portfolioMargin | dexAbstraction | disabled | default`):
  - **unifiedAccount**: spot + perp USDC are ONE balance (the `spotClearinghouseState` USDC figure IS the full balance). Spot USDC trades as perp margin directly (no transfer) and `withdraw3` pulls from the merged balance. `usdClassTransfer` is pointless/blocked here. CRITICAL: `clearinghouseState.withdrawable` reads 0 and is meaningless. Real **available/withdrawable = spotUsdc − marginSummary.totalMarginUsed** (total balance minus margin locked in open positions) — verified to match HL's own UI to the cent. Do NOT use `withdrawable + spot` (double-counts).
  - **default/other**: perp and spot are SEPARATE. Bridge deposits land in perp; `withdraw3` only sees perp `withdrawable`. To withdraw/trade spot USDC, sweep `spot→perp` first with `usdClassTransfer({ amount, toPerp: true })`.
  - Funding code in `dashboard.mjs` branches on this: unified = withdraw3 direct + no "Spot→Perp" button; otherwise auto-sweep on withdraw.
- **Position size**: `HL_POSITION_SIZE_USD` → converted to asset units at runtime via `getMidPrice()`

## x402 Payments

- `$0.01` USDC per signal fetch, paid on Base mainnet
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

## Planned: Integration into AgentSignal (Vercel)

Trader functionality will be integrated into the AgentSignal app (`/Users/lancepitman/AgentSignal/`) rather than built as a standalone Next.js app. The AgentSignal app is already a Next.js/Vercel project — this is an extension, not a greenfield build.

### Motivation
- Browser wallet connections (Wagmi/RainbowKit or similar) instead of raw private key in `.env`
- Vercel deployment — accessible from any device, no local machine required
- Modern React UI replacing the monolithic `dashboard.mjs` HTML server

### Architecture Changes

| Concern | Current | Target |
|---|---|---|
| UI | `dashboard.mjs` vanilla HTTP server | Next.js App Router + React components |
| Scheduling | PM2 cron (`ecosystem.config.cjs`) | Vercel Cron Jobs → API routes |
| Database | SQLite (`better-sqlite3`) | Neon Postgres (no persistent filesystem on Vercel) |
| Wallet / signing | `AGENT_PRIVATE_KEY` in `.env` | Browser wallet (Wagmi) — key never stored server-side |
| x402 payments | Server-side viem WalletClient | Client-side wallet signs payment; server relays |
| Trade execution | `trader.mjs` CLI | API route handler (same logic, different entry point) |

### Key Constraints
- Private key must NOT be stored in Vercel env vars — signing happens in the browser wallet
- x402 payment flow: browser wallet signs the EVM payment, API route includes the header in the AgentSignal fetch
- Hyperliquid order signing: same — wallet signs EIP-712 in browser, API route submits
- Exchange clients (`hyperliquid.mjs`, etc.) are plain JS — drop into API routes unchanged
- `computeRSI`/`computeSMA`/`computeEMA` and all indicator logic reusable as-is

### Key Management: VultiSig MPC

Preferred approach for the Vercel migration — replaces `AGENT_PRIVATE_KEY` in `.env`.

**Why VultiSig over envelope encryption:**
- Private key never exists as a complete value on any device or server
- Fast Vault (2-of-2): bot holds one share, VultiServer holds the other — fully automated signing without human approval
- Server breach exposes only one share — useless alone
- VultiSig explicitly supports autonomous agents / AI trading bots via Fast Vault

**Integration:**
- SDK: `@vultisig/sdk` (TypeScript) — `createFastVault()`, `prepareSendTx()`, `sign()`, `broadcastTx()`
- Replaces viem `signTypedData()` for Hyperliquid EIP-712 signing
- Replaces viem WalletClient for x402 payment signing
- EVM supported — covers all current exchanges
- User onboards via vault setup page instead of pasting a raw private key

**Tradeoff:** signing depends on VultiServer availability. Add a circuit breaker — if VultiServer is unreachable, halt the trade runner rather than fail silently.

**Docs:** https://docs.vultisig.com/

### Planned: Ticker Signal Engine (Bring-Your-Own-Key AI)

Ticker-specific AI signals computed locally in the trader — user supplies their own inference keys, we supply the prompts and scoring logic.

**Why trader-level (not signal/strategy layer):**
- Cost: per-ticker × N users × N intervals at the server layer = unsustainable. User pays their own inference bill.
- Fits existing pattern: trader already manages bring-your-own exchange keys (Alpaca, Kraken, Coinbase). Venice/Alchemy/Grok keys are the same mental model, same settings page.
- Ticker-specific AI signals are only useful for automated trading — that's the trader audience.

**Planned structure:**
```
trader/
  ticker-signal/
    providers/   (venice.mjs, alchemy.mjs, coingecko.mjs, grok.mjs)
    prompts/     (onchain.mjs, sentiment.mjs, technical.mjs)
    score.mjs    (composite score −5 to +5, same scale as COMPASS/RADAR)
```

**Integration into strategy engine:**
Score becomes a new condition source — no new evaluator plumbing:
```json
{ "source": "ticker_signal", "field": "score", "op": "<=", "value": -2 }
```
Same condition evaluator in `tryLocalEval`, same operator logic.

**Provider notes:**
- Venice is primary — privacy-preserving, no data retention, designed for bring-your-own-key agent workflows
- Alchemy for on-chain data, CoinGecko for market data, xAI/Grok or Anthropic for inference

**Environment variables to add:**
```
VENICE_API_KEY
XAI_API_KEY          # Grok
ANTHROPIC_API_KEY    # optional Claude inference
ALCHEMY_API_KEY      # on-chain data (already used for Uniswap positions)
```

Score output can be surfaced read-only on the AgentSignal strategy detail page (last computed score + timestamp) while keeping compute local to the trader.

### What Stays
- All exchange client modules (`exchanges/`)
- Signal flow logic from `trader.mjs`
- Indicator computation functions
- AgentSignal x402 fetch pattern
- SQLite schema maps 1:1 to Postgres (minor type adjustments)
