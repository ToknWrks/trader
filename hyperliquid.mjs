/**
 * hyperliquid.mjs
 * Hyperliquid perps client using the official @nktkas/hyperliquid SDK.
 * Env: AGENT_PRIVATE_KEY — 0x-prefixed private key
 */

import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ExchangeClient, InfoClient, HttpTransport } from "@nktkas/hyperliquid";

const transport = new HttpTransport();

// Perp asset index cache: name → index
let _assetIndexCache = null;
// Perp szDecimals cache: name → szDecimals
let _perpSzCache = null;
// Spot: name → { pairIndex, szDecimals }
let _spotIndexCache = null;

async function _loadCaches() {
  const info = new InfoClient({ transport });
  if (!_assetIndexCache) {
    const meta = await info.meta();
    _assetIndexCache = {};
    _perpSzCache = {};
    meta.universe.forEach((a, i) => {
      _assetIndexCache[a.name.toUpperCase()] = i;
      _perpSzCache[a.name.toUpperCase()] = a.szDecimals;
    });
  }
  if (!_spotIndexCache) {
    const spotMeta = await info.spotMeta();
    _spotIndexCache = {};
    const tokenByIdx = {};
    spotMeta.tokens.forEach(t => { tokenByIdx[t.index] = { name: t.name.toUpperCase(), szDecimals: t.szDecimals }; });
    spotMeta.universe.forEach(pair => {
      const tok = tokenByIdx[pair.tokens[0]];
      if (tok) _spotIndexCache[tok.name] = { pairIndex: pair.index, szDecimals: tok.szDecimals };
    });
  }
}

function getSzDecimals(asset) {
  const upper = asset.toUpperCase();
  if (_spotIndexCache?.[upper] !== undefined) return _spotIndexCache[upper].szDecimals;
  return _perpSzCache?.[upper] ?? 5;
}

function fmtSize(size, asset) {
  const dec = getSzDecimals(asset);
  return size.toFixed(dec);
}

async function getAssetIndex(asset) {
  await _loadCaches();
  const upper = asset.toUpperCase();
  if (_assetIndexCache[upper] !== undefined) return _assetIndexCache[upper];
  if (_spotIndexCache[upper] !== undefined)
    throw new Error(`${asset} is spot-only on Hyperliquid — no perp market available`);
  throw new Error(`Unknown asset: ${asset}`);
}

function isSpotAsset(asset) {
  const upper = asset.toUpperCase();
  return _spotIndexCache?.[upper] !== undefined && _assetIndexCache?.[upper] === undefined;
}

function makeClients(privateKey) {
  const wallet = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account: wallet, chain: mainnet, transport: http() });
  const exchange = new ExchangeClient({ transport, wallet: walletClient });
  const info = new InfoClient({ transport });
  return { exchange, info, wallet };
}

// ── Info (read-only) ─────────────────────────────────────────────────────────

export async function getAccountState(address) {
  const info = new InfoClient({ transport });
  return info.clearinghouseState({ user: address });
}

export async function getMidPrice(asset) {
  await _loadCaches();
  const info = new InfoClient({ transport });
  const mids = await info.allMids();
  const upper = asset.toUpperCase();
  // Spot assets appear in allMids as "@{pairIndex}", not by name
  if (_spotIndexCache?.[upper] !== undefined) {
    const spotKey = `@${_spotIndexCache[upper].pairIndex}`;
    return mids[spotKey] ? parseFloat(mids[spotKey]) : null;
  }
  const key = Object.keys(mids).find(k => k.toUpperCase() === upper);
  return key ? parseFloat(mids[key]) : null;
}

export async function getPosition(address, asset) {
  await _loadCaches();
  if (isSpotAsset(asset)) {
    const info = new InfoClient({ transport });
    const state = await info.spotClearinghouseState({ user: address });
    const bal = (state?.balances ?? []).find(b => b.coin.toUpperCase() === asset.toUpperCase());
    const total = parseFloat(bal?.total ?? "0");
    if (total <= 0) return null;
    // Return perp-compatible shape; entryPx unknown for spot
    return { szi: String(total), entryPx: "0", coin: asset };
  }
  const state = await getAccountState(address);
  const positions = state?.assetPositions ?? [];
  const pos = positions.find(p => p.position?.coin?.toUpperCase() === asset.toUpperCase());
  return pos?.position ?? null;
}

// ── Place order ──────────────────────────────────────────────────────────────

/**
 * Place a market order (IOC limit at ±1% slippage).
 * @param {string} privateKey  0x-prefixed private key
 * @param {string} asset       e.g. "BTC"
 * @param {"buy"|"sell"} side
 * @param {number} size        position size in asset units
 * @param {number} [slippage]  fraction, default 0.01 (1%)
 */
export async function placeMarketOrder(privateKey, asset, side, size, slippage = 0.01) {
  const { exchange, wallet } = makeClients(privateKey);
  const isBuy = side === "buy";

  const mid = await getMidPrice(asset);
  if (!mid) throw new Error(`Could not get mid price for ${asset}`);

  const limitPx = isBuy
    ? (mid * (1 + slippage)).toPrecision(5)
    : (mid * (1 - slippage)).toPrecision(5);

  const assetIdx = await getAssetIndex(asset);

  console.log(`[hyperliquid] Placing ${side.toUpperCase()} ${size} ${asset} @ ~$${mid.toLocaleString()} (limit $${parseFloat(limitPx).toLocaleString()})`);

  const result = await exchange.order({
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: limitPx,
      s: fmtSize(size, asset),
      r: false,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  });

  return result;
}

/**
 * Set leverage for an asset before placing an order.
 * @param {string} privateKey  0x-prefixed private key
 * @param {string} asset       e.g. "BTC"
 * @param {number} leverage    1–50
 * @param {boolean} [isCross]  cross-margin (default: false = isolated)
 */
export async function setLeverage(privateKey, asset, leverage, isCross = false) {
  await _loadCaches();
  if (isSpotAsset(asset)) return;
  const { exchange } = makeClients(privateKey);
  const assetIdx = await getAssetIndex(asset);
  console.log(`[hyperliquid] Setting leverage: ${leverage}x ${isCross ? "cross" : "isolated"} for ${asset}`);
  return exchange.updateLeverage({ asset: assetIdx, isCross, leverage });
}

/**
 * Place a GTC limit order.
 */
export async function placeLimitOrder(privateKey, asset, side, size, limitPrice) {
  const { exchange } = makeClients(privateKey);
  const assetIdx = await getAssetIndex(asset);
  const isBuy = side === "buy";
  console.log(`[hyperliquid] Limit ${side.toUpperCase()} ${size} ${asset} @ $${limitPrice}`);
  return exchange.order({
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: limitPrice.toPrecision(6),
      s: fmtSize(size, asset),
      r: false,
      t: { limit: { tif: "Gtc" } },
    }],
    grouping: "na",
  });
}

/**
 * Fetch open orders for an address.
 * Returns normalized [{ id, asset, side, size, limitPrice }]
 */
export async function getOpenOrders(address) {
  const info = new InfoClient({ transport });
  const orders = await info.openOrders({ user: address });
  return (orders ?? []).map(o => ({
    id: o.oid,
    asset: o.coin,
    side: o.side === "B" ? "buy" : "sell",
    size: parseFloat(o.sz),
    limitPrice: parseFloat(o.limitPx),
  }));
}

/**
 * Cancel an open order by asset + order ID.
 */
export async function cancelOrder(privateKey, asset, oid) {
  const { exchange } = makeClients(privateKey);
  const assetIdx = await getAssetIndex(asset);
  return exchange.cancel({ cancels: [{ a: assetIdx, o: oid }] });
}

/**
 * Close all positions for an asset (reduce-only IOC).
 */
export async function closePosition(privateKey, asset) {
  const { exchange, wallet } = makeClients(privateKey);
  const pos = await getPosition(wallet.address, asset);

  if (!pos || parseFloat(pos.szi ?? "0") === 0) {
    console.log(`[hyperliquid] No open position for ${asset}`);
    return null;
  }

  const size = Math.abs(parseFloat(pos.szi));
  const mid = await getMidPrice(asset);
  const slippage = 0.01;
  const assetIdx = await getAssetIndex(asset);
  console.log(`[hyperliquid] Closing ${size} ${asset} position`);

  if (isSpotAsset(asset)) {
    const limitPx = (mid * (1 - slippage)).toPrecision(5);
    return exchange.order({
      orders: [{
        a: assetIdx,
        b: false,
        p: limitPx,
        s: fmtSize(size, asset),
        r: false,
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    });
  }

  const isLong = parseFloat(pos.szi) > 0;
  const limitPx = isLong
    ? (mid * (1 - slippage)).toPrecision(5)
    : (mid * (1 + slippage)).toPrecision(5);

  return exchange.order({
    orders: [{
      a: assetIdx,
      b: !isLong,
      p: limitPx,
      s: fmtSize(size, asset),
      r: true,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  });
}
