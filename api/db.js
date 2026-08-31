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
  created_by    INTEGER,
  created_by_label TEXT,
  fleet_check_id INTEGER,
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
  expires_at       TEXT,
  opened_at        TEXT,
  open_count       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachment_opens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL,
  opened_at     TEXT    NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  device_type   TEXT,
  referer       TEXT,
  accept_language TEXT
);

CREATE TABLE IF NOT EXISTS fleet_checks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id            INTEGER,
  address_book_id     INTEGER NOT NULL,
  message             TEXT NOT NULL,
  created_by          INTEGER,
  created_by_label    TEXT,
  response_hours      INTEGER NOT NULL DEFAULT 72,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_check_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fleet_check_id INTEGER NOT NULL,
  message_id     INTEGER NOT NULL UNIQUE,
  contact_id     INTEGER,
  first_name     TEXT,
  last_name      TEXT,
  entity         TEXT,
  service        TEXT,
  direction      TEXT,
  imei           TEXT,
  puk            TEXT,
  line_status    TEXT,
  plan           TEXT,
  device_terminal TEXT,
  secondary_line  TEXT,
  phone          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending',
  sent_at       TEXT,
  delivered_at  TEXT,
  failed_at     TEXT,
  error         TEXT,
  response_at   TEXT,
  response_sender TEXT,
  response_body TEXT,
  UNIQUE (fleet_check_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_fleet_items_check ON fleet_check_items(fleet_check_id);
CREATE INDEX IF NOT EXISTS idx_fleet_items_phone ON fleet_check_items(phone, response_at);

CREATE INDEX IF NOT EXISTS idx_attachment_opens_attachment ON attachment_opens(attachment_id, opened_at);

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

CREATE TABLE IF NOT EXISTS console_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  login      TEXT    NOT NULL,
  role       TEXT,
  action     TEXT    NOT NULL,
  detail     TEXT,
  count      INTEGER NOT NULL DEFAULT 1,
  ip         TEXT,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_console_logs_created ON console_logs(created_at);

CREATE TABLE IF NOT EXISTS sync_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  api_key       TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  last_status   TEXT,
  last_error    TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_books (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        INTEGER NOT NULL,
  remote_book_id   INTEGER NOT NULL,
  remote_book_name TEXT    NOT NULL,
  remote_group_id  INTEGER,
  remote_group_name TEXT,
  local_book_id    INTEGER,
  last_synced_at   TEXT,
  last_status      TEXT,
  last_error       TEXT,
  UNIQUE (source_id, remote_book_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_books_source ON sync_books(source_id);

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
  service         TEXT,
  direction       TEXT,
  imei            TEXT,
  puk             TEXT,
  line_status     TEXT,
  plan            TEXT,
  device_terminal TEXT,
  secondary_line  TEXT,
  phone           TEXT    NOT NULL,
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_book ON contacts(address_book_id);

CREATE TABLE IF NOT EXISTS blacklist_numbers (
  phone       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  created_by  INTEGER,
  created_by_label TEXT
);

CREATE INDEX IF NOT EXISTS idx_blacklist_numbers_phone ON blacklist_numbers(phone);

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

CREATE TABLE IF NOT EXISTS mail2sms_boxes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  email             TEXT    NOT NULL,
  imap_host         TEXT    NOT NULL,
  imap_port         INTEGER NOT NULL DEFAULT 993,
  imap_secure       INTEGER NOT NULL DEFAULT 1,
  imap_folder       TEXT    NOT NULL DEFAULT 'INBOX',
  login             TEXT    NOT NULL,
  password          TEXT    NOT NULL,
  allowed_senders   TEXT    NOT NULL,
  reply_enabled     INTEGER NOT NULL DEFAULT 1,
  reply_delay_min   INTEGER NOT NULL DEFAULT 5,
  reply_subject     TEXT    NOT NULL DEFAULT 'Re: ',
  smtp_host         TEXT,
  smtp_port         INTEGER,
  smtp_secure       INTEGER,
  smtp_login        TEXT,
  smtp_password     TEXT,
  scan_interval_sec INTEGER NOT NULL DEFAULT 60,
  processed_folder  TEXT    NOT NULL DEFAULT 'SMS Traités',
  active            INTEGER NOT NULL DEFAULT 1,
  last_scan_at      TEXT,
  last_status       TEXT,
  last_error        TEXT,
  created_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail2sms_boxes_active ON mail2sms_boxes(active);

CREATE TABLE IF NOT EXISTS mail2sms_emails (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id          INTEGER NOT NULL,
  message_uid     TEXT    NOT NULL,
  message_id      TEXT,
  from_addr       TEXT    NOT NULL,
  subject         TEXT    NOT NULL,
  received_at     TEXT    NOT NULL,
  processed_at    TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'processed',
  error           TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  reply_attempts  INTEGER NOT NULL DEFAULT 0,
  reply_sent_at   TEXT,
  reply_error     TEXT,
  UNIQUE (box_id, message_uid)
);

CREATE INDEX IF NOT EXISTS idx_mail2sms_emails_box   ON mail2sms_emails(box_id);
CREATE INDEX IF NOT EXISTS idx_mail2sms_emails_reply ON mail2sms_emails(status, reply_sent_at);
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
if (!accountCols.includes('last_login_at')) {
  db.exec('ALTER TABLE accounts ADD COLUMN last_login_at TEXT');
}
if (!accountCols.includes('phone')) {
  db.exec('ALTER TABLE accounts ADD COLUMN phone TEXT');
}

// Entrée pivot « admin » : le compte administrateur (connexion sans login)
// n'a pas de ligne dans accounts ; on stocke ici son numéro de téléphone
// pour les alertes SMS. La ligne est garantie au démarrage.
db.prepare(
  'INSERT OR IGNORE INTO accounts (login, password_hash, role, disabled, created_at) VALUES (?, ?, ?, 0, ?)'
).run('', '', 'admin', new Date().toISOString());
const keyCols = db.prepare('PRAGMA table_info(keys)').all().map((c) => c.name);
if (!keyCols.includes('app_version')) {
  db.exec('ALTER TABLE keys ADD COLUMN app_version TEXT');
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
if (!messageCols.includes('created_by')) {
  db.exec('ALTER TABLE messages ADD COLUMN created_by INTEGER');
}
if (!messageCols.includes('created_by_label')) {
  db.exec('ALTER TABLE messages ADD COLUMN created_by_label TEXT');
}
if (!messageCols.includes('fleet_check_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN fleet_check_id INTEGER');
}
if (!messageCols.includes('mail2sms_email_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN mail2sms_email_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mail2sms_email_id ON messages(mail2sms_email_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages(campaign_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_scheduled_at ON messages(scheduled_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_group_id ON accounts(group_id)');

const contactCols = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
for (const column of ['service', 'direction', 'imei', 'puk']) {
  if (!contactCols.includes(column)) db.exec(`ALTER TABLE contacts ADD COLUMN ${column} TEXT`);
}
const bookContactCols = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
for (const column of ['line_status', 'plan', 'device_terminal', 'secondary_line']) {
  if (!bookContactCols.includes(column)) db.exec(`ALTER TABLE contacts ADD COLUMN ${column} TEXT`);
}
const fleetItemCols = db.prepare('PRAGMA table_info(fleet_check_items)').all().map((c) => c.name);
for (const column of ['service', 'direction', 'imei', 'puk']) {
  if (!fleetItemCols.includes(column)) db.exec(`ALTER TABLE fleet_check_items ADD COLUMN ${column} TEXT`);
}
const fleetItemNewCols = db.prepare('PRAGMA table_info(fleet_check_items)').all().map((c) => c.name);
for (const column of ['line_status', 'plan', 'device_terminal', 'secondary_line']) {
  if (!fleetItemNewCols.includes(column)) db.exec(`ALTER TABLE fleet_check_items ADD COLUMN ${column} TEXT`);
}

const attachmentCols = db.prepare('PRAGMA table_info(attachments)').all().map((c) => c.name);
if (!attachmentCols.includes('expires_at')) {
  db.exec('ALTER TABLE attachments ADD COLUMN expires_at TEXT');
  db.exec("UPDATE attachments SET expires_at = datetime(created_at, '+90 days') WHERE expires_at IS NULL");
}

// Mail → SMS : dossier IMAP de destination des e-mails transformés en SMS.
const m2sBoxCols = db.prepare('PRAGMA table_info(mail2sms_boxes)').all().map((c) => c.name);
if (!m2sBoxCols.includes('processed_folder')) {
  db.exec("ALTER TABLE mail2sms_boxes ADD COLUMN processed_folder TEXT NOT NULL DEFAULT 'SMS Traités'");
}

// Journal console : mémorise le navigateur/appareil du client pour distinguer
// les connexions qui partagent la même IP publique (NAT de la box).
const logCols = db.prepare('PRAGMA table_info(console_logs)').all().map((c) => c.name);
if (!logCols.includes('user_agent')) {
  db.exec('ALTER TABLE console_logs ADD COLUMN user_agent TEXT');
}

// Carnets synchronisés : créés sans groupe (groupe NULL = visibles par les
// administrateurs uniquement, comme pour les comptes). La colonne était
// NOT NULL à l'origine : on reconstruit la table pour l'assouplir.
const bookGroupCol = db.prepare('PRAGMA table_info(address_books)').all()
  .find((c) => c.name === 'group_id');
if (bookGroupCol && bookGroupCol.notnull === 1) {
  db.exec(`
    BEGIN;
    ALTER TABLE address_books RENAME TO address_books_old;
    CREATE TABLE address_books (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id   INTEGER,
      name       TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      UNIQUE (group_id, name)
    );
    INSERT INTO address_books (id, group_id, name, created_at)
      SELECT id, group_id, name, created_at FROM address_books_old;
    DROP TABLE address_books_old;
    COMMIT;
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_address_books_group ON address_books(group_id)');
}

module.exports = db;
