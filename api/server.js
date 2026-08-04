'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('./db');

const PORT_API = parseInt(process.env.PORT_API || '3250', 10);
const PORT_WEB = parseInt(process.env.PORT_WEB || '3251', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const APP_VERSION = process.env.APP_VERSION || '1.20';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SENDING_STALE_MS = 10 * 60 * 1000;
const CLAIM_LIMIT = 25;
const MAX_MESSAGE_LENGTH = 1000;
// Répartition de charge entre passerelles :
//  - intervalle conseillé aux passerelles (renvoyé dans /sync)
//  - passerelle « active » = synchronisée il y a moins de 2 intervalles
//  - message en attente depuis >= 1 intervalle = prenable par le premier venu
const SYNC_INTERVAL_SEC = parseInt(process.env.SYNC_INTERVAL_SEC || '60', 10);
const ACTIVE_WINDOW_MS = parseInt(process.env.ACTIVE_WINDOW_SEC || String(SYNC_INTERVAL_SEC * 2), 10) * 1000;
const ESCALATION_MS = parseInt(process.env.ESCALATION_SEC || String(SYNC_INTERVAL_SEC), 10) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const isoNow = () => new Date().toISOString();
const isExpired = (row) => !!row.expires_at && Date.parse(row.expires_at) < Date.now();

// ---------- Hachage des mots de passe des comptes (scrypt + sel) ----------
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_SALT_LEN = 16;

function hashPassword(password) {
  const salt = crypto.randomBytes(PASSWORD_SALT_LEN).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calc);
}

// ---------- Rate limiting (simple, en mémoire) ----------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '30', 10);
const rateHits = new Map(); // "ip|keyId" -> [timestamps]

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = `${req.socket.remoteAddress || req.ip || ''}|${req.apiKey ? req.apiKey.id : 'anon'}`;
  const hits = (rateHits.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Trop de requêtes, réessayez dans quelques secondes' });
  }
  hits.push(now);
  rateHits.set(key, hits);
  next();
}

// ---------- Journalisation des tentatives d'authentification ----------
function logAuthAttempt(req, keyId, reason) {
  try {
    db.prepare(
      'INSERT INTO auth_logs (key_id, ip, reason, created_at) VALUES (?, ?, ?, ?)'
    ).run(keyId || null, req.socket.remoteAddress || req.ip || '', reason, isoNow());
  } catch (_) { /* ne bloque jamais la réponse */ }
}

// ---------- Sessions de l'interface web ----------
const sessions = new Map(); // sid -> { exp, accountId|null, login, isAdmin }

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionValid(req) {
  const sid = parseCookies(req).sid;
  const s = sessions.get(sid);
  if (!s || s.exp < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  if (s.accountId) {
    const acc = db.prepare('SELECT id FROM accounts WHERE id = ? AND disabled = 0').get(s.accountId);
    if (!acc) {
      sessions.delete(sid);
      return null;
    }
  }
  return s;
}

// ---------- Authentification par clé API ----------
function getBearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : null;
}

function requireApiKey(type) {
  return (req, res, next) => {
    const token = getBearer(req);
    if (!token) {
      logAuthAttempt(req, null, '401 Clé API manquante');
      return res.status(401).json({ error: 'Clé API manquante' });
    }
    const row = db.prepare('SELECT * FROM keys WHERE token_hash = ?').get(sha256(token));
    if (!row) {
      logAuthAttempt(req, null, '401 Clé API invalide');
      return res.status(401).json({ error: 'Clé API invalide' });
    }
    if (row.revoked) {
      logAuthAttempt(req, row.id, '403 Clé révoquée');
      return res.status(403).json({ error: 'Clé révoquée' });
    }
    if (row.type !== type) {
      logAuthAttempt(req, row.id, `403 Type de clé inadapté (${row.type} au lieu de ${type})`);
      return res.status(403).json({ error: 'Type de clé inadapté' });
    }
    if (isExpired(row)) {
      logAuthAttempt(req, row.id, '403 Clé expirée');
      return res.status(403).json({ error: 'Clé expirée' });
    }
    db.prepare('UPDATE keys SET last_used_at = ? WHERE id = ?').run(isoNow(), row.id);
    req.apiKey = row;
    next();
  };
}

// ---------- API publique (port 3250) ----------
const apiApp = express();
apiApp.use(express.json());
apiApp.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

apiApp.get('/health', (_req, res) => res.json({ ok: true }));

// Envoi d'un SMS demandé par une application web (clé type "web")
apiApp.post('/api/v1/messages', requireApiKey('web'), rateLimit, (req, res) => {
  const recipient = String(req.body.recipient || '').trim();
  const message = String(req.body.message || '').trim();
  if (!/^\+?[0-9]{4,15}$/.test(recipient)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (message.length === 0) return res.status(400).json({ error: 'Message vide' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message trop long (max ${MAX_MESSAGE_LENGTH} caractères)` });
  }
  const createdAt = isoNow();
  const info = db.prepare(
    'INSERT INTO messages (recipient, body, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(recipient, message, 'pending', createdAt);
  res.status(201).json({
    id: info.lastInsertRowid,
    recipient,
    message,
    status: 'pending',
    createdAt
  });
});

// Synchronisation passerelle (clé type "gateway")
// 1. remonte les statuts (sent / delivered / failed) depuis la dernière synchro,
// 2. récupère les messages à envoyer en les marquant "en cours d'envoi" :
//    ils deviennent invisibles pour une autre passerelle, sauf si elle a disparu
//    (réclamation automatique après 10 minutes sans confirmation).
apiApp.post('/api/v1/gateway/sync', requireApiKey('gateway'), (req, res) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const body = req.body || {};
  const deviceId = String(body.deviceId || req.apiKey.device_id || '').trim();
  const reports = Array.isArray(body.reports) ? body.reports : [];

  const reportAccepted = [];
  const updateStatus = db.prepare(`
    UPDATE messages SET
      status        = ?,
      sent_at      = CASE WHEN ? = 'sent'      THEN ? ELSE sent_at END,
      delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
      failed_at    = CASE WHEN ? = 'failed'    THEN ? ELSE failed_at END,
      error        = ?,
      updated_at   = ?
    WHERE id = ?
  `);

  let claimed;
  db.exec('BEGIN');
  try {
    for (const r of reports) {
      const id = Number(r.id);
      const status = String(r.status || '').toLowerCase();
      if (!Number.isInteger(id) || !['sent', 'delivered', 'failed'].includes(status)) continue;
      const error = r.error ? String(r.error).slice(0, 500) : null;
      const info = updateStatus.run(
        status,
        status, nowIso,
        status, nowIso,
        status, nowIso,
        error, nowIso, id
      );
      if (info.changes > 0) reportAccepted.push(id);
    }

    // Répartition de charge : chaque passerelle récupère sa part de la file
    // (environ 1/N si N passerelles actives), pas la file entière, pour
    // laisser les autres passerelles récupérer les leurs. Les messages en
    // attente depuis >= 1 intervalle sont prenables par le premier venu,
    // pour qu'aucun message ne soit oublié si une passerelle ne revient pas.
    const intervalMs = SYNC_INTERVAL_SEC * 1000;
    const claimState = db.prepare('SELECT * FROM claim_state WHERE id = 1').get();
    if (!claimState.round_started || Date.now() - Date.parse(claimState.round_started) >= intervalMs) {
      db.prepare('UPDATE claim_state SET round_started = ?, claimed = 0 WHERE id = 1').run(nowIso);
      claimState.round_started = nowIso;
      claimState.claimed = 0;
    }

    const pendingCount = db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE status = 'pending'"
    ).get().c;

    const activeCutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS).toISOString();
    let activeCount = db.prepare(
      "SELECT COUNT(*) AS c FROM keys WHERE type = 'gateway' AND last_seen_at > ?"
    ).get(activeCutoff).c;
    const selfFresh = req.apiKey.last_seen_at &&
      Date.parse(req.apiKey.last_seen_at) >= now.getTime() - ACTIVE_WINDOW_MS;
    if (!selfFresh) activeCount++;
    activeCount = Math.max(1, activeCount);

    const share = Math.max(1, Math.ceil((pendingCount + claimState.claimed) / activeCount));
    const myClaimedThisRound = db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE claimed_by = ? AND claimed_at >= ?'
    ).get(req.apiKey.id, claimState.round_started).c;
    let allowance = Math.max(0, share - myClaimedThisRound);

    const cutoff = new Date(now.getTime() - SENDING_STALE_MS).toISOString();
    const escalationCutoff = new Date(now.getTime() - ESCALATION_MS).toISOString();
    const stale = db.prepare(
      "SELECT * FROM messages WHERE status = 'sending' AND claimed_at < ? ORDER BY id ASC LIMIT ?"
    ).all(cutoff, CLAIM_LIMIT);
    const pending = db.prepare(
      "SELECT * FROM messages WHERE status = 'pending' ORDER BY id ASC LIMIT ?"
    ).all(CLAIM_LIMIT);

    const toClaim = [];
    let pendingClaimed = 0;
    const add = (m) => { if (toClaim.length < CLAIM_LIMIT) toClaim.push(m); };
    for (const m of stale) add(m);
    for (const m of pending) {
      if (toClaim.length >= CLAIM_LIMIT) break;
      if (m.created_at <= escalationCutoff) { add(m); pendingClaimed++; }
      else if (allowance > 0) { add(m); pendingClaimed++; allowance--; }
    }
    if (pendingClaimed > 0) {
      db.prepare('UPDATE claim_state SET claimed = claimed + ? WHERE id = 1').run(pendingClaimed);
    }

    const markClaimed = db.prepare(
      "UPDATE messages SET status = 'sending', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?"
    );
    for (const m of toClaim) markClaimed.run(req.apiKey.id, nowIso, nowIso, m.id);

    db.prepare(`
      UPDATE keys SET
        last_seen_at = ?,
        last_used_at = ?,
        device_id = CASE WHEN ? <> '' THEN ? ELSE device_id END
      WHERE id = ?
    `).run(nowIso, nowIso, deviceId, deviceId, req.apiKey.id);

    claimed = toClaim;
    db.exec('COMMIT');

    db.prepare(
      'INSERT INTO gateway_logs (key_id, device_id, reports, claimed, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(req.apiKey.id, deviceId, reportAccepted.length, claimed.length, nowIso);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({
    serverTime: nowIso,
    intervalSec: SYNC_INTERVAL_SEC,
    reportsAccepted: reportAccepted,
    messages: claimed.map((m) => ({ id: m.id, recipient: m.recipient, body: m.body }))
  });
});

// ---------- Interface web (port 3251) ----------
function requireSession(req, res, next) {
  const s = sessionValid(req);
  if (!s) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  req.session = s;
  next();
}

const webApp = express();
webApp.use(express.json());
webApp.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

webApp.post('/admin/login', (req, res) => {
  const login = String((req.body || {}).login || '').trim();
  const password = String((req.body || {}).password || '');

  let accountId = null;
  let sessionLogin;
  let isAdmin = false;

  if (login === '') {
    if (password !== ADMIN_PASSWORD) {
      logAuthAttempt(req, null, '401 Mot de passe admin incorrect');
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }
    isAdmin = true;
    sessionLogin = 'admin';
  } else {
    const row = db.prepare('SELECT * FROM accounts WHERE login = ?').get(login);
    if (!row || row.disabled || !verifyPassword(password, row.password_hash)) {
      logAuthAttempt(req, null, `401 Connexion échouée (compte « ${login.slice(0, 32)} »)`);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    accountId = row.id;
    sessionLogin = row.login;
  }

  const sid = newToken();
  sessions.set(sid, { exp: Date.now() + SESSION_TTL_MS, accountId, login: sessionLogin, isAdmin });
  res.setHeader(
    'Set-Cookie',
    `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  res.json({ ok: true, login: sessionLogin, isAdmin });
});

webApp.get('/admin/api/session', requireSession, (req, res) => {
  res.json({ login: req.session.login, isAdmin: req.session.isAdmin, version: APP_VERSION });
});

webApp.post('/admin/logout', (req, res) => {
  sessions.delete(parseCookies(req).sid);
  res.json({ ok: true });
});

const sendFile = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

apiApp.get('/docs', sendFile('docs.html'));
apiApp.get('/openapi.json', sendFile('openapi.json'));
webApp.get('/docs', sendFile('docs.html'));
webApp.get('/openapi.json', sendFile('openapi.json'));

webApp.get('/login.html', sendFile('login.html'));
webApp.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
webApp.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));

webApp.get(['/', '/index.html'], (req, res) => {
  if (!sessionValid(req)) return res.redirect('/login.html');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- API d'administration (protégée par session) ----------
webApp.use('/admin/api', requireSession);

webApp.get('/admin/api/keys', (_req, res) => {
  const keys = db.prepare(
    `SELECT id, label, type, device_id, created_at, expires_at, revoked, last_used_at, last_seen_at
     FROM keys ORDER BY id DESC`
  ).all();
  res.json(keys.map((k) => ({ ...k, expired: isExpired(k) })));
});

webApp.post('/admin/api/keys', (req, res) => {
  const label = String(req.body.label || '').trim();
  const type = String(req.body.type || '');
  const rawDays = req.body.days;
  const days = rawDays === undefined || rawDays === null || rawDays === ''
    ? null
    : parseInt(rawDays, 10);
  if (!label) return res.status(400).json({ error: 'Libellé requis' });
  if (!['web', 'gateway'].includes(type)) return res.status(400).json({ error: 'Type invalide' });
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    return res.status(400).json({ error: 'Validité invalide (1 à 3650 jours, ou laisser vide)' });
  }
  const token = newToken();
  const expiresAt = days === null
    ? null
    : new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  const info = db.prepare(
    'INSERT INTO keys (label, type, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(label, type, sha256(token), isoNow(), expiresAt);
  res.status(201).json({
    key: {
      id: info.lastInsertRowid,
      label,
      type,
      created_at: isoNow(),
      expires_at: expiresAt,
      revoked: 0
    },
    token
  });
});

webApp.post('/admin/api/keys/:id/revoke', (req, res) => {
  const info = db.prepare('UPDATE keys SET revoked = 1 WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Clé introuvable' });
  res.json({ ok: true });
});

webApp.delete('/admin/api/keys/:id', (req, res) => {
  const info = db.prepare('DELETE FROM keys WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Clé introuvable' });
  res.json({ ok: true });
});

webApp.get('/admin/api/gateways', (_req, res) => {
  const gateways = db.prepare(`
    SELECT
      k.id, k.label, k.device_id, k.last_seen_at, k.last_used_at,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id) AS claimed,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'sending')  AS sending,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'sent')      AS sent,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'delivered') AS delivered,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'failed')    AS failed
    FROM keys k
    WHERE k.type = 'gateway'
    ORDER BY k.last_seen_at DESC
  `).all();
  res.json(gateways);
});

webApp.get('/admin/api/messages/export', (req, res) => {
  const status = String(req.query.status || '');
  const base = `
    SELECT m.*, k.label AS gateway_label, k.device_id AS device_id
    FROM messages m LEFT JOIN keys k ON k.id = m.claimed_by
  `;
  const rows = status
    ? db.prepare(`${base} WHERE m.status = ? ORDER BY m.id ASC`).all(status)
    : db.prepare(`${base} ORDER BY m.id ASC`).all();
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const statusLabel = {
    pending: 'en attente', sending: 'en cours', sent: 'envoyé', delivered: 'remis', failed: 'échec'
  };
  const header = ['ID', 'Date', 'Destinataire', 'Message', 'Statut', 'Envoyé le', 'Remis le', 'Échec le', 'Passerelle', 'Appareil', 'Erreur'];
  const lines = rows.map((m) => [
    m.id,
    m.created_at,
    m.recipient,
    m.body,
    statusLabel[m.status] || m.status,
    m.sent_at,
    m.delivered_at,
    m.failed_at,
    m.gateway_label,
    m.device_id,
    m.error
  ].map(esc).join(';'));
  const csv = '\uFEFF' + header.join(';') + '\r\n' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="messages_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

webApp.get('/admin/api/messages', (req, res) => {
  const status = String(req.query.status || '');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const base = `
    SELECT m.*, k.label AS gateway_label, k.device_id AS device_id
    FROM messages m LEFT JOIN keys k ON k.id = m.claimed_by
  `;
  const rows = status
    ? db.prepare(`${base} WHERE m.status = ? ORDER BY m.id DESC LIMIT ?`).all(status, limit)
    : db.prepare(`${base} ORDER BY m.id DESC LIMIT ?`).all(limit);
  res.json(rows);
});

webApp.post('/admin/api/messages', (req, res) => {
  const recipient = String(req.body.recipient || '').trim();
  const message = String(req.body.message || '').trim();
  if (!/^\+?[0-9]{4,15}$/.test(recipient)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (message.length === 0) return res.status(400).json({ error: 'Message vide' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message trop long (max ${MAX_MESSAGE_LENGTH} caractères)` });
  }
  const createdAt = isoNow();
  const info = db.prepare(
    'INSERT INTO messages (recipient, body, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(recipient, message, 'pending', createdAt);
  res.status(201).json({
    id: info.lastInsertRowid,
    recipient,
    message,
    status: 'pending',
    createdAt
  });
});

webApp.post('/admin/api/messages/import', (req, res) => {
  const input = Array.isArray(req.body.messages) ? req.body.messages : [];
  const MAX_IMPORT = 5000;
  if (input.length === 0) return res.status(400).json({ error: 'Aucune ligne à importer' });
  if (input.length > MAX_IMPORT) return res.status(400).json({ error: `Trop de lignes (max ${MAX_IMPORT})` });

  const seen = new Set();
  const invalid = [];
  const toInsert = [];
  let duplicates = 0;

  for (const raw of input) {
    const recipient = String((raw && raw.recipient) || '').trim();
    const message = String((raw && raw.message) || '').trim();
    const errs = [];
    if (!/^\+?[0-9]{4,15}$/.test(recipient)) errs.push('Numéro invalide');
    if (message.length === 0) errs.push('Message vide');
    else if (message.length > MAX_MESSAGE_LENGTH) errs.push(`Message trop long (max ${MAX_MESSAGE_LENGTH})`);
    if (errs.length) {
      invalid.push({ recipient, message, error: errs.join(', ') });
      continue;
    }
    const key = recipient + '\u0001' + message;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    toInsert.push([recipient, message]);
  }
  const createdAt = isoNow();
  const insert = db.prepare(
    'INSERT INTO messages (recipient, body, status, created_at) VALUES (?, ?, ?, ?)'
  );
  let created = 0;
  if (toInsert.length) {
    db.exec('BEGIN');
    try {
      for (const [recipient, message] of toInsert) {
        insert.run(recipient, message, 'pending', createdAt);
        created++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  res.status(201).json({ rows: input.length, duplicates, invalid, created });
});

webApp.get('/admin/api/logs', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT l.id, l.key_id, l.device_id, l.reports, l.claimed, l.created_at, k.label AS gateway_label
    FROM gateway_logs l LEFT JOIN keys k ON k.id = l.key_id
    ORDER BY l.id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

webApp.get('/admin/api/auth-logs', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT a.id, a.key_id, a.ip, a.reason, a.created_at, k.label AS gateway_label
    FROM auth_logs a LEFT JOIN keys k ON k.id = a.key_id
    ORDER BY a.id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

// ---------- Gestion des comptes (protégée par session) ----------
const accountFields = 'id, login, disabled, created_at';

webApp.get('/admin/api/accounts', (_req, res) => {
  const rows = db.prepare(
    `SELECT ${accountFields} FROM accounts ORDER BY id ASC`
  ).all();
  res.json(rows);
});

webApp.post('/admin/api/accounts', (req, res) => {
  const login = String((req.body || {}).login || '').trim();
  const password = String((req.body || {}).password || '');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(login)) {
    return res.status(400).json({ error: 'Identifiant invalide (3 à 32 caractères : lettres, chiffres, . _ -)' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Mot de passe trop court (${PASSWORD_MIN_LENGTH} caractères minimum)` });
  }
  if (db.prepare('SELECT 1 FROM accounts WHERE login = ?').get(login)) {
    return res.status(409).json({ error: 'Cet identifiant existe déjà' });
  }
  const info = db.prepare(
    'INSERT INTO accounts (login, password_hash, disabled, created_at) VALUES (?, ?, 0, ?)'
  ).run(login, hashPassword(password), isoNow());
  res.status(201).json({ id: info.lastInsertRowid, login, disabled: 0, created_at: isoNow() });
});

webApp.post('/admin/api/accounts/:id/password', (req, res) => {
  const password = String((req.body || {}).password || '');
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Mot de passe trop court (${PASSWORD_MIN_LENGTH} caractères minimum)` });
  }
  const info = db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?')
    .run(hashPassword(password), Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Compte introuvable' });
  res.json({ ok: true });
});

webApp.post('/admin/api/accounts/:id/disable', (req, res) => {
  const id = Number(req.params.id);
  if (req.session.accountId === id) {
    return res.status(400).json({ error: 'Impossible de désactiver le compte avec lequel vous êtes connecté' });
  }
  const disabled = (req.body || {}).disabled ? 1 : 0;
  const info = db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(disabled, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Compte introuvable' });
  res.json({ ok: true });
});

webApp.delete('/admin/api/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (req.session.accountId === id) {
    return res.status(400).json({ error: 'Impossible de supprimer le compte avec lequel vous êtes connecté' });
  }
  const info = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Compte introuvable' });
  res.json({ ok: true });
});

webApp.get('/admin/api/stats', (_req, res) => {
  const byStatus = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM messages GROUP BY status').all()) {
    byStatus[r.status] = r.c;
  }
  const byKeyType = {};
  for (const r of db.prepare('SELECT type, COUNT(*) AS c FROM keys GROUP BY type').all()) {
    byKeyType[r.type] = r.c;
  }
  const online = db.prepare(
    "SELECT COUNT(*) AS c FROM keys WHERE type = 'gateway' AND last_seen_at > ?"
  ).get(new Date(Date.now() - 3 * 60 * 1000).toISOString()).c;
  res.json({ messages: byStatus, keys: byKeyType, gatewaysOnline: online });
});

apiApp.listen(PORT_API, '0.0.0.0', () => {
  console.log(`[api] écoute sur le port ${PORT_API}`);
});
webApp.listen(PORT_WEB, '0.0.0.0', () => {
  console.log(`[web] interface sur le port ${PORT_WEB}`);
});
