/**
 * exchanges/hyperliquid.mjs
 * Wraps hyperliquid.mjs in the standard exchange interface.
 */
import { privateKeyToAccount } from "viem/accounts";
import {
  getMidPrice as hlGetMidPrice,
  getPosition as hlGetPosition,
  placeMarketOrder as hlPlaceOrder,
  placeLimitOrder as hlPlaceLimitOrder,
  closePosition as hlClose,
  setLeverage as hlSetLeverage,
  getOpenOrders as hlGetOpenOrders,
  cancelOrder as hlCancelOrder,
} from "../hyperliquid.mjs";

export class HyperliquidExchange {
  constructor(privateKey) {
    this.privateKey = privateKey;
    this.address = privateKeyToAccount(privateKey).address;
  }

  get name() { return "Hyperliquid"; }

  async getMidPrice(asset) {
    return hlGetMidPrice(asset);
  }

  async getPosition(asset) {
    return hlGetPosition(this.address, asset);
    // Returns { szi, entryPx, ... } or null
  }

  async setLeverage(asset, leverage) {
    return hlSetLeverage(this.privateKey, asset, leverage);
  }

  async placeMarketOrder(asset, side, size) {
    return hlPlaceOrder(this.privateKey, asset, side, size);
  }

  async placeLimitOrder(asset, side, size, limitPrice) {
    return hlPlaceLimitOrder(this.privateKey, asset, side, size, limitPrice);
  }

  async getOpenOrders() {
    return hlGetOpenOrders(this.address);
  }

  async cancelOrder(orderId, asset) {
    return hlCancelOrder(this.privateKey, asset, orderId);
  }

  async closePosition(asset) {
    return hlClose(this.privateKey, asset);
  }
}
