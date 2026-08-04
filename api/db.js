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
  origin       TEXT    NOT NULL DEFAULT 'console',
  origin_label TEXT,
  attachment_id INTEGER,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token            TEXT    NOT NULL UNIQUE,
  original_name    TEXT    NOT NULL,
  stored_name      TEXT    NOT NULL UNIQUE,
  mime_type        TEXT    NOT NULL,
  size             INTEGER NOT NULL,
  owner_key_id     INTEGER,
  owner_account_id INTEGER,
  created_at       TEXT    NOT NULL,
  opened_at        TEXT,
  open_count       INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS address_books (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE (group_id, name)
);

CREATE INDEX IF NOT EXISTS idx_address_books_group ON address_books(group_id);

CREATE TABLE IF NOT EXISTS contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  address_book_id INTEGER NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  entity          TEXT,
  phone           TEXT    NOT NULL,
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_book ON contacts(address_book_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  address_book_id INTEGER,
  group_id        INTEGER,
  body            TEXT    NOT NULL,
  created_by      INTEGER,
  scheduled_at    TEXT,
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaigns_group ON campaigns(group_id);

CREATE TABLE IF NOT EXISTS incoming_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id       INTEGER,
  device_id   TEXT,
  provider_id TEXT NOT NULL,
  sender      TEXT NOT NULL,
  body        TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (device_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_incoming_created ON incoming_messages(created_at);
`);

// Migrations : colonnes ajoutées sur des bases existantes (CREATE TABLE
// IF NOT EXISTS ne modifie pas les tables déjà présentes).
const accountCols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
if (!accountCols.includes('role')) {
  db.exec("ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
if (!accountCols.includes('group_id')) {
  db.exec('ALTER TABLE accounts ADD COLUMN group_id INTEGER');
}
if (!accountCols.includes('email')) {
  db.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
}
if (!accountCols.includes('is_group_manager')) {
  db.exec('ALTER TABLE accounts ADD COLUMN is_group_manager INTEGER NOT NULL DEFAULT 0');
}
const messageCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!messageCols.includes('group_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN group_id INTEGER');
}
if (!messageCols.includes('campaign_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN campaign_id INTEGER');
}
if (!messageCols.includes('scheduled_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN scheduled_at TEXT');
}
if (!messageCols.includes('cancelled_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN cancelled_at TEXT');
}
if (!messageCols.includes('origin')) {
  db.exec("ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'console'");
}
if (!messageCols.includes('origin_label')) {
  db.exec('ALTER TABLE messages ADD COLUMN origin_label TEXT');
}
if (!messageCols.includes('attachment_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN attachment_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages(campaign_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_scheduled_at ON messages(scheduled_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_group_id ON accounts(group_id)');

module.exports = db;
