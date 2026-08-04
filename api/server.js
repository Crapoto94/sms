'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./db');

const PORT_API = parseInt(process.env.PORT_API || '3250', 10);
const PORT_WEB = parseInt(process.env.PORT_WEB || '3251', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const APP_VERSION = process.env.APP_VERSION || '1.32';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SENDING_STALE_MS = 10 * 60 * 1000;
const CLAIM_LIMIT = 25;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const DEFAULT_ATTACHMENT_EXPIRY_DAYS = 90;
const ATTACHMENT_EXPIRY_OPTIONS = [0, 7, 30, 90, 180, 365];
// Répartition de charge entre passerelles :
//  - intervalle conseillé aux passerelles (renvoyé dans /sync)
//  - passerelle « active » = synchronisée il y a moins de 2 intervalles
//  - message en attente depuis >= 1 intervalle = prenable par le premier venu
const SYNC_INTERVAL_SEC = parseInt(process.env.SYNC_INTERVAL_SEC || '60', 10);
const ESCALATION_MS = parseInt(process.env.ESCALATION_SEC || String(SYNC_INTERVAL_SEC), 10) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// Une passerelle est « en ligne » si elle s'est synchronisée il y a moins de
// OFFLINE_WINDOW_MS. Au démarrage du serveur, une grâce de STARTUP_GRACE_MS
// est accordée : les passerelles synchronisées peu avant un redémarrage ne
// sont pas marquées hors ligne pendant qu'elles se resynchronisent. Cette
// grâce est bornée et redevient la fenêtre normale une fois dépassée.
const SERVER_STARTED_AT = Date.now();
const OFFLINE_WINDOW_MS = parseInt(process.env.OFFLINE_WINDOW_SEC || '180', 10) * 1000;
const STARTUP_GRACE_MS = parseInt(process.env.STARTUP_GRACE_SEC || '120', 10) * 1000;
const onlineCutoffIso = () => new Date(Math.max(
  Date.now() - OFFLINE_WINDOW_MS,
  SERVER_STARTED_AT - STARTUP_GRACE_MS
)).toISOString();

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const isoNow = () => new Date().toISOString();
const isExpired = (row) => !!row.expires_at && Date.parse(row.expires_at) < Date.now();

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: ATTACHMENTS_DIR,
    filename: (_req, _file, cb) => cb(null, newToken())
  }),
  limits: { fileSize: MAX_ATTACHMENT_SIZE }
});

function publicAttachmentUrl(req, token) {
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.hostname}:${PORT_API}`).replace(/\/$/, '');
  return `${base}/api/v1/attachments/${encodeURIComponent(token)}`;
}

function readableFilename(name) {
  const value = String(name || 'piece-jointe');
  if (!/[ÃÂâ]/.test(value)) return value;
  try {
    return decodeURIComponent(Array.from(value)
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join(''));
  } catch (_) {
    return value;
  }
}

function attachmentExpiry(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || !ATTACHMENT_EXPIRY_OPTIONS.includes(days)) {
    return { error: 'Durée de conservation invalide' };
  }
  return { days, expiresAt: days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString() };
}

function deviceType(userAgent) {
  const ua = String(userAgent || '');
  if (/iPad|Tablet/i.test(ua)) return 'iPad / tablette';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Autre';
}

function attachmentDispositionName(name) {
  return encodeURIComponent(readableFilename(name));
}

function findAttachment(req, attachmentId, owner) {
  const id = Number(attachmentId);
  if (!Number.isInteger(id) || id < 1) return { error: 'Pièce jointe invalide' };
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!attachment) return { error: 'Pièce jointe introuvable' };
  if (owner && owner.keyId != null && attachment.owner_key_id !== owner.keyId) {
    return { error: 'Pièce jointe non autorisée' };
  }
  if (owner && owner.accountId != null && attachment.owner_account_id !== owner.accountId) {
    return { error: 'Pièce jointe non autorisée' };
  }
  return { attachment };
}

function messageBodyWithAttachment(req, body, attachmentId, owner) {
  const checked = attachmentId ? findAttachment(req, attachmentId, owner) : { attachment: null };
  if (checked.error) return checked;
  if (!checked.attachment) return { body };
  const suffix = `\n\nPièce jointe : ${publicAttachmentUrl(req, checked.attachment.token)}`;
  const fullBody = body + suffix;
  if (fullBody.length > MAX_MESSAGE_LENGTH) {
    return { error: `Message trop long avec le lien de la pièce jointe (max ${MAX_MESSAGE_LENGTH} caractères)` };
  }
  return { body: fullBody, attachment: checked.attachment };
}

function normalizeIncomingDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) {
    const date = new Date(Number(text));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? isoNow() : new Date(parsed).toISOString();
}

// Envoi différé : si une heure est fournie (ISO ou heure locale), le message
// reste "scheduled" (Programmé) jusqu'à cette heure, puis passe en "pending"
// et est récupéré par les passerelles.
function scheduleInfo(scheduledAt) {
  if (!scheduledAt) return null;
  const t = Date.parse(String(scheduledAt));
  if (Number.isNaN(t)) return { error: 'Heure d’envoi invalide' };
  return { scheduledAt: new Date(t).toISOString() };
}

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

// Normalisation d'un numéro de téléphone français :
//  - suppression des séparateurs (espaces, points, tirets, parenthèses, _)
//  - "+33XXXXXXXXX" / "0033XXXXXXXXX" / "33XXXXXXXXX" -> "0XXXXXXXXX"
//  - numéro à 9 chiffres sans 0 initial -> "0" + numéro
const PHONE_RE = /^\+?[0-9]{4,15}$/;

function normalizePhone(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+33')) s = '0' + s.slice(3);
  else if (s.startsWith('0033')) s = '0' + s.slice(4);
  else if (s.startsWith('33') && s.length === 11) s = '0' + s.slice(2);
  if (!s.startsWith('+') && !s.startsWith('0') && s.length === 9) s = '0' + s;
  return s;
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
const sessions = new Map(); // sid -> { exp, accountId|null, login, role, groupId|null, isAdmin }

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

apiApp.get('/api/v1/attachments/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return res.status(404).end();
  const attachment = db.prepare('SELECT * FROM attachments WHERE token = ?').get(token);
  if (!attachment) return res.status(404).end();
  if (attachment.expires_at && Date.parse(attachment.expires_at) <= Date.now()) return res.status(410).end();
  const filePath = path.join(ATTACHMENTS_DIR, attachment.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const openedAt = isoNow();
  db.prepare(`
    INSERT INTO attachment_opens
      (attachment_id, opened_at, ip, user_agent, device_type, referer, accept_language)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    attachment.id,
    openedAt,
    req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
    req.headers['user-agent'] || '',
    deviceType(req.headers['user-agent']),
    req.headers.referer || '',
    req.headers['accept-language'] || ''
  );
  db.prepare('UPDATE attachments SET opened_at = ?, open_count = open_count + 1 WHERE id = ?')
    .run(openedAt, attachment.id);
  res.type(attachment.mime_type || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${attachmentDispositionName(attachment.original_name)}`
  );
  res.sendFile(filePath);
});

function uploadSingle(req, res, next) {
  attachmentUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Pièce jointe trop volumineuse (max 10 Mo)' });
    }
    return res.status(400).json({ error: 'Upload de la pièce jointe impossible' });
  });
}

apiApp.post('/api/v1/attachments', requireApiKey('web'), rateLimit, uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant (champ « file »)' });
  const expiry = attachmentExpiry(
    req.body.expiresInDays === undefined ? DEFAULT_ATTACHMENT_EXPIRY_DAYS : req.body.expiresInDays
  );
  if (expiry.error) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: expiry.error });
  }
  const createdAt = isoNow();
  try {
    const info = db.prepare(`
      INSERT INTO attachments
        (token, original_name, stored_name, mime_type, size, owner_key_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.file.filename,
      readableFilename(req.file.originalname || 'piece-jointe'),
      req.file.filename,
      req.file.mimetype || 'application/octet-stream',
      req.file.size,
      req.apiKey.id,
      createdAt,
      expiry.expiresAt
    );
    res.status(201).json({
      id: info.lastInsertRowid,
      name: readableFilename(req.file.originalname || 'piece-jointe'),
      mimeType: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      url: publicAttachmentUrl(req, req.file.filename),
      expiresAt: expiry.expiresAt
    });
  } catch (err) {
    fs.rmSync(req.file.path, { force: true });
    throw err;
  }
});

// Envoi d'un SMS demandé par une application web (clé type "web")
apiApp.post('/api/v1/messages', requireApiKey('web'), rateLimit, (req, res) => {
  const recipient = String(req.body.recipient || '').trim();
  const message = String(req.body.message || '').trim();
  const withAttachment = messageBodyWithAttachment(
    req, message, req.body.attachmentId, { keyId: req.apiKey.id }
  );
  if (!/^\+?[0-9]{4,15}$/.test(recipient)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (message.length === 0) return res.status(400).json({ error: 'Message vide' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message trop long (max ${MAX_MESSAGE_LENGTH} caractères)` });
  }
  if (withAttachment.error) return res.status(400).json({ error: withAttachment.error });
  const createdAt = isoNow();
  const info = db.prepare(
    'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(recipient, withAttachment.body, 'pending', 'web', req.apiKey.label, withAttachment.attachment ? withAttachment.attachment.id : null, createdAt);
  res.status(201).json({
    id: info.lastInsertRowid,
    recipient,
    message: withAttachment.body,
    status: 'pending',
    createdAt,
    attachment: withAttachment.attachment
      ? { id: withAttachment.attachment.id, name: withAttachment.attachment.original_name, url: publicAttachmentUrl(req, withAttachment.attachment.token) }
      : null
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
    WHERE id = ? AND status <> 'cancelled'
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

    const activeCutoff = onlineCutoffIso();
    let activeCount = db.prepare(
      "SELECT COUNT(*) AS c FROM keys WHERE type = 'gateway' AND last_seen_at > ?"
    ).get(activeCutoff).c;
    const selfFresh = req.apiKey.last_seen_at &&
      Date.parse(req.apiKey.last_seen_at) >= Date.parse(activeCutoff);
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

// Remontée des SMS reçus par une passerelle (clé type "gateway")
apiApp.post('/api/v1/gateway/incoming', requireApiKey('gateway'), (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (messages.length === 0) return res.json({ accepted: 0 });
  const deviceId = String(req.body.deviceId || req.apiKey.device_id || '').trim();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO incoming_messages
       (key_id, device_id, provider_id, sender, body, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const nowIso = isoNow();
  let accepted = 0;
  db.exec('BEGIN');
  try {
    for (const m of messages) {
      const providerId = String(m.providerId || m.id || '').trim();
      const sender = String(m.sender || '').trim();
      const body = String(m.body || '').trim();
      const receivedAt = normalizeIncomingDate(m.receivedAt || nowIso);
      if (!providerId || !sender) continue;
      const info = insert.run(req.apiKey.id, deviceId, providerId, sender, body, receivedAt, nowIso);
      if (info.changes > 0) accepted++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ accepted });
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

function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé à l’administrateur' });
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
  const login = String((req.body || {}).login || '').trim();
  const password = String((req.body || {}).password || '');

  let accountId = null;
  let sessionLogin;
  let role = 'user';
  let groupId = null;

  if (login === '') {
    if (password !== ADMIN_PASSWORD) {
      logAuthAttempt(req, null, '401 Mot de passe admin incorrect');
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }
    role = 'admin';
    sessionLogin = 'admin';
  } else {
    const row = db.prepare('SELECT * FROM accounts WHERE login = ?').get(login);
    if (!row || row.disabled || !verifyPassword(password, row.password_hash)) {
      logAuthAttempt(req, null, `401 Connexion échouée (compte « ${login.slice(0, 32)} »)`);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    accountId = row.id;
    sessionLogin = row.login;
    role = row.role === 'admin' ? 'admin' : 'user';
    groupId = row.group_id || null;
  }

  const sid = newToken();
  sessions.set(sid, {
    exp: Date.now() + SESSION_TTL_MS,
    accountId,
    login: sessionLogin,
    role,
    groupId,
    isAdmin: role === 'admin'
  });
  res.setHeader(
    'Set-Cookie',
    `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  res.json({ ok: true, login: sessionLogin, isAdmin: role === 'admin', role, groupId });
});

webApp.get('/admin/api/session', requireSession, (req, res) => {
  const g = req.session.groupId
    ? db.prepare('SELECT name FROM groups WHERE id = ?').get(req.session.groupId)
    : null;
  res.json({
    login: req.session.login,
    isAdmin: req.session.isAdmin,
    role: req.session.role,
    groupId: req.session.groupId,
    groupName: g ? g.name : null,
    version: APP_VERSION
  });
});

webApp.post('/admin/logout', (req, res) => {
  sessions.delete(parseCookies(req).sid);
  res.json({ ok: true });
});

const sendFile = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

// Injecte la version dans le HTML (fichiers et URLs d'assets suffixés
// par "?v=…" pour casser le cache navigateur/proxy à chaque release).
const renderHtml = (name) => (_req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8')
    .replace(/__APP_VERSION__/g, APP_VERSION);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
};

apiApp.get('/docs', sendFile('docs.html'));
apiApp.get('/openapi.json', sendFile('openapi.json'));
webApp.get('/docs', sendFile('docs.html'));
webApp.get('/openapi.json', sendFile('openapi.json'));

webApp.get('/login.html', renderHtml('login.html'));
webApp.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
webApp.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));

webApp.get(['/', '/index.html'], (req, res) => {
  const s = sessionValid(req);
  if (!s) return res.redirect('/login.html');
  if (s.role !== 'admin') return res.redirect('/send.html');
  renderHtml('index.html')(req, res);
});

webApp.get('/send.html', (req, res) => {
  const s = sessionValid(req);
  if (!s) return res.redirect('/login.html');
  if (s.role === 'admin') return res.redirect('/');
  renderHtml('send.html')(req, res);
});

// ---------- API d'administration (protégée par session) ----------
webApp.use('/admin/api', requireSession);

webApp.post('/admin/api/attachments', uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant (champ « file »)' });
  const expiry = attachmentExpiry(
    req.body.expiresInDays === undefined ? DEFAULT_ATTACHMENT_EXPIRY_DAYS : req.body.expiresInDays
  );
  if (expiry.error) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: expiry.error });
  }
  const createdAt = isoNow();
  try {
    const info = db.prepare(`
      INSERT INTO attachments
        (token, original_name, stored_name, mime_type, size, owner_account_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.file.filename,
      readableFilename(req.file.originalname || 'piece-jointe'),
      req.file.filename,
      req.file.mimetype || 'application/octet-stream',
      req.file.size,
      req.session.accountId,
      createdAt,
      expiry.expiresAt
    );
    res.status(201).json({
      id: info.lastInsertRowid,
      name: readableFilename(req.file.originalname || 'piece-jointe'),
      mimeType: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      url: publicAttachmentUrl(req, req.file.filename),
      expiresAt: expiry.expiresAt
    });
  } catch (err) {
    fs.rmSync(req.file.path, { force: true });
    throw err;
  }
});

function attachmentForSession(req, id) {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
  if (!attachment) return null;
  if (req.session.role !== 'admin' && attachment.owner_account_id !== req.session.accountId) return null;
  return attachment;
}

webApp.get('/admin/api/attachments/:id/preview', (req, res) => {
  const attachment = attachmentForSession(req, req.params.id);
  if (!attachment) return res.status(404).end();
  if (attachment.expires_at && Date.parse(attachment.expires_at) <= Date.now()) return res.status(410).end();
  const filePath = path.join(ATTACHMENTS_DIR, attachment.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.type(attachment.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${attachmentDispositionName(attachment.original_name)}`);
  res.sendFile(filePath);
});

webApp.get('/admin/api/attachments/:id/opens', (req, res) => {
  const attachment = attachmentForSession(req, req.params.id);
  if (!attachment) return res.status(404).json({ error: 'Pièce jointe introuvable' });
  const opens = db.prepare(`
    SELECT opened_at, ip, user_agent, device_type, referer, accept_language
    FROM attachment_opens WHERE attachment_id = ? ORDER BY opened_at DESC LIMIT 100
  `).all(attachment.id);
  res.json({
    id: attachment.id,
    name: readableFilename(attachment.original_name),
    expiresAt: attachment.expires_at,
    openCount: attachment.open_count,
    openedAt: attachment.opened_at,
    opens
  });
});

webApp.get('/admin/api/keys', requireAdmin, (_req, res) => {
  const keys = db.prepare(
    `SELECT id, label, type, device_id, created_at, expires_at, revoked, last_used_at, last_seen_at
     FROM keys ORDER BY id DESC`
  ).all();
  res.json(keys.map((k) => ({ ...k, expired: isExpired(k) })));
});

webApp.post('/admin/api/keys', requireAdmin, (req, res) => {
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

webApp.post('/admin/api/keys/:id/revoke', requireAdmin, (req, res) => {
  const info = db.prepare('UPDATE keys SET revoked = 1 WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Clé introuvable' });
  res.json({ ok: true });
});

webApp.delete('/admin/api/keys/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM keys WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Clé introuvable' });
  res.json({ ok: true });
});

webApp.get('/admin/api/gateways', requireAdmin, (_req, res) => {
  const cutoff = onlineCutoffIso();
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
  `).all().map((g) => ({ ...g, online: !!(g.last_seen_at && g.last_seen_at > cutoff) }));
  res.json(gateways);
});

webApp.get('/admin/api/messages/export', requireAdmin, (req, res) => {
  const status = String(req.query.status || '');
  const base = `
     SELECT m.*, k.label AS gateway_label, k.device_id AS device_id, g.name AS group_name,
       a.original_name AS attachment_name, a.opened_at AS attachment_opened_at, a.open_count AS attachment_open_count
     FROM messages m LEFT JOIN keys k ON k.id = m.claimed_by
     LEFT JOIN attachments a ON a.id = m.attachment_id
     LEFT JOIN groups g ON g.id = m.group_id
  `;
  const rows = status
    ? db.prepare(`${base} WHERE m.status = ? ORDER BY m.id ASC`).all(status)
    : db.prepare(`${base} ORDER BY m.id ASC`).all();
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const statusLabel = {
    scheduled: 'programmé', pending: 'en attente', sending: 'en cours', sent: 'envoyé', delivered: 'remis', failed: 'échec', cancelled: 'annulé'
  };
  const header = ['ID', 'Date', 'Origine', 'Destinataire', 'Message', 'Statut', 'Envoyé le', 'Remis le', 'Échec le', 'Passerelle', 'Appareil', 'Pièce jointe', 'Ouvertures', 'Erreur'];
  const lines = rows.map((m) => [
    m.id,
    m.created_at,
    m.origin === 'web' ? `API WEB${m.origin_label ? ` (${m.origin_label})` : ''}` : (m.origin_label || m.origin || 'Console'),
    m.recipient,
    m.body,
    statusLabel[m.status] || m.status,
    m.sent_at,
    m.delivered_at,
    m.failed_at,
    m.gateway_label,
    m.device_id,
    m.attachment_name,
    m.attachment_open_count || 0,
    m.error
  ].map(esc).join(';'));
  const csv = '\uFEFF' + header.join(';') + '\r\n' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="messages_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

webApp.get('/admin/api/messages', (req, res) => {
  const status = String(req.query.status || '');
  const recipient = String(req.query.recipient || '').trim();
  const bookId = parseInt(req.query.bookId, 10);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const base = `
    SELECT m.*, k.label AS gateway_label, k.device_id AS device_id, g.name AS group_name,
      c.address_book_id AS campaign_book_id, ab.name AS campaign_book_name,
      a.original_name AS attachment_name, a.opened_at AS attachment_opened_at, a.open_count AS attachment_open_count
    FROM messages m
    LEFT JOIN keys k ON k.id = m.claimed_by
    LEFT JOIN attachments a ON a.id = m.attachment_id
    LEFT JOIN groups g ON g.id = m.group_id
    LEFT JOIN campaigns c ON c.id = m.campaign_id
    LEFT JOIN address_books ab ON ab.id = c.address_book_id
  `;
  const cond = [];
  const params = [];
  if (status) {
    cond.push('m.status = ?');
    params.push(status);
  }
  if (recipient) {
    cond.push('m.recipient = ?');
    params.push(recipient);
  }
  if (Number.isInteger(bookId)) {
    cond.push('m.campaign_id IN (SELECT id FROM campaigns WHERE address_book_id = ?)');
    params.push(bookId);
  }
  if (req.session.role !== 'admin') {
    cond.push('m.group_id = ?');
    params.push(req.session.groupId);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const rows = db.prepare(`${base} ${where} ORDER BY m.id DESC LIMIT ?`)
    .all(...params, limit);
  res.json(rows);
});

// Comptage de SMS envoyés (par numéro et/ou par carnet). Scindé en deux
// routes pour rester sous les chemins de /messages/:id :
webApp.get('/admin/api/messages/count', (req, res) => {
  const recipient = String(req.query.recipient || '').trim();
  const bookId = parseInt(req.query.bookId, 10);
  const cond = [];
  const params = [];
  if (recipient) {
    cond.push('recipient = ?');
    params.push(recipient);
  }
  if (Number.isInteger(bookId)) {
    cond.push('campaign_id IN (SELECT id FROM campaigns WHERE address_book_id = ?)');
    params.push(bookId);
  }
  if (req.session.role !== 'admin') {
    cond.push('group_id = ?');
    params.push(req.session.groupId);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(*) AS c FROM messages ${where}`).get(...params);
  res.json({ count: row.c });
});

// Comptage groupé par numéro (pour afficher la pastille sur chaque contact).
webApp.get('/admin/api/messages/counts', (req, res) => {
  const recipients = String(req.query.recipients || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return res.json({ counts: {} });
  const cond = [`recipient IN (${recipients.map(() => '?').join(',')})`];
  const params = [...recipients];
  if (req.session.role !== 'admin') {
    cond.push('group_id = ?');
    params.push(req.session.groupId);
  }
  const rows = db.prepare(
    `SELECT recipient, COUNT(*) AS c FROM messages WHERE ${cond.join(' AND ')} GROUP BY recipient`
  ).all(...params);
  const counts = {};
  for (const r of rows) counts[r.recipient] = r.c;
  res.json({ counts });
});

webApp.post('/admin/api/messages', (req, res) => {
  const recipient = String(req.body.recipient || '').trim();
  const message = String(req.body.message || '').trim();
  const withAttachment = messageBodyWithAttachment(
    req,
    message,
    req.body.attachmentId,
    req.session.role === 'admin' ? null : { accountId: req.session.accountId }
  );
  if (!/^\+?[0-9]{4,15}$/.test(recipient)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (message.length === 0) return res.status(400).json({ error: 'Message vide' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message trop long (max ${MAX_MESSAGE_LENGTH} caractères)` });
  }
  if (withAttachment.error) return res.status(400).json({ error: withAttachment.error });
  const groupId = req.session.role === 'admin' ? (Number(req.body.groupId) || null) : req.session.groupId;
  const sched = scheduleInfo(req.body.scheduledAt);
  if (sched && sched.error) return res.status(400).json({ error: sched.error });
  const status = sched ? 'scheduled' : 'pending';
  const scheduledAt = sched ? sched.scheduledAt : null;
  const createdAt = isoNow();
  const info = db.prepare(
    'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_at, group_id, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(recipient, withAttachment.body, status, 'console', 'Console', withAttachment.attachment ? withAttachment.attachment.id : null, createdAt, groupId, scheduledAt);
  res.status(201).json({
    id: info.lastInsertRowid,
    recipient,
    message: withAttachment.body,
    status,
    createdAt,
    attachment: withAttachment.attachment
      ? { id: withAttachment.attachment.id, name: withAttachment.attachment.original_name, url: publicAttachmentUrl(req, withAttachment.attachment.token) }
      : null
  });
});

webApp.post('/admin/api/messages/import', requireAdmin, (req, res) => {
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
  const groupId = Number(req.body.groupId) || null;
  const createdAt = isoNow();
  const insert = db.prepare(
    'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_at, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let created = 0;
  if (toInsert.length) {
    db.exec('BEGIN');
    try {
      for (const [recipient, message] of toInsert) {
        insert.run(recipient, message, 'pending', 'console', 'Console', null, createdAt, groupId);
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

// Annulation d'un message pas encore envoyé (programmé, en attente, en cours
// ou envoyé mais pas remis). Une fois annulé, le message ne peut plus être
// récupéré par une passerelle ni mis à jour par un rapport.
const CANCELABLE = ['scheduled', 'pending', 'sending', 'sent'];
webApp.post('/admin/api/messages/:id/cancel', (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id));
  if (!message) return res.status(404).json({ error: 'Message introuvable' });
  if (req.session.role !== 'admin' && message.group_id !== req.session.groupId) {
    return res.status(404).json({ error: 'Message introuvable' });
  }
  if (!CANCELABLE.includes(message.status)) {
    return res.status(409).json({ error: 'Ce message ne peut plus être annulé' });
  }
  db.prepare(
    "UPDATE messages SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?"
  ).run(isoNow(), isoNow(), message.id);
  res.json({ ok: true, id: message.id });
});

// Annulation d'une campagne : annule tous ses messages pas encore envoyés.
webApp.post('/admin/api/campaigns/:campaignId/cancel', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(req.params.campaignId));
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  if (req.session.role !== 'admin' && campaign.group_id !== req.session.groupId) {
    return res.status(404).json({ error: 'Campagne introuvable' });
  }
  const now = isoNow();
  const placeholders = CANCELABLE.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE messages SET status = 'cancelled', cancelled_at = ?, updated_at = ?
     WHERE campaign_id = ? AND status IN (${placeholders})`
  ).run(now, now, campaign.id, ...CANCELABLE);
  res.json({ ok: true, campaignId: campaign.id, cancelled: info.changes });
});

webApp.get('/admin/api/logs', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT l.id, l.key_id, l.device_id, l.reports, l.claimed, l.created_at, k.label AS gateway_label
    FROM gateway_logs l LEFT JOIN keys k ON k.id = l.key_id
    ORDER BY l.id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

webApp.get('/admin/api/auth-logs', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT a.id, a.key_id, a.ip, a.reason, a.created_at, k.label AS gateway_label
    FROM auth_logs a LEFT JOIN keys k ON k.id = a.key_id
    ORDER BY a.id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

// ---------- Gestion des comptes (protégée par session) ----------
const accountFields = `
  a.id, a.login, a.role, a.group_id, a.email, a.is_group_manager, a.disabled, a.created_at,
  g.name AS group_name
`;

webApp.get('/admin/api/accounts', requireAdmin, (_req, res) => {
  const rows = db.prepare(
    `SELECT ${accountFields} FROM accounts a LEFT JOIN groups g ON g.id = a.group_id ORDER BY a.id ASC`
  ).all();
  res.json(rows);
});

webApp.post('/admin/api/accounts', requireAdmin, (req, res) => {
  const login = String((req.body || {}).login || '').trim();
  const password = String((req.body || {}).password || '');
  const role = (req.body || {}).role === 'admin' ? 'admin' : 'user';
  const groupId = Number(req.body.groupId) || null;
  const email = String((req.body || {}).email || '').trim() || null;
  const isGroupManager = (req.body || {}).isGroupManager ? 1 : 0;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(login)) {
    return res.status(400).json({ error: 'Identifiant invalide (3 à 32 caractères : lettres, chiffres, . _ -)' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Mot de passe trop court (${PASSWORD_MIN_LENGTH} caractères minimum)` });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse e-mail invalide' });
  }
  if (db.prepare('SELECT 1 FROM accounts WHERE login = ?').get(login)) {
    return res.status(409).json({ error: 'Cet identifiant existe déjà' });
  }
  if (groupId && !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) {
    return res.status(400).json({ error: 'Groupe introuvable' });
  }
  const info = db.prepare(
    'INSERT INTO accounts (login, password_hash, role, group_id, email, is_group_manager, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(login, hashPassword(password), role, groupId, email, isGroupManager, isoNow());
  res.status(201).json({ id: info.lastInsertRowid, login, role, group_id: groupId, email, is_group_manager: isGroupManager, disabled: 0, created_at: isoNow() });
});

webApp.patch('/admin/api/accounts/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Compte introuvable' });

  const sets = [];
  const params = [];
  if (body.role !== undefined) {
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (req.session.accountId === id && role !== 'admin') {
      return res.status(400).json({ error: 'Impossible de retirer le rôle admin de votre propre compte' });
    }
    sets.push('role = ?');
    params.push(role);
  }
  if (body.groupId !== undefined) {
    const groupId = Number(body.groupId) || null;
    if (groupId && !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) {
      return res.status(400).json({ error: 'Groupe introuvable' });
    }
    sets.push('group_id = ?');
    params.push(groupId);
  }
  if (body.email !== undefined) {
    const email = String(body.email || '').trim() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse e-mail invalide' });
    }
    sets.push('email = ?');
    params.push(email);
  }
  if (body.isGroupManager !== undefined) {
    sets.push('is_group_manager = ?');
    params.push(body.isGroupManager ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: 'Aucune modification demandée' });
  params.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  if (req.session.accountId === id && body.groupId !== undefined) {
    req.session.groupId = Number(body.groupId) || null;
  }
  res.json({ ok: true });
});

webApp.post('/admin/api/accounts/:id/password', requireAdmin, (req, res) => {
  const password = String((req.body || {}).password || '');
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Mot de passe trop court (${PASSWORD_MIN_LENGTH} caractères minimum)` });
  }
  const info = db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?')
    .run(hashPassword(password), Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Compte introuvable' });
  res.json({ ok: true });
});

webApp.post('/admin/api/accounts/:id/disable', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.session.accountId === id) {
    return res.status(400).json({ error: 'Impossible de désactiver le compte avec lequel vous êtes connecté' });
  }
  const disabled = (req.body || {}).disabled ? 1 : 0;
  const info = db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(disabled, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Compte introuvable' });
  res.json({ ok: true });
});

webApp.delete('/admin/api/accounts/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.session.accountId === id) {
    return res.status(400).json({ error: 'Impossible de supprimer le compte avec lequel vous êtes connecté' });
  }
  const info = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Compte introuvable' });
  res.json({ ok: true });
});

// ---------- Groupes (admin) ----------
webApp.get('/admin/api/groups', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM accounts a WHERE a.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM accounts a WHERE a.group_id = g.id AND a.is_group_manager = 1) AS manager_count,
      (SELECT GROUP_CONCAT(a.login, ', ') FROM accounts a WHERE a.group_id = g.id AND a.is_group_manager = 1) AS managers,
      (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.id) AS message_count
    FROM groups g ORDER BY g.id ASC
  `).all();
  res.json(rows);
});

webApp.post('/admin/api/groups', requireAdmin, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 2 || name.length > 64) {
    return res.status(400).json({ error: 'Nom de groupe invalide (2 à 64 caractères)' });
  }
  if (db.prepare('SELECT 1 FROM groups WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'Ce nom de groupe existe déjà' });
  }
  const info = db.prepare('INSERT INTO groups (name, created_at) VALUES (?, ?)')
    .run(name, isoNow());
  res.status(201).json({ id: info.lastInsertRowid, name, created_at: isoNow(), member_count: 0, message_count: 0 });
});

webApp.patch('/admin/api/groups/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 2 || name.length > 64) {
    return res.status(400).json({ error: 'Nom de groupe invalide (2 à 64 caractères)' });
  }
  const dup = db.prepare('SELECT 1 FROM groups WHERE name = ? AND id <> ?').get(name, id);
  if (dup) return res.status(409).json({ error: 'Ce nom de groupe existe déjà' });
  const info = db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Groupe introuvable' });
  res.json({ ok: true });
});

webApp.delete('/admin/api/groups/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Groupe introuvable' });
  db.prepare('UPDATE accounts SET group_id = NULL WHERE group_id = ?').run(id);
  db.prepare('UPDATE messages SET group_id = NULL WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM contacts WHERE address_book_id IN (SELECT id FROM address_books WHERE group_id = ?)').run(id);
  db.prepare('DELETE FROM address_books WHERE group_id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Carnets d'adresses & contacts (groupes) ----------
function requireGroupBook(req, res) {
  const bookId = Number(req.params.bookId);
  const book = db.prepare('SELECT * FROM address_books WHERE id = ?').get(bookId);
  if (!book) return { error: 'Carnet introuvable' };
  if (req.session.role !== 'admin' && book.group_id !== req.session.groupId) {
    return { error: 'Carnet introuvable' };
  }
  return { book };
}

webApp.get('/admin/api/address-books', (req, res) => {
  const scope = req.session.role === 'admin' ? '' : 'WHERE ab.group_id = ?';
  const params = req.session.role === 'admin' ? [] : [req.session.groupId];
  const books = db.prepare(`
    SELECT ab.*, g.name AS group_name,
      (SELECT COUNT(*) FROM contacts c WHERE c.address_book_id = ab.id) AS contact_count,
      (SELECT COUNT(*) FROM messages m JOIN campaigns c2 ON c2.id = m.campaign_id
        WHERE c2.address_book_id = ab.id) AS message_count
    FROM address_books ab LEFT JOIN groups g ON g.id = ab.group_id
    ${scope} ORDER BY ab.id ASC
  `).all(...params);
  res.json(books);
});

webApp.post('/admin/api/address-books', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const groupId = req.session.role === 'admin'
    ? (Number(req.body.groupId) || null)
    : req.session.groupId;
  if (name.length < 1 || name.length > 64) {
    return res.status(400).json({ error: 'Nom de carnet invalide (1 à 64 caractères)' });
  }
  if (!groupId) {
    return res.status(400).json({ error: 'Un groupe est requis pour créer un carnet' });
  }
  if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) {
    return res.status(400).json({ error: 'Groupe introuvable' });
  }
  if (db.prepare('SELECT 1 FROM address_books WHERE group_id = ? AND name = ?').get(groupId, name)) {
    return res.status(409).json({ error: 'Ce nom de carnet existe déjà dans ce groupe' });
  }
  const info = db.prepare('INSERT INTO address_books (group_id, name, created_at) VALUES (?, ?, ?)')
    .run(groupId, name, isoNow());
  res.status(201).json({ id: info.lastInsertRowid, group_id: groupId, name, created_at: isoNow(), contact_count: 0 });
});

webApp.patch('/admin/api/address-books/:bookId', (req, res) => {
  const checked = requireGroupBook(req, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 1 || name.length > 64) {
    return res.status(400).json({ error: 'Nom de carnet invalide (1 à 64 caractères)' });
  }
  const book = checked.book;
  const dup = db.prepare('SELECT 1 FROM address_books WHERE group_id = ? AND name = ? AND id <> ?')
    .get(book.group_id, name, book.id);
  if (dup) return res.status(409).json({ error: 'Ce nom de carnet existe déjà dans ce groupe' });
  db.prepare('UPDATE address_books SET name = ? WHERE id = ?').run(name, book.id);
  res.json({ ok: true });
});

webApp.delete('/admin/api/address-books/:bookId', (req, res) => {
  const checked = requireGroupBook(req, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  db.prepare('DELETE FROM contacts WHERE address_book_id = ?').run(checked.book.id);
  db.prepare('DELETE FROM address_books WHERE id = ?').run(checked.book.id);
  res.json({ ok: true });
});

webApp.get('/admin/api/address-books/:bookId/contacts', (req, res) => {
  const checked = requireGroupBook(req, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  const limit = Math.min(Math.max(parseInt(req.query.limit || '500', 10) || 500, 1), 2000);
  const rows = db.prepare(`
    SELECT id, first_name, last_name, entity, phone, created_at
    FROM contacts WHERE address_book_id = ? ORDER BY id ASC LIMIT ?
  `).all(checked.book.id, limit);
  res.json(rows);
});

webApp.post('/admin/api/address-books/:bookId/contacts', (req, res) => {
  const checked = requireGroupBook(req, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  const first = String((req.body || {}).firstName || '').trim();
  const last = String((req.body || {}).lastName || '').trim();
  const entity = String((req.body || {}).entity || '').trim();
  const phone = normalizePhone((req.body || {}).phone || '');
  if (!/^\+?[0-9]{4,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (!first && !last && !entity) {
    return res.status(400).json({ error: 'Prénom, nom ou entité requis' });
  }
  const info = db.prepare(
    'INSERT INTO contacts (address_book_id, first_name, last_name, entity, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(checked.book.id, first, last, entity, phone, isoNow());
  res.status(201).json({ id: info.lastInsertRowid, first_name: first, last_name: last, entity, phone, created_at: isoNow() });
});

webApp.delete('/admin/api/contacts/:contactId', (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(req.params.contactId));
  if (!contact) return res.status(404).json({ error: 'Contact introuvable' });
  const checked = requireGroupBook({ ...req, params: { bookId: contact.address_book_id } }, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  res.json({ ok: true });
});

webApp.patch('/admin/api/contacts/:contactId', (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(req.params.contactId));
  if (!contact) return res.status(404).json({ error: 'Contact introuvable' });
  const checked = requireGroupBook({ ...req, params: { bookId: contact.address_book_id } }, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  const body = req.body || {};
  const first = String(body.firstName !== undefined ? body.firstName : contact.first_name).trim();
  const last = String(body.lastName !== undefined ? body.lastName : contact.last_name).trim();
  const entity = String(body.entity !== undefined ? body.entity : contact.entity).trim();
  const phone = normalizePhone(body.phone !== undefined ? body.phone : contact.phone);
  if (!/^\+?[0-9]{4,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (!first && !last && !entity) {
    return res.status(400).json({ error: 'Prénom, nom ou entité requis' });
  }
  db.prepare(
    'UPDATE contacts SET first_name = ?, last_name = ?, entity = ?, phone = ? WHERE id = ?'
  ).run(first, last, entity, phone, contact.id);
  res.json({ ok: true, id: contact.id, first_name: first, last_name: last, entity, phone });
});

webApp.post('/admin/api/address-books/:bookId/import', (req, res) => {
  const checked = requireGroupBook(req, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  const body = req.body || {};
  const mp = body.map || {};
  const map = {
    firstName: String(mp.firstName !== undefined ? mp.firstName : (body.firstName || '')),
    lastName: String(mp.lastName !== undefined ? mp.lastName : (body.lastName || '')),
    entity: String(mp.entity !== undefined ? mp.entity : (body.entity || '')),
    phone: String(mp.phone !== undefined ? mp.phone : (body.phone || ''))
  };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const phoneIdx = map.phone ? parseInt(map.phone, 10) : -1;
  if (phoneIdx < 0) {
    return res.status(400).json({ error: 'Le numéro de téléphone doit être mappé sur une colonne' });
  }
  const idx = (c) => {
    const n = parseInt(c, 10);
    return Number.isInteger(n) && n >= 0 ? n : -1;
  };
  const fi = idx(map.firstName);
  const li = idx(map.lastName);
  const ei = idx(map.entity);

  const invalid = [];
  const toInsert = [];
  const seen = new Set();
  for (let r = 0; r < rows.length; r++) {
    const raw = Array.isArray(rows[r]) ? rows[r] : [];
    const phone = normalizePhone(raw[phoneIdx] == null ? '' : raw[phoneIdx]);
    const first = fi >= 0 ? String(raw[fi] == null ? '' : raw[fi]).trim() : '';
    const last = li >= 0 ? String(raw[li] == null ? '' : raw[li]).trim() : '';
    const entity = ei >= 0 ? String(raw[ei] == null ? '' : raw[ei]).trim() : '';
    if (!/^\+?[0-9]{4,15}$/.test(phone)) {
      invalid.push({ row: r + 2, phone, error: 'Numéro invalide' });
      continue;
    }
    const key = phone;
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push({ first, last, entity, phone });
  }

  const bookId = checked.book.id;
  const overwrite = body.overwrite === true;
  const replaced = overwrite
    ? db.prepare('DELETE FROM contacts WHERE address_book_id = ?').run(bookId).changes
    : 0;
  const insert = db.prepare(
    'INSERT INTO contacts (address_book_id, first_name, last_name, entity, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const createdAt = isoNow();
  db.exec('BEGIN');
  try {
    for (const c of toInsert) {
      insert.run(bookId, c.first, c.last, c.entity, c.phone, createdAt);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.status(201).json({
    rows: rows.length,
    created: toInsert.length,
    duplicates: rows.length - toInsert.length - invalid.length,
    invalid,
    replaced
  });
});

// Envoi vers un carnet d'adresses : crée une « campagne » (une entrée
// groupée dans le journal, nommée d'après le carnet) et un message par
// contact sélectionné, rattaché à la campagne et au groupe du carnet.
webApp.post('/admin/api/campaigns', (req, res) => {
  const body = req.body || {};
  const bookId = Number(body.bookId);
  const contactIds = Array.isArray(body.contactIds)
    ? body.contactIds.map(Number).filter(Number.isInteger)
    : [];
  const message = String(body.message || '').trim();
  const withAttachment = messageBodyWithAttachment(
    req,
    message,
    body.attachmentId,
    req.session.role === 'admin' ? null : { accountId: req.session.accountId }
  );
  if (!bookId) return res.status(400).json({ error: 'Carnet d’adresses requis' });
  const book = db.prepare('SELECT * FROM address_books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).json({ error: 'Carnet introuvable' });
  if (req.session.role !== 'admin' && book.group_id !== req.session.groupId) {
    return res.status(404).json({ error: 'Carnet introuvable' });
  }
  if (contactIds.length === 0) return res.status(400).json({ error: 'Sélectionnez au moins un destinataire' });
  if (!message) return res.status(400).json({ error: 'Message vide' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message trop long (max ${MAX_MESSAGE_LENGTH} caractères)` });
  }
  if (withAttachment.error) return res.status(400).json({ error: withAttachment.error });
  const sched = scheduleInfo(body.scheduledAt);
  if (sched && sched.error) return res.status(400).json({ error: sched.error });
  const placeholders = contactIds.map(() => '?').join(',');
  const contacts = db.prepare(
    `SELECT * FROM contacts WHERE address_book_id = ? AND id IN (${placeholders})`
  ).all(bookId, ...contactIds);
  if (contacts.length === 0) {
    return res.status(400).json({ error: 'Aucun destinataire valide dans ce carnet' });
  }
  const status = sched ? 'scheduled' : 'pending';
  const scheduledAt = sched ? sched.scheduledAt : null;
  const createdAt = isoNow();
  const groupId = book.group_id;
  let campaignId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      'INSERT INTO campaigns (address_book_id, group_id, body, created_by, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(bookId, groupId, withAttachment.body, req.session.accountId, scheduledAt, createdAt);
    campaignId = info.lastInsertRowid;
    const insert = db.prepare(
      'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_at, group_id, campaign_id, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const c of contacts) insert.run(c.phone, withAttachment.body, status, 'console', 'Console', withAttachment.attachment ? withAttachment.attachment.id : null, createdAt, groupId, campaignId, scheduledAt);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.status(201).json({ id: campaignId, bookName: book.name, count: contacts.length, status });
});

webApp.get('/admin/api/stats', requireAdmin, (_req, res) => {
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
  ).get(onlineCutoffIso()).c;
  res.json({ messages: byStatus, keys: byKeyType, gatewaysOnline: online });
});

webApp.get('/admin/api/gateways/online', requireSession, (_req, res) => {
  const online = db.prepare(
    "SELECT COUNT(*) AS c FROM keys WHERE type = 'gateway' AND last_seen_at > ?"
  ).get(onlineCutoffIso()).c;
  res.json({ online });
});

webApp.get('/admin/api/incoming', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT im.id, im.sender, im.body, im.received_at, im.created_at,
           k.label AS gateway_label, im.device_id
    FROM incoming_messages im
    LEFT JOIN keys k ON k.id = im.key_id
    ORDER BY im.id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

apiApp.listen(PORT_API, '0.0.0.0', () => {
  console.log(`[api] écoute sur le port ${PORT_API}`);
});
webApp.listen(PORT_WEB, '0.0.0.0', () => {
  console.log(`[web] interface sur le port ${PORT_WEB}`);
});

// Envois différés : les messages "scheduled" dont l'heure est arrivée
// passent en "pending" et sont récupérés par les passerelles.
setInterval(() => {
  try {
    const now = isoNow();
    db.prepare(
      "UPDATE messages SET status = 'pending', updated_at = ? WHERE status = 'scheduled' AND scheduled_at <= ?"
    ).run(now, now);
  } catch (_) { /* ne bloque jamais */ }
}, 10 * 1000);

function cleanupExpiredAttachments() {
  const expired = db.prepare(
    'SELECT id, stored_name, expires_at FROM attachments WHERE expires_at IS NOT NULL'
  ).all().filter((attachment) => Date.parse(attachment.expires_at) <= Date.now());
  if (!expired.length) return;
  db.exec('BEGIN');
  try {
    for (const attachment of expired) {
      fs.rmSync(path.join(ATTACHMENTS_DIR, attachment.stored_name), { force: true });
      db.prepare('DELETE FROM attachment_opens WHERE attachment_id = ?').run(attachment.id);
      db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[attachments] nettoyage impossible', err);
  }
}

setInterval(cleanupExpiredAttachments, 60 * 60 * 1000);
cleanupExpiredAttachments();
