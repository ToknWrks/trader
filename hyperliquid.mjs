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

// Asset index cache
let _assetIndexCache = null;
async function getAssetIndex(asset) {
  if (!_assetIndexCache) {
    const info = new InfoClient({ transport });
    const meta = await info.meta();
    _assetIndexCache = {};
    meta.universe.forEach((a, i) => { _assetIndexCache[a.name.toUpperCase()] = i; });
  }
  const idx = _assetIndexCache[asset.toUpperCase()];
  if (idx === undefined) throw new Error(`Unknown asset: ${asset}`);
  return idx;
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
  const info = new InfoClient({ transport });
  const mids = await info.allMids();
  const key = Object.keys(mids).find(k => k.toUpperCase() === asset.toUpperCase());
  return key ? parseFloat(mids[key]) : null;
}

export async function getPosition(address, asset) {
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
      s: size.toPrecision(5),
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
  const { exchange } = makeClients(privateKey);
  const assetIdx = await getAssetIndex(asset);
  console.log(`[hyperliquid] Setting leverage: ${leverage}x ${isCross ? "cross" : "isolated"} for ${asset}`);
  return exchange.updateLeverage({ asset: assetIdx, isCross, leverage });
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
  const isLong = parseFloat(pos.szi) > 0;
  const mid = await getMidPrice(asset);
  const slippage = 0.01;
  const limitPx = isLong
    ? (mid * (1 - slippage)).toPrecision(5)
    : (mid * (1 + slippage)).toPrecision(5);

  const assetIdx = await getAssetIndex(asset);
  console.log(`[hyperliquid] Closing ${size} ${asset} position`);

  return exchange.order({
    orders: [{
      a: assetIdx,
      b: !isLong,
      p: limitPx,
      s: size.toPrecision(5),
      r: true,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  });
}
