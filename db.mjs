/**
 * db.mjs — local SQLite database
 * Stores strategies, signal history, and trade log.
 * No cloud database required.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(resolve(DATA_DIR, "trader.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS strategies (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    symbol            TEXT NOT NULL DEFAULT 'BTC-USD',
    leverage          INTEGER NOT NULL DEFAULT 1,
    position_size_usd REAL,
    active            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    date        TEXT NOT NULL,
    signal      TEXT NOT NULL,
    price       REAL,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(strategy_id, date)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    date        TEXT NOT NULL DEFAULT (date('now')),
    action      TEXT NOT NULL,
    asset       TEXT NOT NULL,
    size        REAL,
    price       REAL,
    leverage    INTEGER,
    result_json TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Strategies ────────────────────────────────────────────────────────────────

export function getStrategies() {
  return db.prepare("SELECT * FROM strategies ORDER BY created_at DESC").all();
}

export function getActiveStrategies() {
  return db.prepare("SELECT * FROM strategies WHERE active = 1").all();
}

export function getStrategy(id) {
  return db.prepare("SELECT * FROM strategies WHERE id = ?").get(id);
}

export function upsertStrategy({ id, name, symbol, leverage, position_size_usd }) {
  db.prepare(`
    INSERT INTO strategies (id, name, symbol, leverage, position_size_usd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      symbol = excluded.symbol,
      leverage = excluded.leverage,
      position_size_usd = excluded.position_size_usd
  `).run(id, name, symbol, leverage ?? 1, position_size_usd ?? null);
}

export function setStrategyActive(id, active) {
  db.prepare("UPDATE strategies SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteStrategy(id) {
  db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
}

// ── Signals ───────────────────────────────────────────────────────────────────

export function upsertSignal({ strategy_id, date, signal, price, notes }) {
  db.prepare(`
    INSERT INTO signals (strategy_id, date, signal, price, notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id, date) DO UPDATE SET
      signal = excluded.signal,
      price = excluded.price,
      notes = excluded.notes
  `).run(strategy_id, date, signal, price ?? null, notes ?? null);
}

export function getLatestSignal(strategy_id) {
  return db.prepare(`
    SELECT * FROM signals WHERE strategy_id = ?
    ORDER BY date DESC LIMIT 1
  `).get(strategy_id);
}

export function getPriorSignal(strategy_id) {
  return db.prepare(`
    SELECT * FROM signals WHERE strategy_id = ?
    ORDER BY date DESC LIMIT 1 OFFSET 1
  `).get(strategy_id);
}

export function getSignalHistory(strategy_id, limit = 30) {
  return db.prepare(`
    SELECT * FROM signals WHERE strategy_id = ?
    ORDER BY date DESC LIMIT ?
  `).all(strategy_id, limit);
}

// ── Trades ────────────────────────────────────────────────────────────────────

export function insertTrade({ strategy_id, action, asset, size, price, leverage, result }) {
  db.prepare(`
    INSERT INTO trades (strategy_id, action, asset, size, price, leverage, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(strategy_id, action, asset, size ?? null, price ?? null, leverage ?? null, result ? JSON.stringify(result) : null);
}

export function getTradeHistory(strategy_id, limit = 30) {
  return db.prepare(`
    SELECT * FROM trades WHERE strategy_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(strategy_id, limit);
}

export function getAllRecentTrades(limit = 50) {
  return db.prepare(`
    SELECT t.*, s.name as strategy_name FROM trades t
    LEFT JOIN strategies s ON s.id = t.strategy_id
    ORDER BY t.created_at DESC LIMIT ?
  `).all(limit);
}
