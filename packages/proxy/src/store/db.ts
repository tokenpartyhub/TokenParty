import Database from "better-sqlite3";
import path from "node:path";
import { getConfig } from "../config.js";
import { nanoid } from "nanoid";

let db: Database.Database;

export function initDb(): Database.Database {
  const config = getConfig();
  const dbPath = path.join(config.server.dataDir, "tokenparty.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}

export function getDb(): Database.Database {
  return db;
}

function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      date TEXT NOT NULL,
      token_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      request_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      PRIMARY KEY (date, token_id, provider_id, model)
    );

    CREATE TABLE IF NOT EXISTS request_index (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      token_id TEXT,
      provider_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      latency_ms INTEGER,
      status INTEGER,
      log_file TEXT NOT NULL,
      error TEXT,
      api_key_index INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD'
    );

    CREATE INDEX IF NOT EXISTS idx_request_timestamp ON request_index(timestamp);
    CREATE INDEX IF NOT EXISTS idx_request_token ON request_index(token_id);
    CREATE INDEX IF NOT EXISTS idx_request_provider ON request_index(provider_id);

    CREATE TABLE IF NOT EXISTS admin_token (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const columns = db.prepare(`PRAGMA table_info(request_index)`).all() as { name: string }[];
  const colNames = new Set(columns.map((c) => c.name));
  if (!colNames.has("api_key_index")) {
    db.exec(`ALTER TABLE request_index ADD COLUMN api_key_index INTEGER DEFAULT 0`);
  }
  if (!colNames.has("cost")) {
    db.exec(`ALTER TABLE request_index ADD COLUMN cost REAL DEFAULT 0`);
  }
  if (!colNames.has("cache_input_tokens")) {
    db.exec(`ALTER TABLE request_index ADD COLUMN cache_input_tokens INTEGER DEFAULT 0`);
  }
  if (!colNames.has("cache_read_tokens")) {
    db.exec(`ALTER TABLE request_index ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`);
  }
  if (!colNames.has("cache_write_tokens")) {
    db.exec(`ALTER TABLE request_index ADD COLUMN cache_write_tokens INTEGER DEFAULT 0`);
  }
  if (!colNames.has("currency")) {
    db.exec(`ALTER TABLE request_index ADD COLUMN currency TEXT DEFAULT 'USD'`);
  }

  const dailyCols = db.prepare(`PRAGMA table_info(usage_daily)`).all() as { name: string }[];
  const dailyColNames = new Set(dailyCols.map((c) => c.name));
  if (!dailyColNames.has("cost")) {
    db.exec(`ALTER TABLE usage_daily ADD COLUMN cost REAL DEFAULT 0`);
  }
  if (!dailyColNames.has("cache_input_tokens")) {
    db.exec(`ALTER TABLE usage_daily ADD COLUMN cache_input_tokens INTEGER DEFAULT 0`);
  }
  if (!dailyColNames.has("cache_read_tokens")) {
    db.exec(`ALTER TABLE usage_daily ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`);
  }
  if (!dailyColNames.has("cache_write_tokens")) {
    db.exec(`ALTER TABLE usage_daily ADD COLUMN cache_write_tokens INTEGER DEFAULT 0`);
  }
  if (!dailyColNames.has("currency")) {
    db.exec(`ALTER TABLE usage_daily ADD COLUMN currency TEXT DEFAULT 'USD'`);
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function getValidAdminToken(): string | null {
  const row = db.prepare(`SELECT token FROM admin_token WHERE expires_at > ?`).get(Date.now()) as { token: string } | undefined;
  return row?.token ?? null;
}

export function getAdminTokenInfo(): { token: string; expires_at: number } | null {
  const row = db.prepare(`SELECT token, expires_at FROM admin_token WHERE expires_at > ?`).get(Date.now()) as { token: string; expires_at: number } | undefined;
  return row ?? null;
}

export function createAdminToken(): string {
  db.exec(`DELETE FROM admin_token`);
  const token = `admin-${nanoid()}`;
  const now = Date.now();
  db.prepare(`INSERT INTO admin_token (token, created_at, expires_at) VALUES (?, ?, ?)`).run(token, now, now + THIRTY_DAYS_MS);
  return token;
}

export function validateAdminToken(token: string): boolean {
  const row = db.prepare(`SELECT 1 FROM admin_token WHERE token = ? AND expires_at > ?`).get(token, Date.now());
  return !!row;
}
