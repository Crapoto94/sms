'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('./db');

const PORT_API = parseInt(process.env.PORT_API || '3250', 10);
const PORT_WEB = parseInt(process.env.PORT_WEB || '3251', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SENDING_STALE_MS = 10 * 60 * 1000;
const CLAIM_LIMIT = 25;
const MAX_MESSAGE_LENGTH = 160;
const PUBLIC_DIR = path.join(__dirname, 'public');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const isoNow = () => new Date().toISOString();
const isExpired = (row) => !!row.expires_at && Date.parse(row.expires_at) < Date.now();

// ---------- Sessions de l'interface web ----------
const sessions = new Map(); // sid -> expiration (timestamp ms)

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- Authentification par clé API ----------
function getBearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : null;
}

function requireApiKey(type) {
  return (req, res, next) => {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Clé API manquante' });
    const row = db.prepare('SELECT * FROM keys WHERE token_hash = ?').get(sha256(token));
    if (!row) return res.status(401).json({ error: 'Clé API invalide' });
    if (row.revoked) return res.status(403).json({ error: 'Clé révoquée' });
    if (row.type !== type) return res.status(403).json({ error: 'Type de clé inadapté' });
    if (isExpired(row)) return res.status(403).json({ error: 'Clé expirée' });
    db.prepare('UPDATE keys SET last_used_at = ? WHERE id = ?').run(isoNow(), row.id);
    req.apiKey = row;
    next();
  };
}

// ---------- API publique (port 3250) ----------
const apiApp = express();
apiApp.use(express.json());

apiApp.get('/health', (_req, res) => res.json({ ok: true }));

// Envoi d'un SMS demandé par une application web (clé type "web")
apiApp.post('/api/v1/messages', requireApiKey('web'), (req, res) => {
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

    const cutoff = new Date(now.getTime() - SENDING_STALE_MS).toISOString();
    const pending = db.prepare(
      "SELECT * FROM messages WHERE status = 'pending' ORDER BY id ASC LIMIT ?"
    ).all(CLAIM_LIMIT);
    const stale = db.prepare(
      "SELECT * FROM messages WHERE status = 'sending' AND claimed_at < ? ORDER BY id ASC LIMIT ?"
    ).all(cutoff, CLAIM_LIMIT);
    const toClaim = pending.concat(stale).slice(0, CLAIM_LIMIT);

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
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({
    serverTime: nowIso,
    intervalSec: 60,
    reportsAccepted: reportAccepted,
    messages: claimed.map((m) => ({ id: m.id, recipient: m.recipient, body: m.body }))
  });
});

// ---------- Interface web (port 3251) ----------
function requireSession(req, res, next) {
  const sid = parseCookies(req).sid;
  const exp = sessions.get(sid);
  if (!exp || exp < Date.now()) {
    sessions.delete(sid);
    return res.status(401).json({ error: 'Authentification requise' });
  }
  next();
}

const webApp = express();
webApp.use(express.json());
webApp.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

webApp.post('/admin/login', (req, res) => {
  if (String((req.body || {}).password || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  const sid = newToken();
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  res.setHeader(
    'Set-Cookie',
    `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  res.json({ ok: true });
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
  const sid = parseCookies(req).sid;
  const exp = sessions.get(sid);
  if (!exp || exp < Date.now()) return res.redirect('/login.html');
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
