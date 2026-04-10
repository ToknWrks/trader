/**
 * exchanges/coinbase.mjs
 * Coinbase Advanced Trade API v3 — spot crypto only.
 *
 * Env: COINBASE_API_KEY, COINBASE_API_SECRET, COINBASE_API_PASSPHRASE
 * Keys created at: https://www.coinbase.com/settings/api
 * Required permissions: View, Trade
 *
 * Notes:
 *   - Spot only — no leverage, no native shorting
 *   - SHORT signals will close any open long and go flat (same as Alpaca spot)
 *   - Symbol format: "BTC", "ETH", "SOL" — converted to "BTC-USD" internally
 *   - BUY orders use quote_size (USD amount); SELL orders use base_size (asset amount)
 */

import crypto from "crypto";
import { randomUUID } from "crypto";

const BASE = "https://api.coinbase.com";

function toProductId(asset) {
  const base = asset.replace(/-USD$|\/USD$/i, "").toUpperCase();
  return `${base}-USD`;
}

function toCurrencyCode(asset) {
  return asset.replace(/-USD$|\/USD$/i, "").toUpperCase();
}

export class CoinbaseExchange {
  constructor(apiKey, apiSecret, passphrase) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.passphrase = passphrase;
  }

  get name() { return "Coinbase"; }

  _sign(timestamp, method, path, body = "") {
    const message = timestamp + method.toUpperCase() + path + body;
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("hex");
  }

  async _request(method, path, body) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const sign = this._sign(timestamp, method, path, bodyStr);

    const res = await fetch(BASE + path, {
      method,
      headers: {
        "CB-ACCESS-KEY":        this.apiKey,
        "CB-ACCESS-SIGN":       sign,
        "CB-ACCESS-TIMESTAMP":  timestamp,
        "CB-ACCESS-PASSPHRASE": this.passphrase,
        "Content-Type":         "application/json",
      },
      body: bodyStr || undefined,
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`Coinbase ${res.status}: ${text}`); }
    if (!res.ok) {
      const msg = json?.message ?? json?.error_details ?? JSON.stringify(json);
      throw new Error(`Coinbase: ${msg}`);
    }
    return json;
  }

  async getMidPrice(asset) {
    const productId = toProductId(asset);
    const data = await this._request("GET", `/api/v3/brokerage/best_bid_ask?product_ids=${productId}`);
    const book = data?.pricebooks?.find(p => p.product_id === productId);
    if (!book) throw new Error(`No Coinbase price for ${productId}`);
    const bid = parseFloat(book.bids?.[0]?.price ?? "0");
    const ask = parseFloat(book.asks?.[0]?.price ?? "0");
    if (!bid || !ask) throw new Error(`Empty order book for ${productId}`);
    return (bid + ask) / 2;
  }

  async getPosition(asset) {
    const currency = toCurrencyCode(asset);
    const data = await this._request("GET", "/api/v3/brokerage/accounts");
    const accounts = data?.accounts ?? [];
    const account = accounts.find(a => a.currency === currency);
    if (!account) return null;
    const available = parseFloat(account.available_balance?.value ?? "0");
    if (available < 1e-8) return null;
    // Spot has no tracked entry price
    return { szi: available.toFixed(8), entryPx: "0" };
  }

  async setLeverage(asset, leverage) {
    // Coinbase spot does not support leverage — no-op
    if (leverage > 1) console.warn(`[coinbase] Leverage >1 not supported — ignoring`);
  }

  async placeMarketOrder(asset, side, size) {
    const productId = toProductId(asset);
    const clientOrderId = randomUUID();

    // BUY: use quote_size (USD) so the caller can pass a USD amount directly
    // SELL: use base_size (asset units)
    const orderConfig = side === "buy"
      ? { market_market_ioc: { quote_size: size.toString() } }
      : { market_market_ioc: { base_size: size.toString() } };

    console.log(`[coinbase] ${side.toUpperCase()} ${size} ${productId} @ market`);

    return this._request("POST", "/api/v3/brokerage/orders", {
      client_order_id:     clientOrderId,
      product_id:          productId,
      side:                side.toUpperCase(),
      order_configuration: orderConfig,
    });
  }

  async closePosition(asset) {
    const position = await this.getPosition(asset);
    if (!position) {
      console.log(`[coinbase] No open position for ${asset}`);
      return null;
    }
    const size = Math.abs(parseFloat(position.szi));
    console.log(`[coinbase] Closing ${size} ${asset}`);
    return this.placeMarketOrder(asset, "sell", size);
  }
}
