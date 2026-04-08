/**
 * exchanges/alpaca.mjs
 * Alpaca Markets exchange implementation — stocks, ETFs, and crypto.
 *
 * Env: ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_PAPER (true = paper trading)
 *
 * Stocks/ETFs: symbol format "SPY", "AAPL" — market hours only
 * Crypto:      symbol format "BTC/USD"    — 24/7
 */

const CRYPTO_ASSETS = new Set([
  "BTC","ETH","SOL","LTC","BCH","LINK","AAVE","BAT","CRV","DOT",
  "MKR","SHIB","UNI","USDC","USDT","XTZ","AVAX","DOGE","GRT","MATIC",
]);

function alpacaSymbol(asset) {
  const base = asset.replace(/-USD$|\/USD$/i, "").toUpperCase();
  return CRYPTO_ASSETS.has(base) ? `${base}/USD` : base;
}

function isCrypto(asset) {
  const base = asset.replace(/-USD$|\/USD$/i, "").toUpperCase();
  return CRYPTO_ASSETS.has(base);
}

export class AlpacaExchange {
  constructor(apiKey, apiSecret, paper = false) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl   = paper
      ? "https://paper-api.alpaca.markets"
      : "https://api.alpaca.markets";
    this.dataUrl   = "https://data.alpaca.markets";
  }

  get name() { return "Alpaca"; }

  _headers() {
    return {
      "APCA-API-KEY-ID":     this.apiKey,
      "APCA-API-SECRET-KEY": this.apiSecret,
      "Content-Type":        "application/json",
    };
  }

  async _request(method, path, body) {
    // Market data endpoints must always use data.alpaca.markets (not paper-api)
    const isDataEndpoint = path.startsWith("/v1beta") || /^\/v2\/stocks\/(quotes|bars|trades)/.test(path);
    const base = isDataEndpoint ? this.dataUrl : this.baseUrl;
    const res = await fetch(base + path, {
      method,
      headers: this._headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`Alpaca ${res.status}: ${text}`); }
    if (!res.ok) throw new Error(`Alpaca: ${json.message ?? JSON.stringify(json)}`);
    return json;
  }

  async getMidPrice(asset) {
    const sym = alpacaSymbol(asset);
    if (isCrypto(asset)) {
      const data = await this._request("GET", `/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(sym)}`);
      const quote = data?.quotes?.[sym];
      if (!quote) throw new Error(`No Alpaca crypto quote for ${sym}`);
      return (parseFloat(quote.ap) + parseFloat(quote.bp)) / 2;
    } else {
      const data = await this._request("GET", `/v2/stocks/quotes/latest?symbols=${sym}`);
      const quote = data?.quotes?.[sym];
      if (!quote) throw new Error(`No Alpaca stock quote for ${sym}`);
      return (parseFloat(quote.ap) + parseFloat(quote.bp)) / 2;
    }
  }

  async getPosition(asset) {
    const sym = alpacaSymbol(asset);
    try {
      const pos = await this._request("GET", `/v2/positions/${encodeURIComponent(sym)}`);
      if (!pos) return null;
      const qty = parseFloat(pos.qty);
      if (Math.abs(qty) < 1e-8) return null;
      return {
        szi:     qty.toString(),
        entryPx: pos.avg_entry_price ?? "0",
      };
    } catch (e) {
      if (e.message?.includes("position does not exist") || e.message?.includes("404")) return null;
      throw e;
    }
  }

  async setLeverage(asset, leverage) {
    // Alpaca does not support leverage for retail accounts — no-op
    if (leverage > 1) console.warn(`[alpaca] Leverage >1 not supported — ignoring`);
  }

  async placeMarketOrder(asset, side, size) {
    const sym = alpacaSymbol(asset);
    const tif = isCrypto(asset) ? "gtc" : "day";
    console.log(`[alpaca] ${side.toUpperCase()} ${size} ${sym} @ market (${tif})`);
    return this._request("POST", "/v2/orders", {
      symbol:        sym,
      qty:           size.toString(),
      side,
      type:          "market",
      time_in_force: tif,
    });
  }

  async closePosition(asset) {
    const sym = alpacaSymbol(asset);
    console.log(`[alpaca] Closing position for ${sym}`);
    try {
      return await this._request("DELETE", `/v2/positions/${encodeURIComponent(sym)}`);
    } catch (e) {
      if (e.message?.includes("position does not exist") || e.message?.includes("404")) {
        console.log(`[alpaca] No open position for ${sym}`);
        return null;
      }
      throw e;
    }
  }
}
