'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'gateway.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT    NOT NULL,
  type         TEXT    NOT NULL CHECK (type IN ('web', 'gateway')),
  token_hash   TEXT    NOT NULL UNIQUE,
  device_id    TEXT,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient    TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  claimed_by   INTEGER,
  claimed_at   TEXT,
  sent_at      TEXT,
  delivered_at TEXT,
  failed_at    TEXT,
  error        TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_status    ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_claimed_by ON messages(claimed_by);
CREATE INDEX IF NOT EXISTS idx_keys_type          ON keys(type);

CREATE TABLE IF NOT EXISTS gateway_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      INTEGER,
  device_id   TEXT,
  reports     INTEGER NOT NULL DEFAULT 0,
  claimed     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gateway_logs_created ON gateway_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_gateway_logs_key     ON gateway_logs(key_id);

CREATE TABLE IF NOT EXISTS auth_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     INTEGER,
  ip         TEXT,
  reason     TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_logs_created ON auth_logs(created_at);

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_login ON accounts(login);

CREATE TABLE IF NOT EXISTS claim_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  round_started TEXT,
  claimed       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO claim_state (id, round_started, claimed)
SELECT 1, NULL, 0 WHERE NOT EXISTS (SELECT 1 FROM claim_state WHERE id = 1);
`);

module.exports = db;
