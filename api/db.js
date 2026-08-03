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
`);

module.exports = db;
