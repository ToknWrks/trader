/**
 * exchanges/schwab.mjs — Charles Schwab Individual Trader API
 *
 * Auth:    3-legged OAuth 2.0 (Authorization Code) with refresh token rotation
 * Tokens:  stored in data/schwab-tokens.json — rotated on every refresh
 * Trading: equities (market/limit) + options (sell-to-open, buy-to-close)
 *
 * Env required: SCHWAB_API_KEY, SCHWAB_APP_SECRET
 * Env optional: SCHWAB_REDIRECT_URI (default https://127.0.0.1)
 *               SCHWAB_ACCOUNT_HASH  (if you have multiple accounts)
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = resolve(__dirname, "../data/schwab-tokens.json");

const BASE      = "https://api.schwabapi.com";
const AUTH_URL  = BASE + "/v1/oauth/authorize";
const TOKEN_URL = BASE + "/v1/oauth/token";
const TRADER    = BASE + "/trader/v1";
const MARKET    = BASE + "/marketdata/v1";

// ── Token persistence ─────────────────────────────────────────────────────────

function loadTokens() {
  try { return JSON.parse(readFileSync(TOKENS_PATH, "utf8")); }
  catch { return null; }
}

function saveTokens(tokens) {
  mkdirSync(resolve(__dirname, "../data"), { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify({ ...tokens, saved_at: Date.now() }, null, 2));
}

// ── SchwabClient ──────────────────────────────────────────────────────────────

export class SchwabClient {
  constructor(clientId, clientSecret) {
    this.clientId     = clientId;
    this.clientSecret = clientSecret;
    this._tokens      = loadTokens();
  }

  get redirectUri() {
    return process.env.SCHWAB_REDIRECT_URI || "https://127.0.0.1";
  }

  isAuthorized() {
    return !!(this._tokens?.access_token);
  }

  tokenStatus() {
    if (!this._tokens) return { authorized: false };
    const refreshExpiresAt = (this._tokens.saved_at || 0) + 7 * 24 * 60 * 60 * 1000;
    const accessExpiresAt  = (this._tokens.saved_at || 0) + (this._tokens.expires_in || 1800) * 1000;
    const refreshDaysLeft  = Math.max(0, (refreshExpiresAt - Date.now()) / 86400000);
    return {
      authorized: true,
      refreshDaysLeft: refreshDaysLeft.toFixed(1),
      accessExpired: Date.now() > accessExpiresAt - 60_000,
      needsReauth: refreshDaysLeft < 0.1,
    };
  }

  // Step 1: send user here to authorize
  getAuthUrl() {
    const params = new URLSearchParams({
      response_type: "code",
      client_id:     this.clientId,
      redirect_uri:  this.redirectUri,
    });
    return AUTH_URL + "?" + params.toString();
  }

  _basicAuth() {
    return "Basic " + Buffer.from(this.clientId + ":" + this.clientSecret).toString("base64");
  }

  // Step 2: exchange authorization code for tokens (3-legged)
  async exchangeCode(code) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization":  this._basicAuth(),
        "Content-Type":   "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: this.redirectUri,
      }),
    });
    if (!res.ok) throw new Error("Schwab auth failed: " + await res.text());
    const tokens = await res.json();
    this._tokens = tokens;
    saveTokens(tokens);
    return tokens;
  }

  // Refresh token rotation — every refresh gives a new refresh_token; old one is invalidated
  async _refresh() {
    if (!this._tokens?.refresh_token) throw new Error("Schwab not authorized — complete OAuth in Settings");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": this._basicAuth(),
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: this._tokens.refresh_token,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) throw new Error("Schwab refresh token expired — re-authorize in Settings");
      throw new Error("Schwab token refresh failed: " + body);
    }
    const tokens = await res.json();
    this._tokens = { ...tokens, saved_at: Date.now() };
    saveTokens(this._tokens); // store rotated tokens immediately
    return this._tokens.access_token;
  }

  async _getAccessToken() {
    if (!this._tokens) throw new Error("Schwab not authorized — complete OAuth in Settings");
    const expiresAt = (this._tokens.saved_at || 0) + (this._tokens.expires_in || 1800) * 1000 - 60_000;
    if (Date.now() > expiresAt) return this._refresh();
    return this._tokens.access_token;
  }

  async _req(method, url, body) {
    const token = await this._getAccessToken();
    const headers = { "Authorization": "Bearer " + token, "Accept": "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text && res.ok) return null;
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("Schwab " + res.status + ": " + text); }
    if (!res.ok) throw new Error("Schwab " + res.status + ": " + (json?.message ?? JSON.stringify(json)));
    return json;
  }

  // ── Accounts ───────────────────────────────────────────────────────────────

  async getAccountNumbers() {
    return this._req("GET", TRADER + "/accounts/accountNumbers");
  }

  async getAccounts(includePositions = false) {
    const q = includePositions ? "?fields=positions" : "";
    return this._req("GET", TRADER + "/accounts" + q);
  }

  async getAccount(hash) {
    return this._req("GET", TRADER + "/accounts/" + hash + "?fields=positions");
  }

  async getOrders(hash, { days = 7, status } = {}) {
    const now  = new Date();
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      fromEnteredTime: from.toISOString().slice(0, 19) + "+00:00",
      toEnteredTime:   now.toISOString().slice(0, 19)  + "+00:00",
      ...(status ? { status } : {}),
    });
    return this._req("GET", TRADER + "/accounts/" + hash + "/orders?" + params);
  }

  async placeOrder(hash, order) {
    return this._req("POST", TRADER + "/accounts/" + hash + "/orders", order);
  }

  async cancelOrder(hash, orderId) {
    return this._req("DELETE", TRADER + "/accounts/" + hash + "/orders/" + orderId);
  }

  // ── Market data ────────────────────────────────────────────────────────────

  async getQuote(symbol) {
    const data = await this._req("GET", MARKET + "/quotes?symbols=" + encodeURIComponent(symbol) + "&fields=quote");
    return data?.[symbol]?.quote ?? data?.[symbol];
  }

  async getQuotes(symbols) {
    const data = await this._req("GET", MARKET + "/quotes?symbols=" + encodeURIComponent(symbols.join(",")) + "&fields=quote");
    return data ?? {};
  }

  async getPriceHistory(symbol, frequencyType = "minute", frequency = 5, periodType = "day", period = 1) {
    const params = new URLSearchParams({ symbol, frequencyType, frequency, periodType, period, needExtendedHoursData: false });
    return this._req("GET", MARKET + "/pricehistory?" + params);
  }

  async getOptionChain(symbol, { contractType = "ALL", strikeCount = 30, fromDate, toDate } = {}) {
    const params = new URLSearchParams({
      symbol, contractType, strikeCount,
      includeUnderlyingQuote: "true",
      strategy: "SINGLE",
      ...(fromDate ? { fromDate } : {}),
      ...(toDate   ? { toDate }   : {}),
    });
    return this._req("GET", MARKET + "/chains?" + params);
  }
}

// ── Option helpers ────────────────────────────────────────────────────────────

// OCC symbol: root (6 chars) + YYMMDD + C/P + strike (8 digits, implied 3 decimals)
export function buildOptionSymbol(root, expiry, type, strike) {
  const sym   = root.toUpperCase().padEnd(6, " ");
  const date  = expiry.replace(/-/g, "").slice(2); // YYYY-MM-DD → YYMMDD
  const flag  = type.toUpperCase()[0];             // C or P
  const cents = Math.round(parseFloat(strike) * 1000);
  return sym + date + flag + String(cents).padStart(8, "0");
}

// Walk an option chain expDateMap and return the contract closest to targetDelta
export function findBestContract(chain, contractType, targetDelta) {
  const map = contractType === "PUT" ? chain.putExpDateMap : chain.callExpDateMap;
  if (!map) return null;
  let best = null, bestDiff = Infinity;
  for (const strikes of Object.values(map)) {
    for (const contracts of Object.values(strikes)) {
      for (const c of contracts) {
        if (!c.delta || c.nonStandard) continue;
        const diff = Math.abs(Math.abs(c.delta) - Math.abs(targetDelta));
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      }
    }
  }
  return best;
}

// Target expiry date YYYY-MM-DD given a DTE target
export function targetExpiryRange(dteDays) {
  const lo = new Date(Date.now() + (dteDays - 7) * 86400000);
  const hi = new Date(Date.now() + (dteDays + 14) * 86400000);
  return {
    fromDate: lo.toISOString().slice(0, 10),
    toDate:   hi.toISOString().slice(0, 10),
  };
}

// ── SchwabExchange — standard trader interface ─────────────────────────────────

export class SchwabExchange {
  constructor(clientId, clientSecret, optionConfig = {}) {
    this.client      = new SchwabClient(clientId, clientSecret);
    this.optionMode  = optionConfig.optionMode  ?? null;     // 'sell_put' | 'sell_call' | null
    this.dteTarget   = optionConfig.dteTarget   ?? 30;       // target days to expiration
    this.deltaTarget = optionConfig.deltaTarget ?? 0.30;     // target delta (absolute)
    this.contracts   = optionConfig.contracts   ?? 1;        // number of option contracts
    this._accountHash = null;
  }

  get name() { return "Schwab"; }

  async _hash() {
    if (this._accountHash) return this._accountHash;
    const target = process.env.SCHWAB_ACCOUNT_HASH;
    if (target) { this._accountHash = target; return this._accountHash; }
    const nums = await this.client.getAccountNumbers();
    this._accountHash = nums?.[0]?.hashValue;
    if (!this._accountHash) throw new Error("No Schwab account found — check credentials");
    return this._accountHash;
  }

  async getMidPrice(asset) {
    const quote = await this.client.getQuote(asset);
    if (!quote) throw new Error("No Schwab quote for " + asset);
    const mid = quote.askPrice && quote.bidPrice
      ? (quote.askPrice + quote.bidPrice) / 2
      : (quote.lastPrice || quote.mark || quote.closePrice);
    if (!mid) throw new Error("Empty quote for " + asset);
    return mid;
  }

  async getPosition(asset) {
    const hash = await this._hash();
    const data  = await this.client.getAccount(hash);
    const positions = data?.securitiesAccount?.positions ?? [];
    // For options: match by underlying symbol; for equity: match by symbol
    const pos = positions.find(p =>
      p.instrument?.symbol === asset ||
      (this.optionMode && p.instrument?.underlyingSymbol === asset && p.instrument?.assetType === "OPTION")
    );
    if (!pos) return null;
    const long  = parseFloat(pos.longQuantity  ?? 0);
    const short = parseFloat(pos.shortQuantity ?? 0);
    if (long === 0 && short === 0) return null;
    return {
      side:       short > 0 ? "SHORT" : "LONG",
      size:       long || short,
      symbol:     pos.instrument?.symbol,
      entryPrice: parseFloat(pos.averagePrice ?? 0),
      marketValue: parseFloat(pos.marketValue ?? 0),
      assetType:  pos.instrument?.assetType,
    };
  }

  async setLeverage() {} // no-op — equities/options don't have leverage settings

  async placeMarketOrder(asset, sizeUsd, side) {
    // If option mode is configured, route to options instead of equity
    if (this.optionMode) return this._placeOptionOrder(asset, side);

    const hash  = await this._hash();
    const price = await this.getMidPrice(asset);
    const qty   = Math.floor(sizeUsd / price);
    if (qty < 1) throw new Error("Order too small — need at least 1 share of " + asset + " at $" + price.toFixed(2));

    const order = _equityOrder(asset, side === "buy" ? "BUY" : "SELL", qty);
    await this.client.placeOrder(hash, order);
    return { ok: true, qty, price, asset };
  }

  async _placeOptionOrder(underlying, signalSide) {
    const hash = await this._hash();
    // Premium fade logic:
    //   signal buy  (LONG) → sell put  (bull bias, collect premium below market)
    //   signal sell (SHORT) → sell call (bear bias, collect premium above market)
    const contractType = signalSide === "buy" ? "PUT" : "CALL";
    if (this.optionMode === "sell_put"  && contractType !== "PUT")  throw new Error("sell_put strategy only fires on LONG signal");
    if (this.optionMode === "sell_call" && contractType !== "CALL") throw new Error("sell_call strategy only fires on SHORT signal");

    const { fromDate, toDate } = targetExpiryRange(this.dteTarget);
    const chain = await this.client.getOptionChain(underlying, { contractType, strikeCount: 40, fromDate, toDate });
    const contract = findBestContract(chain, contractType, this.deltaTarget);
    if (!contract) throw new Error("No " + contractType + " contract found near " + this.deltaTarget + " delta for " + underlying);

    const midPremium = ((contract.bid + contract.ask) / 2).toFixed(2);
    const order = {
      orderType:          "LIMIT",
      session:            "NORMAL",
      duration:           "DAY",
      price:              parseFloat(midPremium),
      orderStrategyType:  "SINGLE",
      orderLegCollection: [{
        instruction: "SELL_TO_OPEN",
        quantity:    this.contracts,
        instrument:  { symbol: contract.symbol, assetType: "OPTION" },
      }],
    };
    await this.client.placeOrder(hash, order);
    return { ok: true, symbol: contract.symbol, premium: midPremium, delta: contract.delta, contracts: this.contracts };
  }

  async closePosition(asset) {
    const hash = await this._hash();
    const pos  = await this.getPosition(asset);
    if (!pos) return { ok: true, msg: "No position" };

    let instruction, qty, assetType;
    if (pos.assetType === "OPTION") {
      instruction = "BUY_TO_CLOSE";
      qty         = pos.size;
      assetType   = "OPTION";
    } else {
      instruction = pos.side === "LONG" ? "SELL" : "BUY_TO_COVER";
      qty         = pos.size;
      assetType   = "EQUITY";
    }

    const order = {
      orderType:          "MARKET",
      session:            "NORMAL",
      duration:           "DAY",
      orderStrategyType:  "SINGLE",
      orderLegCollection: [{
        instruction,
        quantity: qty,
        instrument: { symbol: pos.symbol ?? asset, assetType },
      }],
    };
    await this.client.placeOrder(hash, order);
    return { ok: true };
  }

  async cancelOrder(orderId) {
    const hash = await this._hash();
    await this.client.cancelOrder(hash, orderId);
    return { ok: true };
  }

  async editOrder(orderId, asset, side, size, limitPrice, duration = "GOOD_TILL_CANCEL") {
    const hash = await this._hash();
    await this.client.cancelOrder(hash, orderId);
    const instruction = side === "buy" ? "BUY" : "SELL";
    const order = {
      orderType:          "LIMIT",
      session:            "NORMAL",
      duration,
      price:              parseFloat(limitPrice),
      orderStrategyType:  "SINGLE",
      orderLegCollection: [{
        instruction,
        quantity: parseFloat(size),
        instrument: { symbol: asset, assetType: "EQUITY" },
      }],
    };
    await this.client.placeOrder(hash, order);
    return { ok: true };
  }

  async getCandles(asset, intervalMinutes = 5, count = 50) {
    const data = await this.client.getPriceHistory(asset, "minute", intervalMinutes, "day", 1);
    return (data?.candles ?? []).slice(-count).map(c => ({
      t: c.datetime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
    }));
  }
}

function _equityOrder(symbol, instruction, quantity) {
  return {
    orderType:          "MARKET",
    session:            "NORMAL",
    duration:           "DAY",
    orderStrategyType:  "SINGLE",
    orderLegCollection: [{ instruction, quantity, instrument: { symbol, assetType: "EQUITY" } }],
  };
}
