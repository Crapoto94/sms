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

-- Envoi de SMS externe (Frizbi) : identifiants API + mode de routage.
-- mode : 'internal' (passerelles uniquement, comportement historique),
-- 'frizbi' (toujours Frizbi), 'both' (Frizbi seulement au-delà de
-- both_threshold destinataires dans un même envoi, sinon passerelles).
-- Quota par passerelle interne : nombre maxi de destinataires distincts sur
-- une fenêtre glissante (protection contre le blocage anti-spam opérateur,
-- ex. SFR limite les forfaits grand public à 200 destinataires distincts/mois).
CREATE TABLE IF NOT EXISTS gateway_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  quota_cap         INTEGER NOT NULL DEFAULT 180,
  quota_window_days INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS frizbi_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  mode           TEXT    NOT NULL DEFAULT 'internal',
  both_threshold INTEGER NOT NULL DEFAULT 10,
  api_url        TEXT    NOT NULL DEFAULT 'https://apiv2.frizbi.evolnet.fr',
  client_id      TEXT,
  client_secret  TEXT,
  sender_id      TEXT    NOT NULL DEFAULT '',
  callback_token TEXT,
  updated_at     TEXT
);

-- Journal des callbacks Frizbi reçus (statut d'envoi). La doc V2.3 ne
-- fournit pas d'exemple JSON pour ce callback ni pour /api/sms/status :
-- ce journal sert à observer le trafic réel une fois configuré côté
-- Frizbi (Admin > API) plutôt qu'à deviner le format à l'avance.
CREATE TABLE IF NOT EXISTS frizbi_events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at            TEXT    NOT NULL,
  source                 TEXT    NOT NULL DEFAULT 'callback',
  message_id             INTEGER,
  customer_sms_id        TEXT,
  customer_sms_contact_id TEXT,
  status_raw             TEXT,
  payload                TEXT,
  applied                INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_frizbi_events_received ON frizbi_events(received_at);

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

-- Un tour de répartition (round) par tenant : sans cela, les passerelles
-- d'un tenant chargé fausseraient le calcul de part équitable des
-- passerelles d'un autre tenant (cf. migration plus bas pour les bases
-- pré-multi-tenant).
CREATE TABLE IF NOT EXISTS claim_state (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL UNIQUE,
  round_started TEXT,
  claimed       INTEGER NOT NULL DEFAULT 0
);

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

-- Multi-tenant : chaque organisation cliente (« tenant ») a ses propres
-- messages, jetons API/passerelles, groupes, etc. Le compte pivot admin
-- (login vide) n'appartient à aucun tenant : c'est le super-admin, il voit
-- tous les tenants. Les tenants existants avant cette version sont rattachés
-- au tenant n°1 par les migrations plus bas.
CREATE TABLE IF NOT EXISTS tenants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  slug       TEXT    NOT NULL UNIQUE,
  status     TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_verification', 'suspended')),
  plan       TEXT    NOT NULL DEFAULT 'free',
  created_at TEXT    NOT NULL
);

-- Fonctionnalités activables par tenant. Absence de ligne = valeur par
-- défaut gérée en code (tenantHasFeature ci-dessous) : les fonctionnalités
-- gratuites (unit_send, mass_send, api_send) sont considérées actives même
-- sans ligne, pour éviter un backfill sur chaque nouveau tenant.
CREATE TABLE IF NOT EXISTS tenant_features (
  tenant_id INTEGER NOT NULL,
  feature   TEXT    NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, feature)
);

-- Jetons de vérification (création de compte, réinitialisation de mot de
-- passe). token_hash stocke un sha256 du jeton envoyé par e-mail, jamais le
-- jeton en clair (même principe que keys.token_hash).
CREATE TABLE IF NOT EXISTS email_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  token_hash  TEXT    NOT NULL UNIQUE,
  purpose     TEXT    NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup', 'reset')),
  expires_at  TEXT    NOT NULL,
  consumed_at TEXT,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_account ON email_verifications(account_id);
`);

// Tenant historique : toutes les données créées avant l'arrivée du
// multi-tenant sont rattachées à ce tenant n°1 par les migrations ci-dessous.
const DEFAULT_TENANT_ID = 1;
db.prepare(
  'INSERT OR IGNORE INTO tenants (id, name, slug, status, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)'
).run(DEFAULT_TENANT_ID, 'Organisation par défaut', 'organisation-par-defaut', 'active', 'free', new Date().toISOString());

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
if (!accountCols.includes('tenant_id')) {
  db.exec('ALTER TABLE accounts ADD COLUMN tenant_id INTEGER');
}
if (!accountCols.includes('email_verified_at')) {
  // NULL = compte créé en libre-service pas encore vérifié. Les comptes
  // existants avant cette version (créés par un admin) sont considérés
  // vérifiés d'office par la migration ci-dessous.
  db.exec('ALTER TABLE accounts ADD COLUMN email_verified_at TEXT');
}

// Entrée pivot « admin » : le compte administrateur (connexion sans login)
// n'a pas de ligne dans accounts ; on stocke ici son numéro de téléphone
// pour les alertes SMS. La ligne est garantie au démarrage. C'est le
// super-admin : il n'appartient à aucun tenant et voit tous les tenants.
db.prepare(
  'INSERT OR IGNORE INTO accounts (login, password_hash, role, disabled, created_at) VALUES (?, ?, ?, 0, ?)'
).run('', '', 'super_admin', new Date().toISOString());
// Bascule le compte pivot d'une base pré-multi-tenant (role='admin') vers
// super_admin, et rattache tous les autres comptes déjà en base au tenant
// historique (comptes créés en libre-service : déjà correctement rattachés
// à leur tenant dès la création, donc non affectés par ce WHERE).
db.prepare("UPDATE accounts SET role = 'super_admin', tenant_id = NULL WHERE login = ''").run();
db.prepare('UPDATE accounts SET tenant_id = ? WHERE tenant_id IS NULL AND login <> ?').run(DEFAULT_TENANT_ID, '');
db.prepare('UPDATE accounts SET email_verified_at = created_at WHERE email_verified_at IS NULL AND login <> ?').run('');
const keyCols = db.prepare('PRAGMA table_info(keys)').all().map((c) => c.name);
if (!keyCols.includes('app_version')) {
  db.exec('ALTER TABLE keys ADD COLUMN app_version TEXT');
}
if (!keyCols.includes('sim_count')) {
  // Nombre de lignes (cartes SIM) actives sur le téléphone, remonté par
  // l'APK à chaque sondage. Sert à estimer la répartition par ligne avant
  // de lancer un envoi en masse (1 par défaut si l'APK ne le remonte pas
  // encore, ou sur une version antérieure).
  db.exec('ALTER TABLE keys ADD COLUMN sim_count INTEGER NOT NULL DEFAULT 1');
}
if (!keyCols.includes('tenant_id')) {
  // Jetons API et passerelles n'étaient pas isolés par organisation avant
  // le multi-tenant : tout est rattaché au tenant historique.
  db.exec('ALTER TABLE keys ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE keys SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id)');
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
if (!messageCols.includes('provider')) {
  db.exec("ALTER TABLE messages ADD COLUMN provider TEXT NOT NULL DEFAULT 'internal'");
}
if (!messageCols.includes('provider_ref')) {
  db.exec('ALTER TABLE messages ADD COLUMN provider_ref TEXT');
}
if (!messageCols.includes('sim_slot')) {
  // Emplacement (0, 1, ...) de la carte SIM ayant réellement envoyé le
  // message, remonté par l'APK — permet de détailler l'envoi par ligne sur
  // un téléphone multi-SIM. Null si l'APK ne le remonte pas (versions
  // antérieures) ou si le message n'a pas encore été traité.
  db.exec('ALTER TABLE messages ADD COLUMN sim_slot INTEGER');
}
if (!messageCols.includes('sim_number')) {
  db.exec('ALTER TABLE messages ADD COLUMN sim_number TEXT');
}
if (!messageCols.includes('tenant_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE messages SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_tenant_id ON messages(tenant_id)');
const frizbiCols = db.prepare('PRAGMA table_info(frizbi_settings)').all().map((c) => c.name);
if (!frizbiCols.includes('callback_token')) {
  db.exec('ALTER TABLE frizbi_settings ADD COLUMN callback_token TEXT');
}
// frizbi_settings et gateway_settings étaient des singletons (id figé à 1) :
// on reconstruit les deux tables pour passer à une ligne par tenant.
if (!frizbiCols.includes('tenant_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE frizbi_settings_new (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id      INTEGER NOT NULL UNIQUE,
      mode           TEXT    NOT NULL DEFAULT 'internal',
      both_threshold INTEGER NOT NULL DEFAULT 10,
      api_url        TEXT    NOT NULL DEFAULT 'https://apiv2.frizbi.evolnet.fr',
      client_id      TEXT,
      client_secret  TEXT,
      sender_id      TEXT    NOT NULL DEFAULT '',
      callback_token TEXT,
      updated_at     TEXT
    );
    INSERT INTO frizbi_settings_new (tenant_id, mode, both_threshold, api_url, client_id, client_secret, sender_id, callback_token, updated_at)
      SELECT ${DEFAULT_TENANT_ID}, mode, both_threshold, api_url, client_id, client_secret, sender_id, callback_token, updated_at
      FROM frizbi_settings WHERE id = 1;
    DROP TABLE frizbi_settings;
    ALTER TABLE frizbi_settings_new RENAME TO frizbi_settings;
    COMMIT;
  `);
}
const gwSettingsCols = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
if (!gwSettingsCols.includes('tenant_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE gateway_settings_new (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         INTEGER NOT NULL UNIQUE,
      quota_cap         INTEGER NOT NULL DEFAULT 180,
      quota_window_days INTEGER NOT NULL DEFAULT 30
    );
    INSERT INTO gateway_settings_new (tenant_id, quota_cap, quota_window_days)
      SELECT ${DEFAULT_TENANT_ID}, quota_cap, quota_window_days FROM gateway_settings WHERE id = 1;
    DROP TABLE gateway_settings;
    ALTER TABLE gateway_settings_new RENAME TO gateway_settings;
    COMMIT;
  `);
}
// Garantit une ligne de réglages par tenant existant (nouveaux tenants
// inclus, au cas où cette migration tourne après leur création).
db.prepare(`
  INSERT OR IGNORE INTO frizbi_settings (tenant_id)
  SELECT id FROM tenants WHERE id NOT IN (SELECT tenant_id FROM frizbi_settings)
`).run();
db.prepare(`
  INSERT OR IGNORE INTO gateway_settings (tenant_id)
  SELECT id FROM tenants WHERE id NOT IN (SELECT tenant_id FROM gateway_settings)
`).run();

// claim_state était un singleton global (id figé à 1) : reconstruit en une
// ligne par tenant, comme gateway_settings/frizbi_settings ci-dessus.
const claimStateCols = db.prepare('PRAGMA table_info(claim_state)').all().map((c) => c.name);
if (!claimStateCols.includes('tenant_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE claim_state_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     INTEGER NOT NULL UNIQUE,
      round_started TEXT,
      claimed       INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO claim_state_new (tenant_id, round_started, claimed)
      SELECT ${DEFAULT_TENANT_ID}, round_started, claimed FROM claim_state WHERE id = 1;
    DROP TABLE claim_state;
    ALTER TABLE claim_state_new RENAME TO claim_state;
    COMMIT;
  `);
}
db.prepare(`
  INSERT OR IGNORE INTO claim_state (tenant_id)
  SELECT id FROM tenants WHERE id NOT IN (SELECT tenant_id FROM claim_state)
`).run();

db.exec('CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mail2sms_email_id ON messages(mail2sms_email_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages(campaign_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_scheduled_at ON messages(scheduled_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_group_id ON accounts(group_id)');

// groups.name était unique globalement (une seule organisation). Avec le
// multi-tenant, deux tenants doivent pouvoir chacun avoir un groupe
// « Commercial » : on reconstruit la table avec tenant_id + unicité
// (tenant_id, name).
const groupCols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
if (!groupCols.includes('tenant_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE groups_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      UNIQUE (tenant_id, name)
    );
    INSERT INTO groups_new (id, tenant_id, name, created_at)
      SELECT id, ${DEFAULT_TENANT_ID}, name, created_at FROM groups;
    DROP TABLE groups;
    ALTER TABLE groups_new RENAME TO groups;
    COMMIT;
  `);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenant_id)');

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

const campaignCols = db.prepare('PRAGMA table_info(campaigns)').all().map((c) => c.name);
if (!campaignCols.includes('name')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN name TEXT');
}
const fleetCheckCols = db.prepare('PRAGMA table_info(fleet_checks)').all().map((c) => c.name);
if (!fleetCheckCols.includes('name')) {
  db.exec('ALTER TABLE fleet_checks ADD COLUMN name TEXT');
}
if (!fleetCheckCols.includes('deleted_at')) {
  db.exec('ALTER TABLE fleet_checks ADD COLUMN deleted_at TEXT');
}
if (!campaignCols.includes('deleted_at')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN deleted_at TEXT');
}
if (!campaignCols.includes('tenant_id')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE campaigns SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
if (!fleetCheckCols.includes('tenant_id')) {
  db.exec('ALTER TABLE fleet_checks ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE fleet_checks SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_checks_tenant ON fleet_checks(tenant_id)');

// Numéros exclus par défaut des envois en masse (campagnes et vérifications
// de flotte) : contrairement à la liste noire, ce n'est pas un blocage —
// l'opérateur peut réinclure le numéro pour un envoi précis. Indexé sur le
// numéro seul (comme la liste noire) pour survivre à un réimport CSV du
// carnet, même en mode « écraser ».
db.exec(`
  CREATE TABLE IF NOT EXISTS mass_exclusions (
    phone            TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL,
    created_by       INTEGER,
    created_by_label TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mass_exclusions_phone ON mass_exclusions(phone);
`);

// blacklist_numbers et mass_exclusions étaient globaux (phone en clé
// primaire) : un numéro bloqué par un tenant bloquait tout le monde. On
// reconstruit les deux tables avec une clé (tenant_id, phone).
const blacklistCols = db.prepare('PRAGMA table_info(blacklist_numbers)').all().map((c) => c.name);
if (!blacklistCols.includes('tenant_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE blacklist_numbers_new (
      tenant_id        INTEGER NOT NULL,
      phone            TEXT    NOT NULL,
      created_at       TEXT    NOT NULL,
      created_by       INTEGER,
      created_by_label TEXT,
      PRIMARY KEY (tenant_id, phone)
    );
    INSERT INTO blacklist_numbers_new (tenant_id, phone, created_at, created_by, created_by_label)
      SELECT ${DEFAULT_TENANT_ID}, phone, created_at, created_by, created_by_label FROM blacklist_numbers;
    DROP TABLE blacklist_numbers;
    ALTER TABLE blacklist_numbers_new RENAME TO blacklist_numbers;
    CREATE INDEX idx_blacklist_numbers_tenant ON blacklist_numbers(tenant_id);
    COMMIT;
  `);
}
const massExclusionCols = db.prepare('PRAGMA table_info(mass_exclusions)').all().map((c) => c.name);
if (!massExclusionCols.includes('tenant_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE mass_exclusions_new (
      tenant_id        INTEGER NOT NULL,
      phone            TEXT    NOT NULL,
      created_at       TEXT    NOT NULL,
      created_by       INTEGER,
      created_by_label TEXT,
      PRIMARY KEY (tenant_id, phone)
    );
    INSERT INTO mass_exclusions_new (tenant_id, phone, created_at, created_by, created_by_label)
      SELECT ${DEFAULT_TENANT_ID}, phone, created_at, created_by, created_by_label FROM mass_exclusions;
    DROP TABLE mass_exclusions;
    ALTER TABLE mass_exclusions_new RENAME TO mass_exclusions;
    CREATE INDEX idx_mass_exclusions_tenant ON mass_exclusions(tenant_id);
    COMMIT;
  `);
}

const attachmentCols = db.prepare('PRAGMA table_info(attachments)').all().map((c) => c.name);
if (!attachmentCols.includes('expires_at')) {
  db.exec('ALTER TABLE attachments ADD COLUMN expires_at TEXT');
  db.exec("UPDATE attachments SET expires_at = datetime(created_at, '+90 days') WHERE expires_at IS NULL");
}
if (!attachmentCols.includes('tenant_id')) {
  db.exec('ALTER TABLE attachments ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE attachments SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_tenant ON attachments(tenant_id)');

// Mail → SMS : dossier IMAP de destination des e-mails transformés en SMS.
const m2sBoxCols = db.prepare('PRAGMA table_info(mail2sms_boxes)').all().map((c) => c.name);
if (!m2sBoxCols.includes('processed_folder')) {
  db.exec("ALTER TABLE mail2sms_boxes ADD COLUMN processed_folder TEXT NOT NULL DEFAULT 'SMS Traités'");
}
if (!m2sBoxCols.includes('tenant_id')) {
  // Mail2SMS est une fonctionnalité payante : les boîtes existantes
  // appartiennent au tenant historique, qui l'a déjà en usage (activée
  // plus bas dans tenant_features pour ne pas régresser une prod active).
  db.exec('ALTER TABLE mail2sms_boxes ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE mail2sms_boxes SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_mail2sms_boxes_tenant ON mail2sms_boxes(tenant_id)');

const syncSourceCols = db.prepare('PRAGMA table_info(sync_sources)').all().map((c) => c.name);
if (!syncSourceCols.includes('tenant_id')) {
  db.exec('ALTER TABLE sync_sources ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE sync_sources SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_sync_sources_tenant ON sync_sources(tenant_id)');

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
const addressBookCols = db.prepare('PRAGMA table_info(address_books)').all().map((c) => c.name);
if (!addressBookCols.includes('tenant_id')) {
  db.exec('ALTER TABLE address_books ADD COLUMN tenant_id INTEGER');
  db.exec(`UPDATE address_books SET tenant_id = ${DEFAULT_TENANT_ID} WHERE tenant_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_address_books_tenant ON address_books(tenant_id)');

// --- Fonctionnalités par tenant -------------------------------------------
// Gratuites par défaut (activées explicitement pour clarté dans l'admin,
// même si tenantHasFeature() les considère actives par défaut de toute
// façon). Le tenant historique avait déjà mail2sms et les pièces jointes en
// usage réel : on les active pour ne pas régresser une organisation active.
const FREE_FEATURES = ['unit_send', 'mass_send', 'api_send'];
const PAID_FEATURES = ['mail2sms', 'attachment_read_receipt'];
const ALL_FEATURES = [...FREE_FEATURES, ...PAID_FEATURES];

function seedTenantFeatures(tenantId, enabledFeatures) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO tenant_features (tenant_id, feature, enabled) VALUES (?, ?, ?)'
  );
  for (const feature of ALL_FEATURES) {
    stmt.run(tenantId, feature, enabledFeatures.includes(feature) ? 1 : 0);
  }
}
seedTenantFeatures(DEFAULT_TENANT_ID, [...FREE_FEATURES, ...PAID_FEATURES]);

// enabled=1 explicite, OU aucune ligne pour une feature gratuite (nouveaux
// tenants créés avant qu'une nouvelle feature gratuite existe encore ici).
function tenantHasFeature(tenantId, feature) {
  if (tenantId == null) return true; // super-admin : jamais bridé
  const row = db.prepare(
    'SELECT enabled FROM tenant_features WHERE tenant_id = ? AND feature = ?'
  ).get(tenantId, feature);
  if (row) return !!row.enabled;
  return FREE_FEATURES.includes(feature);
}

db.tenantHasFeature = tenantHasFeature;
db.seedTenantFeatures = seedTenantFeatures;
db.FREE_FEATURES = FREE_FEATURES;
db.PAID_FEATURES = PAID_FEATURES;
db.ALL_FEATURES = ALL_FEATURES;
db.DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;

module.exports = db;
