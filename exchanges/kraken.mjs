/**
 * exchanges/kraken.mjs
 * Kraken spot + margin exchange implementation.
 *
 * Env: KRAKEN_API_KEY, KRAKEN_API_SECRET (base64-encoded private key from Kraken)
 *
 * Leverage:
 *   1 (default) = spot — market buy/sell, position tracked via balance
 *   2–5         = margin — leveraged long/short, position from OpenPositions
 *
 * Note: SHORT signals on leverage=1 strategies will close any long and go flat
 * (spot has no native short). Set leverage ≥ 2 to enable margin shorts.
 */

import crypto from "crypto";

const BASE = "https://api.kraken.com";

// Kraken uses "XBT" for Bitcoin; everything else uses the standard ticker
function toKrakenBase(symbol) {
  const base = symbol.replace(/-USD$|\/USD$/i, "").toUpperCase();
  return base === "BTC" ? "XBT" : base;
}

function toKrakenPair(symbol) {
  return toKrakenBase(symbol) + "USD";
}

function getSignature(path, data, secret) {
  const body = new URLSearchParams(data).toString();
  const hash = crypto.createHash("sha256").update(data.nonce + body).digest();
  return crypto
    .createHmac("sha512", Buffer.from(secret, "base64"))
    .update(path)
    .update(hash)
    .digest("base64");
}

async function krakenRequest(apiKey, apiSecret, path, params = {}) {
  const data = { ...params, nonce: Date.now().toString() };
  const sig = getSignature(path, data, apiSecret);
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key": apiKey,
      "API-Sign": sig,
    },
    body: new URLSearchParams(data).toString(),
  });
  const json = await res.json();
  if (json.error?.length) throw new Error(`Kraken API: ${json.error.join(", ")}`);
  return json.result;
}

export class KrakenExchange {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this._leverage = 1;
  }

  get name() { return "Kraken"; }

  async getMidPrice(asset) {
    const pair = toKrakenPair(asset);
    const res = await fetch(`${BASE}/0/public/Ticker?pair=${pair}`);
    const json = await res.json();
    if (json.error?.length) throw new Error(`Kraken ticker: ${json.error.join(", ")}`);
    // c[0] = last trade price
    const data = Object.values(json.result)[0];
    return parseFloat(data.c[0]);
  }

  async getPosition(asset) {
    const krakenBase = toKrakenBase(asset);

    if (this._leverage > 1) {
      // Margin: use OpenPositions
      const positions = await krakenRequest(
        this.apiKey, this.apiSecret,
        "/0/private/OpenPositions",
        { docalcs: "true" }
      );
      const relevant = Object.values(positions ?? {}).filter(p =>
        p.pair?.toUpperCase().includes(krakenBase)
      );
      if (!relevant.length) return null;

      // Aggregate net volume and average entry price
      let netVol = 0, totalCost = 0;
      for (const p of relevant) {
        const vol = parseFloat(p.vol ?? "0") - parseFloat(p.vol_closed ?? "0");
        const cost = parseFloat(p.cost ?? "0");
        if (p.type === "buy") { netVol += vol; totalCost += cost; }
        else                  { netVol -= vol; totalCost += cost; }
      }
      if (Math.abs(netVol) < 1e-8) return null;
      const entryPx = totalCost / Math.abs(netVol);
      return { szi: netVol.toFixed(8), entryPx: entryPx.toFixed(2) };
    } else {
      // Spot: check balance for this asset
      const balance = await krakenRequest(this.apiKey, this.apiSecret, "/0/private/Balance");
      // Kraken balance keys: "XXBT" for BTC, "XETH" for ETH, plain for others
      const candidates = [`X${krakenBase}`, krakenBase, `Z${krakenBase}`];
      let vol = 0;
      for (const k of candidates) {
        if (balance[k]) { vol = parseFloat(balance[k]); break; }
      }
      if (vol < 1e-8) return null;
      // Spot has no tracked entry price
      return { szi: vol.toFixed(8), entryPx: "0" };
    }
  }

  async setLeverage(asset, leverage) {
    // Stored and applied at order time (Kraken specifies leverage per-order)
    this._leverage = leverage;
  }

  async placeMarketOrder(asset, side, size) {
    const pair = toKrakenPair(asset);
    const params = {
      ordertype: "market",
      type: side,
      volume: size.toString(),
      pair,
    };
    if (this._leverage > 1) params.leverage = this._leverage.toString();
    console.log(`[kraken] ${side.toUpperCase()} ${size} ${asset} @ market (${this._leverage}x)`);
    return krakenRequest(this.apiKey, this.apiSecret, "/0/private/AddOrder", params);
  }

  async closePosition(asset) {
    const position = await this.getPosition(asset);
    if (!position) {
      console.log(`[kraken] No open position for ${asset}`);
      return null;
    }
    const size = Math.abs(parseFloat(position.szi));
    const isLong = parseFloat(position.szi) > 0;
    const side = isLong ? "sell" : "buy";
    const pair = toKrakenPair(asset);
    const params = {
      ordertype: "market",
      type: side,
      volume: size.toString(),
      pair,
    };
    if (this._leverage > 1) params.leverage = this._leverage.toString();
    console.log(`[kraken] Closing ${size} ${asset} (${isLong ? "LONG" : "SHORT"})`);
    return krakenRequest(this.apiKey, this.apiSecret, "/0/private/AddOrder", params);
  }
}
