'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const mail2sms = require('./mail2sms');
const frizbi = require('./frizbi');

const PORT_API = parseInt(process.env.PORT_API || '3250', 10);
const PORT_WEB = parseInt(process.env.PORT_WEB || '3251', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const APP_VERSION = process.env.APP_VERSION || '1.4.3';
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

// Adresse IP réelle du client. Derrière un reverse proxy (nginx, …), le serveur
// ne voit que l'IP du proxy : on lit d'abord le premier élément de
// X-Forwarded-For, qui correspond au client d'origine.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || '';
}
const isExpired = (row) => !!row.expires_at && Date.parse(row.expires_at) < Date.now();

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: ATTACHMENTS_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(12).toString('base64url'))
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

const CONTACT_VARIABLES = {
  '{prénom}': 'first_name',
  '{nom}': 'last_name',
  '{entité}': 'entity',
  '{téléphone}': 'phone',
  '{service}': 'service',
  '{direction}': 'direction',
  '{imei}': 'imei',
  '{puk}': 'puk'
};

function renderContactBody(template, contact) {
  return Object.entries(CONTACT_VARIABLES).reduce(
    (body, [variable, field]) => body.replaceAll(variable, String(contact[field] || '')),
    String(template)
  );
}

function isBlacklisted(phone) {
  return Boolean(db.prepare('SELECT 1 FROM blacklist_numbers WHERE phone = ?').get(phone));
}

function isMassExcluded(phone) {
  return Boolean(db.prepare('SELECT 1 FROM mass_exclusions WHERE phone = ?').get(phone));
}

// Résout l'ensemble des numéros correspondant à un envoi passé (campagne ou
// vérification de flotte), éventuellement filtré par état — utilisé pour
// cibler ou exclure les destinataires d'un envoi précédent lors de la
// composition d'un nouveau. Renvoie null si l'événement n'existe pas ou
// n'est pas visible pour la session (accès refusé).
function resolveEventPhones(req, eventType, eventId, state) {
  if (eventType === 'campaign') {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND deleted_at IS NULL').get(eventId);
    if (!campaign || (req.session.role !== 'admin' && campaign.group_id !== req.session.groupId)) return null;
    const rows = state
      ? db.prepare('SELECT recipient AS phone FROM messages WHERE campaign_id = ? AND status = ?').all(eventId, state)
      : db.prepare('SELECT recipient AS phone FROM messages WHERE campaign_id = ?').all(eventId);
    return new Set(rows.map((r) => r.phone));
  }
  if (eventType === 'fleet') {
    const check = db.prepare('SELECT * FROM fleet_checks WHERE id = ? AND deleted_at IS NULL').get(eventId);
    if (!check || (req.session.role !== 'admin' && check.group_id !== req.session.groupId)) return null;
    const rows = state
      ? db.prepare('SELECT phone FROM fleet_check_items WHERE fleet_check_id = ? AND state = ?').all(eventId, state)
      : db.prepare('SELECT phone FROM fleet_check_items WHERE fleet_check_id = ?').all(eventId);
    return new Set(rows.map((r) => r.phone));
  }
  return null;
}

const FLEET_RESPONSE_HOURS = 72;

function updateFleetItemForMessage(messageId, status, at, error) {
  const state = status === 'failed' ? 'failed' : status === 'delivered' ? 'delivered' : 'sent';
  db.prepare(`
    UPDATE fleet_check_items SET
      state = CASE WHEN response_at IS NULL THEN ? ELSE 'replied' END,
      sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
      delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      failed_at = CASE WHEN ? = 'failed' THEN COALESCE(failed_at, ?) ELSE failed_at END,
      error = CASE WHEN ? = 'failed' THEN ? ELSE error END
    WHERE message_id = ?
  `).run(
    state,
    status, at,
    status, at,
    status, at,
    status, error || null,
    messageId
  );
}

function refreshFleetTimeouts() {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT id, delivered_at FROM fleet_check_items
    WHERE response_at IS NULL AND state = 'delivered' AND delivered_at IS NOT NULL
  `).all();
  const update = db.prepare("UPDATE fleet_check_items SET state = 'no_response' WHERE id = ? AND response_at IS NULL");
  for (const row of rows) {
    if (now - Date.parse(row.delivered_at) >= FLEET_RESPONSE_HOURS * 3600000) update.run(row.id);
  }
}

function recordFleetResponse(sender, body, receivedAt) {
  const phone = normalizePhone(sender);
  if (!phone) return;
  refreshFleetTimeouts();
  const rows = db.prepare(`
    SELECT i.id, i.delivered_at, c.response_hours
    FROM fleet_check_items i JOIN fleet_checks c ON c.id = i.fleet_check_id
    WHERE i.phone = ? AND i.response_at IS NULL AND i.state = 'delivered'
    ORDER BY i.id ASC
  `).all(phone);
  for (const row of rows) {
    const deliveredAt = Date.parse(row.delivered_at || '');
    if (!Number.isNaN(deliveredAt) && Date.parse(receivedAt) - deliveredAt <= (row.response_hours || FLEET_RESPONSE_HOURS) * 3600000) {
      db.prepare(`
        UPDATE fleet_check_items SET state = 'replied', response_at = ?, response_sender = ?, response_body = ?
        WHERE id = ? AND response_at IS NULL
      `).run(receivedAt, sender, body, row.id);
      break;
    }
  }
}

// ---------- Rate limiting (simple, en mémoire) ----------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '30', 10);
const rateHits = new Map(); // "ip|keyId" -> [timestamps]

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = `${clientIp(req)}|${req.apiKey ? req.apiKey.id : 'anon'}`;
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
    ).run(keyId || null, clientIp(req), reason, isoNow());
  } catch (_) { /* ne bloque jamais la réponse */ }
}

// ---------- Numéro de téléphone du compte admin (alertes SMS) ----------
// Le compte administrateur (connexion sans login) stocke son numéro dans une
// ligne pivot de `accounts` (login vide). Renseigné dans l'interface admin.
function getAdminPhone() {
  const row = db.prepare('SELECT phone FROM accounts WHERE login = ?').get('');
  return row && row.phone ? row.phone : '';
}

function setAdminPhone(phone) {
  const normalized = normalizePhone(phone);
  return db.prepare('UPDATE accounts SET phone = ? WHERE login = ?').run(normalized, '');
}

// ---------- Répartition des envois entre passerelles internes ----------
function getGatewaySettings() {
  return db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get() ||
    { quota_cap: 180, quota_window_days: 30 };
}

/**
 * Détermine quelle passerelle interne (téléphone) doit traiter l'envoi vers
 * `recipient`, pour ne pas cumuler plus de `quota_cap` destinataires
 * distincts sur une même ligne dans la fenêtre glissante (protection contre
 * le blocage anti-spam opérateur, cf. limite contractuelle « SMS illimités »
 * à ~200 destinataires distincts/mois chez SFR).
 * - Si une passerelle en ligne a déjà été utilisée pour ce numéro dans la
 *   fenêtre, on la réutilise : elle a déjà « consommé » ce destinataire, le
 *   reprendre ne coûte rien de plus sur son quota.
 * - Sinon, on choisit la passerelle en ligne la moins chargée, si elle a
 *   encore de la marge sous le plafond.
 * - Renvoie null si aucune passerelle en ligne n'a de marge disponible ;
 *   l'appelant retombe alors sur la répartition de charge historique
 *   (message non attribué, prenable par la première passerelle disponible).
 */
function assignGateway(recipient) {
  const settings = getGatewaySettings();
  const windowIso = new Date(Date.now() - settings.quota_window_days * 24 * 60 * 60 * 1000).toISOString();
  const onlineCutoff = onlineCutoffIso();
  const gateways = db.prepare(`
    SELECT k.id,
      (SELECT COUNT(DISTINCT m.recipient) FROM messages m
        WHERE m.claimed_by = k.id AND m.provider = 'internal' AND m.created_at >= ?) AS recentDistinct
    FROM keys k
    WHERE k.type = 'gateway' AND k.revoked = 0 AND k.last_seen_at > ?
  `).all(windowIso, onlineCutoff);
  if (!gateways.length) return null;
  const sticky = db.prepare(`
    SELECT claimed_by FROM messages
    WHERE recipient = ? AND provider = 'internal' AND claimed_by IS NOT NULL AND created_at >= ?
    ORDER BY id DESC LIMIT 1
  `).get(recipient, windowIso);
  if (sticky) {
    const match = gateways.find((g) => g.id === sticky.claimed_by);
    if (match) return match.id;
  }
  const eligible = gateways.filter((g) => g.recentDistinct < settings.quota_cap);
  if (!eligible.length) return null;
  eligible.sort((a, b) => a.recentDistinct - b.recentDistinct);
  return eligible[0].id;
}

/**
 * Simule l'attribution de `phones` aux passerelles internes en ligne, sans
 * rien écrire en base — reproduit la logique d'assignGateway (fidélité,
 * quota, répartition par charge croissante) mais en enchaînant les
 * décisions en mémoire pour tout le lot, comme le ferait l'envoi réel
 * message après message.
 */
function simulateAssignment(phones) {
  const settings = getGatewaySettings();
  const windowIso = new Date(Date.now() - settings.quota_window_days * 24 * 60 * 60 * 1000).toISOString();
  const onlineCutoff = onlineCutoffIso();
  const gateways = db.prepare(`
    SELECT k.id, k.label, k.sim_count,
      (SELECT COUNT(DISTINCT m.recipient) FROM messages m
        WHERE m.claimed_by = k.id AND m.provider = 'internal' AND m.created_at >= ?) AS recentDistinct
    FROM keys k
    WHERE k.type = 'gateway' AND k.revoked = 0 AND k.last_seen_at > ?
  `).all(windowIso, onlineCutoff);

  const simulated = new Map(gateways.map((g) => [g.id, g.recentDistinct]));
  const assignedCount = new Map(gateways.map((g) => [g.id, 0]));
  let unassigned = 0;

  const stickyStmt = db.prepare(`
    SELECT claimed_by FROM messages
    WHERE recipient = ? AND provider = 'internal' AND claimed_by IS NOT NULL AND created_at >= ?
    ORDER BY id DESC LIMIT 1
  `);

  for (const phone of phones) {
    if (!gateways.length) { unassigned++; continue; }
    const sticky = stickyStmt.get(phone, windowIso);
    let gatewayId;
    let isNewDistinct = true;
    if (sticky && gateways.some((g) => g.id === sticky.claimed_by)) {
      gatewayId = sticky.claimed_by;
      isNewDistinct = false; // déjà compté dans recentDistinct
    } else {
      const eligible = gateways.filter((g) => simulated.get(g.id) < settings.quota_cap);
      if (!eligible.length) { unassigned++; continue; }
      eligible.sort((a, b) => simulated.get(a.id) - simulated.get(b.id));
      gatewayId = eligible[0].id;
    }
    assignedCount.set(gatewayId, assignedCount.get(gatewayId) + 1);
    if (isNewDistinct) simulated.set(gatewayId, simulated.get(gatewayId) + 1);
  }

  return {
    gateways: gateways.map((g) => ({
      id: g.id, label: g.label, simCount: g.sim_count || 1,
      assigned: assignedCount.get(g.id) || 0,
      quotaBefore: g.recentDistinct, quotaAfter: simulated.get(g.id)
    })),
    unassigned
  };
}

// Estimation du temps d'envoi pour N messages sur UNE passerelle : l'envoi y
// est séquentiel (un seul flux par téléphone, quel que soit son nombre de
// SIM — l'alternance de ligne ne change que le quota, pas le débit), avec
// un intervalle moyen de 5s (lots >= 10, cf. BATCH_INTERVAL_FAST_MS côté
// APK) ou 10s (lots < 10, BATCH_INTERVAL_SLOW_MS), +/-30% de temps d'attente
// aléatoire, donc en moyenne égal à la valeur de base.
function estimateSendSeconds(count) {
  if (count <= 0) return 0;
  const perMessageSec = count >= 10 ? 5 : 10;
  return count * perMessageSec;
}

// Répartition estimée d'un compte de messages entre les lignes (SIM) d'une
// même passerelle : l'APK alterne 50/50, donc un partage égal (à 1 près) est
// l'estimation la plus fidèle sans remontée précise par SIM.
function splitByLines(assigned, simCount) {
  const n = Math.max(1, simCount || 1);
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(Math.floor(assigned / n) + (i < assigned % n ? 1 : 0));
  }
  return lines;
}

// ---------- Envoi de SMS externe (Frizbi) ----------
function getFrizbiSettings() {
  const s = db.prepare('SELECT * FROM frizbi_settings WHERE id = 1').get() ||
    { mode: 'internal', both_threshold: 10, api_url: '', client_id: '', client_secret: '', sender_id: 'IVRY', callback_token: null };
  if (!s.callback_token) {
    s.callback_token = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE frizbi_settings SET callback_token = ? WHERE id = 1').run(s.callback_token);
  }
  return s;
}

// Statuts documentés par Frizbi (Frizbi_API_V2.3_Complet.md) : status_sent
// veut dire « délivré » (pas juste « envoyé »). Les autres valeurs
// (status_pending_0/status_pending/waiting/pending) veulent dire qu'on n'a
// pas encore de résultat final -> on ne touche rien dans ce cas (retour null).
function mapFrizbiStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (['status_sent', 'sent', 'delivered'].includes(s)) return 'delivered';
  if (['status_error', 'status_sent_not_delivered', 'status_canceled', 'error', 'failed', 'canceled', 'cancelled'].includes(s)) return 'failed';
  return null;
}

/**
 * Interroge périodiquement /api/sms/status pour les envois Frizbi encore
 * « sent » (accepté par Frizbi, résultat de livraison pas encore connu).
 * La doc V2.3 ne montre pas le JSON exact renvoyé par cet endpoint : on
 * gère à la fois un tableau (historique par contact) et un objet unique
 * (statut agrégé pour tout le lot), et on journalise chaque appel dans
 * frizbi_events pour permettre d'observer le format réel.
 */
async function pollFrizbiStatuses() {
  const pending = db.prepare(
    "SELECT DISTINCT provider_ref FROM messages WHERE provider = 'frizbi' AND status = 'sent' AND provider_ref IS NOT NULL"
  ).all();
  if (!pending.length) return;
  const settings = getFrizbiSettings();
  if (!settings.api_url || !settings.client_id || !settings.client_secret) return;
  for (const { provider_ref } of pending) {
    let data;
    try {
      data = await frizbi.frizbiStatus(settings, provider_ref);
    } catch (err) {
      console.error(`[FRIZBI] statut ${provider_ref} injoignable :`, err.message);
      continue;
    }
    const nowIso = isoNow();
    const entries = Array.isArray(data) ? data : (Array.isArray(data && data.history) ? data.history : [data]);
    let anyApplied = false;
    for (const entry of entries) {
      if (!entry) continue;
      const contactId = entry.customerSmsContactId || entry.customer_sms_contact_id;
      const statusRaw = entry.status || entry.state;
      const mapped = mapFrizbiStatus(statusRaw);
      if (!mapped) continue;
      const byContact = contactId != null && /^\d+$/.test(String(contactId));
      const where = byContact
        ? "id = ? AND provider = 'frizbi'"
        : "provider_ref = ? AND provider = 'frizbi' AND status = 'sent'";
      const param = byContact ? Number(contactId) : provider_ref;
      if (mapped === 'delivered') {
        db.prepare(`UPDATE messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE ${where}`).run(nowIso, nowIso, param);
      } else {
        db.prepare(`UPDATE messages SET status = 'failed', failed_at = COALESCE(failed_at, ?), error = ?, updated_at = ? WHERE ${where}`).run(nowIso, `Frizbi : ${statusRaw}`, nowIso, param);
      }
      anyApplied = true;
    }
    db.prepare(`
      INSERT INTO frizbi_events (received_at, source, customer_sms_id, status_raw, payload, applied)
      VALUES (?, 'poll', ?, ?, ?, ?)
    `).run(
      nowIso, provider_ref,
      entries.map((e) => e && (e.status || e.state)).filter(Boolean).join(','),
      JSON.stringify(data).slice(0, 4000),
      anyApplied ? 1 : 0
    );
  }
}
setInterval(() => { pollFrizbiStatuses().catch((err) => console.error('[FRIZBI] poll error:', err)); }, 60 * 1000);

// Décide, pour un envoi groupé de `count` destinataires, quel canal utiliser.
// 'both' : Frizbi seulement au-delà du seuil configuré, sinon passerelles.
function decideSmsProvider(count) {
  const s = getFrizbiSettings();
  if (s.mode === 'frizbi') return 'frizbi';
  if (s.mode === 'both' && count > (s.both_threshold || 10)) return 'frizbi';
  return 'internal';
}

/**
 * Envoie via Frizbi un lot de messages déjà insérés (provider = 'frizbi')
 * et met à jour leur statut selon le résultat. Regroupe par corps de
 * message identique : un appel Frizbi ne porte qu'un seul texte, donc un
 * envoi avec variables par contact peut donner plusieurs appels (un par
 * variante), un envoi au texte commun n'en fait qu'un seul quel que soit
 * le nombre de destinataires.
 */
async function dispatchFrizbiBatch(entries, { title } = {}) {
  if (!entries.length) return;
  const settings = getFrizbiSettings();
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.body)) groups.set(entry.body, []);
    groups.get(entry.body).push(entry);
  }
  for (const [body, group] of groups) {
    const nowIso = isoNow();
    const ids = group.map((e) => e.messageId);
    const placeholders = ids.map(() => '?').join(',');
    try {
      const result = await frizbi.frizbiSend(settings, {
        title,
        message: body,
        contacts: group.map((e) => ({ id: e.messageId, mobile: e.recipient, firstName: e.firstName, lastName: e.lastName }))
      });
      db.prepare(
        `UPDATE messages SET status = 'sent', provider_ref = ?, sent_at = ?, updated_at = ? WHERE id IN (${placeholders})`
      ).run(result.customerSmsId, nowIso, nowIso, ...ids);
    } catch (err) {
      db.prepare(
        `UPDATE messages SET status = 'failed', failed_at = ?, error = ?, updated_at = ? WHERE id IN (${placeholders})`
      ).run(nowIso, String((err && err.message) || err).slice(0, 500), nowIso, ...ids);
    }
  }
}

// ---------- Anti-bruteforce sur la connexion console ----------
// Suit les échecs consécutifs par IP + login tenté (en mémoire). Chaque échec
// augmente le délai d'attente imposé avant la prochaine tentative, et les
// échecs sont journalisés dans `auth_logs`. Après BRUTE_FORCE_ALERT_THRESHOLD
// échecs consécutifs, un SMS d'alerte est envoyé au compte administrateur.
const BRUTE_FORCE_WINDOW_MS = 10 * 60 * 1000;   // fenêtre de comptage des échecs
const BRUTE_FORCE_ALERT_THRESHOLD = 5;          // déclenche l'alerte SMS
const BRUTE_FORCE_DELAYS = [0, 0, 0, 0, 0, 5000, 15000, 30000, 60000, 120000, 300000]; // ms par rang
const authFailures = new Map(); // key -> { count, lastAt }

function authFailureKey(req, login) {
  return `${clientIp(req)}|${login || 'admin'}`;
}

function authRequiredDelay(req, login) {
  const entry = authFailures.get(authFailureKey(req, login));
  if (!entry) return 0;
  const elapsed = Date.now() - entry.lastAt;
  if (elapsed > BRUTE_FORCE_WINDOW_MS) {
    authFailures.delete(authFailureKey(req, login));
    return 0;
  }
  const rank = Math.min(entry.count, BRUTE_FORCE_DELAYS.length - 1);
  return Math.max(0, BRUTE_FORCE_DELAYS[rank] - elapsed);
}

// Enregistre un échec ; renvoie true si un SMS d'alerte doit être envoyé
// (atteinte du seuil sans dépassement sur la fenêtre courante).
function recordAuthFailure(req, login) {
  const key = authFailureKey(req, login);
  const now = Date.now();
  const prev = authFailures.get(key);
  const count = (prev && now - prev.lastAt <= BRUTE_FORCE_WINDOW_MS) ? prev.count + 1 : 1;
  authFailures.set(key, { count, lastAt: now });
  return count === BRUTE_FORCE_ALERT_THRESHOLD;
}

// Supprime l'historique d'échecs d'une clé (après une connexion réussie).
function clearAuthFailures(req, login) {
  authFailures.delete(authFailureKey(req, login));
}

function sendAdminAlertSms(message) {
  const phone = getAdminPhone();
  if (!phone) return;
  try {
    db.prepare(`
      INSERT INTO messages (recipient, body, status, origin, origin_label, created_by_label, created_at, group_id)
      VALUES (?, ?, 'pending', 'console', 'Alerte sécurité', 'Sécurité', ?, NULL)
    `).run(phone, message.slice(0, MAX_MESSAGE_LENGTH), isoNow());
  } catch (_) { /* l'alerte ne bloque jamais la connexion */ }
}

// ---------- Journal de la console (connexions et envois, quantitatif) ----------
function logConsole(req, action, detail, count) {
  try {
    const s = req.session;
    db.prepare(
      'INSERT INTO console_logs (login, role, action, detail, count, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      s ? s.login : 'admin',
      s ? s.role : 'admin',
      action,
      detail || null,
      count || 1,
      clientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 255) || null,
      isoNow()
    );
  } catch (_) { /* ne bloque jamais la réponse */ }
}

// ---------- Sessions de l'interface web ----------
// Stockées en base (et non en mémoire) : un redémarrage du conteneur ou un
// basculement de réplica ne déconnecte plus les utilisateurs de la console.
db.exec(`
CREATE TABLE IF NOT EXISTS web_sessions (
  sid         TEXT    PRIMARY KEY,
  account_id  INTEGER,
  login       TEXT    NOT NULL,
  role        TEXT    NOT NULL,
  group_id    INTEGER,
  exp         INTEGER NOT NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_exp ON web_sessions(exp);
`);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function loadSession(sid) {
  if (!sid) return null;
  const row = db.prepare('SELECT * FROM web_sessions WHERE sid = ?').get(sid);
  if (!row) return null;
  if (row.exp < Date.now()) {
    db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid);
    return null;
  }
  return {
    accountId: row.account_id,
    login: row.login,
    role: row.role,
    groupId: row.group_id,
    isAdmin: row.role === 'admin'
  };
}

function saveSession(sid, session) {
  db.prepare(`
    INSERT INTO web_sessions (sid, account_id, login, role, group_id, exp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET
      account_id = excluded.account_id,
      login      = excluded.login,
      role       = excluded.role,
      group_id   = excluded.group_id,
      exp        = excluded.exp
  `).run(
    sid,
    session.accountId || null,
    session.login,
    session.role,
    session.groupId || null,
    session.exp,
    isoNow()
  );
  db.prepare('DELETE FROM web_sessions WHERE exp < ?').run(Date.now());
}

function sessionValid(req) {
  const s = loadSession(parseCookies(req).sid);
  if (!s) return null;
  if (s.accountId) {
    const acc = db.prepare('SELECT id FROM accounts WHERE id = ? AND disabled = 0').get(s.accountId);
    if (!acc) {
      db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(parseCookies(req).sid);
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
apiApp.use(express.json({ limit: '25mb' }));
apiApp.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

apiApp.get('/health', (_req, res) => res.json({ ok: true }));

apiApp.get('/api/v1/attachments/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(token)) return res.status(404).end();
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
    clientIp(req),
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
apiApp.post('/api/v1/messages', requireApiKey('web'), rateLimit, async (req, res) => {
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
  const provider = decideSmsProvider(1);
  const claimedBy = provider === 'internal' ? assignGateway(recipient) : null;
  const createdAt = isoNow();
  const info = db.prepare(
    'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_by_label, created_at, provider, claimed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(recipient, withAttachment.body, 'pending', 'web', req.apiKey.label, withAttachment.attachment ? withAttachment.attachment.id : null, `API WEB : ${req.apiKey.label}`, createdAt, provider, claimedBy);
  let finalStatus = 'pending';
  if (provider === 'frizbi') {
    await dispatchFrizbiBatch([{ messageId: info.lastInsertRowid, recipient, body: withAttachment.body }], { title: 'Ville d’Ivry' });
    finalStatus = db.prepare('SELECT status FROM messages WHERE id = ?').get(info.lastInsertRowid).status;
  }
  res.status(201).json({
    id: info.lastInsertRowid,
    recipient,
    message: withAttachment.body,
    status: finalStatus,
    provider,
    createdAt,
    attachment: withAttachment.attachment
      ? { id: withAttachment.attachment.id, name: withAttachment.attachment.original_name, url: publicAttachmentUrl(req, withAttachment.attachment.token) }
      : null
  });
});

// Lecture des carnets d'adresses (clé type "web") — utilisée pour la
// synchronisation de carnets entre instances de la passerelle.
apiApp.get('/api/v1/books', requireApiKey('web'), (_req, res) => {
  res.json(listRemoteBooksLocal());
});

apiApp.get('/api/v1/books/:id/contacts', requireApiKey('web'), (req, res) => {
  const data = getRemoteBookContactsLocal(Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Carnet introuvable' });
  res.json(data);
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
  const appVersion = String(body.appVersion || '').trim().slice(0, 32);
  const simCount = Math.min(Math.max(parseInt(body.simCount, 10) || 0, 0), 4);
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
       if (info.changes > 0) {
         reportAccepted.push(id);
         updateFleetItemForMessage(id, status, nowIso, error);
       }
    }

    // Répartition de charge : chaque passerelle récupère sa part de la file
    // (environ 1/N si N passerelles actives), pas la file entière, pour
    // laisser les autres passerelles récupérer les leurs. Les messages en
    // attente depuis >= 1 intervalle sont prenables par le premier venu,
    // pour qu'aucun message ne soit oublié si une passerelle ne revient pas.
    // Ceci ne s'applique qu'aux messages NON attribués à la création (cf.
    // assignGateway) : c'est le pool historique/de secours quand aucune
    // passerelle n'avait de marge disponible sous son quota au moment de
    // l'envoi.
    const intervalMs = SYNC_INTERVAL_SEC * 1000;
    const claimState = db.prepare('SELECT * FROM claim_state WHERE id = 1').get();
    if (!claimState.round_started || Date.now() - Date.parse(claimState.round_started) >= intervalMs) {
      db.prepare('UPDATE claim_state SET round_started = ?, claimed = 0 WHERE id = 1').run(nowIso);
      claimState.round_started = nowIso;
      claimState.claimed = 0;
    }

    const pendingCount = db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE status = 'pending' AND provider = 'internal' AND claimed_by IS NULL"
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
      "SELECT * FROM messages WHERE status = 'sending' AND provider = 'internal' AND claimed_at < ? ORDER BY id ASC LIMIT ?"
    ).all(cutoff, CLAIM_LIMIT);
    // Messages déjà attribués à MOI par le serveur à la création (cf.
    // assignGateway) : je les prends sans limite de partage, ils ne sont
    // prenables par personne d'autre tant que je suis en ligne.
    const mine = db.prepare(
      "SELECT * FROM messages WHERE status = 'pending' AND provider = 'internal' AND claimed_by = ? ORDER BY id ASC LIMIT ?"
    ).all(req.apiKey.id, CLAIM_LIMIT);
    // Messages attribués à une passerelle qui semble hors-ligne : n'importe
    // quelle passerelle en ligne peut les récupérer pour ne pas les perdre.
    const orphaned = db.prepare(`
      SELECT m.* FROM messages m LEFT JOIN keys k ON k.id = m.claimed_by
      WHERE m.status = 'pending' AND m.provider = 'internal' AND m.claimed_by IS NOT NULL
        AND m.claimed_by <> ? AND (k.last_seen_at IS NULL OR k.last_seen_at <= ?)
      ORDER BY m.id ASC LIMIT ?
    `).all(req.apiKey.id, activeCutoff, CLAIM_LIMIT);
    const pending = db.prepare(
      "SELECT * FROM messages WHERE status = 'pending' AND provider = 'internal' AND claimed_by IS NULL ORDER BY id ASC LIMIT ?"
    ).all(CLAIM_LIMIT);

    const toClaim = [];
    let pendingClaimed = 0;
    const add = (m) => { if (toClaim.length < CLAIM_LIMIT) toClaim.push(m); };
    for (const m of stale) add(m);
    for (const m of mine) add(m);
    for (const m of orphaned) add(m);
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
        device_id = CASE WHEN ? <> '' THEN ? ELSE device_id END,
        app_version = CASE WHEN ? <> '' THEN ? ELSE app_version END,
        sim_count = CASE WHEN ? > 0 THEN ? ELSE sim_count END
      WHERE id = ?
    `).run(nowIso, nowIso, deviceId, deviceId, appVersion, appVersion, simCount, simCount, req.apiKey.id);

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
  const acceptedMessages = [];
  db.exec('BEGIN');
  try {
    for (const m of messages) {
      const providerId = String(m.providerId || m.id || '').trim();
      const sender = String(m.sender || '').trim();
      const body = String(m.body || '').trim();
      const receivedAt = normalizeIncomingDate(m.receivedAt || nowIso);
      if (!providerId || !sender) continue;
      const info = insert.run(req.apiKey.id, deviceId, providerId, sender, body, receivedAt, nowIso);
       if (info.changes > 0) {
         accepted++;
         acceptedMessages.push({ sender, body, receivedAt });
       }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const message of acceptedMessages) {
    recordFleetResponse(message.sender, message.body, message.receivedAt);
  }
  res.json({ accepted });
});

// Callback temps réel Frizbi (statut d'envoi). À configurer côté Frizbi
// (Admin > API) avec l'URL affichée dans la console (onglet SMS externe).
// La doc V2.3 ne montre qu'un exemple d'URL (?customerSmsContactId=id),
// sans détail des autres paramètres réellement envoyés : on accepte GET et
// POST, on cherche un champ de statut sous plusieurs noms plausibles, et on
// journalise systématiquement le payload brut dans frizbi_events pour
// permettre d'observer et d'ajuster une fois le trafic réel disponible.
apiApp.all('/api/v1/frizbi/callback', (req, res) => {
  const params = { ...req.query, ...(req.body || {}) };
  const settings = getFrizbiSettings();
  const providedToken = params.token || req.get('x-frizbi-token');
  if (settings.callback_token && providedToken !== settings.callback_token) {
    return res.status(403).json({ error: 'Jeton invalide' });
  }
  const nowIso = isoNow();
  const contactId = params.customerSmsContactId || params.customer_sms_contact_id || null;
  const smsId = params.customerSmsId || params.customer_sms_id || null;
  const statusRaw = params.status || params.state || params.smsStatus || params.deliveryStatus || null;
  let messageId = null;
  let applied = false;
  if (contactId != null && /^\d+$/.test(String(contactId))) {
    messageId = Number(contactId);
    const mapped = mapFrizbiStatus(statusRaw);
    if (mapped === 'delivered') {
      db.prepare("UPDATE messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE id = ? AND provider = 'frizbi'").run(nowIso, nowIso, messageId);
      applied = true;
    } else if (mapped === 'failed') {
      db.prepare("UPDATE messages SET status = 'failed', failed_at = COALESCE(failed_at, ?), error = ?, updated_at = ? WHERE id = ? AND provider = 'frizbi'").run(nowIso, `Frizbi : ${statusRaw}`, nowIso, messageId);
      applied = true;
    }
  }
  db.prepare(`
    INSERT INTO frizbi_events (received_at, source, message_id, customer_sms_id, customer_sms_contact_id, status_raw, payload, applied)
    VALUES (?, 'callback', ?, ?, ?, ?, ?, ?)
  `).run(nowIso, messageId, smsId, contactId, statusRaw, JSON.stringify(params).slice(0, 4000), applied ? 1 : 0);
  res.json({ ok: true });
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
webApp.use(express.json({ limit: '25mb' }));
webApp.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

webApp.post('/admin/login', (req, res) => {
  const login = String((req.body || {}).login || '').trim();
  const password = String((req.body || {}).password || '');
  const efLogin = login === '' ? 'admin' : login;

  // Anti-bruteforce : si un délai d'attente est imposé à cette IP+login, on
  // refuse la tentative (sans valider le mot de passe) et on journalise.
  const delay = authRequiredDelay(req, efLogin);
  if (delay > 0) {
    logAuthAttempt(req, null, `429 Ralentissement anti-bruteforce (${efLogin}, réessayez dans ${Math.ceil(delay / 1000)} s)`);
    return res.status(429).json({
      error: `Trop de tentatives. Réessayez dans ${Math.ceil(delay / 1000)} seconde(s).`
    });
  }

  let accountId = null;
  let sessionLogin;
  let role = 'user';
  let groupId = null;

  const fail = (reason) => {
    logAuthAttempt(req, null, reason);
    if (recordAuthFailure(req, efLogin)) {
      sendAdminAlertSms(
        `Alerte sécurité : ${BRUTE_FORCE_ALERT_THRESHOLD} tentatives de connexion infructueuses sur la console (login « ${efLogin.slice(0, 32)} », IP ${clientIp(req)}).`
      );
    }
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  };

  if (login === '') {
    if (password !== ADMIN_PASSWORD) {
      return fail('401 Mot de passe admin incorrect');
    }
    role = 'admin';
    sessionLogin = 'admin';
  } else {
    const row = db.prepare('SELECT * FROM accounts WHERE login = ?').get(login);
    if (!row || row.disabled || !verifyPassword(password, row.password_hash)) {
      return fail(`401 Connexion échouée (compte « ${login.slice(0, 32)} »)`);
    }
    accountId = row.id;
    sessionLogin = row.login;
    role = row.role === 'admin' ? 'admin' : 'user';
    groupId = row.group_id || null;
  }

  clearAuthFailures(req, efLogin);
  const sid = newToken();
  const session = {
    exp: Date.now() + SESSION_TTL_MS,
    accountId,
    login: sessionLogin,
    role,
    groupId,
    isAdmin: role === 'admin'
  };
  saveSession(sid, session);
  req.session = session;
  if (accountId) {
    db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(isoNow(), accountId);
  }
  logConsole(req, 'connexion', `Connexion à la console${accountId ? '' : ' (admin)'}`);
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
  db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(parseCookies(req).sid);
  res.json({ ok: true });
});

const sendFile = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

// Injecte la version dans le HTML (fichiers et URLs d'assets suffixés
// par "?v=…" pour casser le cache navigateur/proxy à chaque release), et
// le contenu de l'aide, partagé entre l'onglet de la console et la page
// publique /aide (même fragment, une seule source).
const helpFragment = () => fs.readFileSync(path.join(PUBLIC_DIR, 'help-content.html'), 'utf8');
const renderHtml = (name) => (_req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8')
    .replace('<!-- __HELP_CONTENT__ -->', () => helpFragment())
    .replace(/__APP_VERSION__/g, APP_VERSION);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
};

apiApp.get('/docs', sendFile('docs.html'));
apiApp.get('/openapi.json', sendFile('openapi.json'));
webApp.get('/docs', sendFile('docs.html'));
webApp.get('/openapi.json', sendFile('openapi.json'));

// Page d'aide publique : consultable sans authentification.
webApp.get('/aide', renderHtml('help.html'));

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
  const gwSettings = getGatewaySettings();
  const windowIso = new Date(Date.now() - gwSettings.quota_window_days * 24 * 60 * 60 * 1000).toISOString();
  const gateways = db.prepare(`
    SELECT
      k.id, k.label, k.device_id, k.app_version, k.last_seen_at, k.last_used_at,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id) AS claimed,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'sending')  AS sending,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'sent')      AS sent,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'delivered') AS delivered,
      (SELECT COUNT(*) FROM messages m WHERE m.claimed_by = k.id AND m.status = 'failed')    AS failed,
      (SELECT COUNT(DISTINCT m.recipient) FROM messages m
        WHERE m.claimed_by = k.id AND m.provider = 'internal' AND m.created_at >= ?)         AS recentDistinctRecipients
    FROM keys k
    WHERE k.type = 'gateway'
    ORDER BY k.last_seen_at DESC
  `).all(windowIso).map((g) => ({ ...g, online: !!(g.last_seen_at && g.last_seen_at > cutoff), quotaCap: gwSettings.quota_cap }));
  res.json(gateways);
});

webApp.get('/admin/api/gateway-settings', requireAdmin, (_req, res) => {
  res.json(getGatewaySettings());
});

webApp.post('/admin/api/gateway-settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  const quotaCap = Math.max(1, parseInt(body.quotaCap, 10) || 180);
  const quotaWindowDays = Math.max(1, parseInt(body.quotaWindowDays, 10) || 30);
  db.prepare('UPDATE gateway_settings SET quota_cap = ?, quota_window_days = ? WHERE id = 1')
    .run(quotaCap, quotaWindowDays);
  logConsole(req, 'config quota passerelles', `cap=${quotaCap} fenêtre=${quotaWindowDays}j`);
  res.json({ ok: true });
});

webApp.get('/admin/api/messages/export', requireAdmin, (req, res) => {
  const status = String(req.query.status || '');
  const base = `
     SELECT m.*, k.label AS gateway_label, k.device_id AS device_id, g.name AS group_name,
       acc.login AS creator_login,
       a.original_name AS attachment_name, a.opened_at AS attachment_opened_at, a.open_count AS attachment_open_count
     FROM messages m LEFT JOIN keys k ON k.id = m.claimed_by
     LEFT JOIN attachments a ON a.id = m.attachment_id
     LEFT JOIN accounts acc ON acc.id = m.created_by
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
  const header = ['ID', 'Date', 'Origine', 'Créateur', 'Destinataire', 'Message', 'Statut', 'Envoyé le', 'Remis le', 'Échec le', 'Passerelle', 'Appareil', 'Pièce jointe', 'Ouvertures', 'Erreur'];
  const lines = rows.map((m) => [
    m.id,
    m.created_at,
    m.origin === 'web' ? `API WEB${m.origin_label ? ` (${m.origin_label})` : ''}` : (m.creator_login || m.created_by_label || 'Console'),
    m.creator_login || m.created_by_label || '',
    m.recipient,
    m.body,
    statusLabel[m.status] || m.status,
    m.sent_at,
    m.delivered_at,
    m.failed_at,
    m.provider === 'frizbi' ? 'Frizbi' : (m.gateway_label || ''),
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
  const search = String(req.query.search || '').trim();
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || req.query.limit || '25', 10) || 25, 1), 500);
  const offset = (page - 1) * pageSize;
  const base = `
    SELECT m.*, k.label AS gateway_label, k.device_id AS device_id, g.name AS group_name,
      c.address_book_id AS campaign_book_id, ab.name AS campaign_book_name,
      acc.login AS creator_login,
      a.original_name AS attachment_name, a.opened_at AS attachment_opened_at, a.open_count AS attachment_open_count
    FROM messages m
    LEFT JOIN keys k ON k.id = m.claimed_by
    LEFT JOIN attachments a ON a.id = m.attachment_id
    LEFT JOIN accounts acc ON acc.id = m.created_by
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
  if (search) {
    cond.push('m.recipient LIKE ?');
    params.push(`%${search}%`);
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
  const total = db.prepare(`SELECT COUNT(*) AS c FROM messages m ${where}`).get(...params).c;
  const rows = db.prepare(`${base} ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);
  res.json({ items: rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
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

webApp.post('/admin/api/messages', async (req, res) => {
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
  const provider = decideSmsProvider(1);
  const claimedBy = provider === 'internal' ? assignGateway(recipient) : null;
  const status = sched ? 'scheduled' : 'pending';
  const scheduledAt = sched ? sched.scheduledAt : null;
  const createdAt = isoNow();
  const info = db.prepare(
    'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_by, created_by_label, created_at, group_id, scheduled_at, provider, claimed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(recipient, withAttachment.body, status, 'console', 'Console', withAttachment.attachment ? withAttachment.attachment.id : null, req.session.accountId, req.session.login, createdAt, groupId, scheduledAt, provider, claimedBy);
  let finalStatus = status;
  if (!sched && provider === 'frizbi') {
    await dispatchFrizbiBatch([{ messageId: info.lastInsertRowid, recipient, body: withAttachment.body }], { title: 'Ville d’Ivry' });
    finalStatus = db.prepare('SELECT status FROM messages WHERE id = ?').get(info.lastInsertRowid).status;
  }
  logConsole(req, 'envoi', null, 1);
  res.status(201).json({
    id: info.lastInsertRowid,
    recipient,
    message: withAttachment.body,
    status: finalStatus,
    provider,
    createdAt,
    attachment: withAttachment.attachment
      ? { id: withAttachment.attachment.id, name: withAttachment.attachment.original_name, url: publicAttachmentUrl(req, withAttachment.attachment.token) }
      : null
  });
});

webApp.post('/admin/api/messages/import', requireAdmin, async (req, res) => {
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
  const provider = decideSmsProvider(toInsert.length);
  const insert = db.prepare(
    'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_by, created_by_label, created_at, group_id, provider, claimed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let created = 0;
  let unassignedCount = 0;
  const dispatchEntries = [];
  if (toInsert.length) {
    db.exec('BEGIN');
    try {
      for (const [recipient, message] of toInsert) {
        const claimedBy = provider === 'internal' ? assignGateway(recipient) : null;
        if (provider === 'internal' && claimedBy == null) unassignedCount++;
        const msgInfo = insert.run(recipient, message, 'pending', 'console', 'Console', null, req.session.accountId, req.session.login, createdAt, groupId, provider, claimedBy);
        dispatchEntries.push({ messageId: msgInfo.lastInsertRowid, recipient, body: message });
        created++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  if (created > 0 && provider === 'frizbi') {
    await dispatchFrizbiBatch(dispatchEntries, { title: 'Ville d’Ivry' });
  }
  if (created > 0) logConsole(req, 'import', `${toInsert.length} ligne(s) lue(s)`, created);
  res.status(201).json({
    rows: input.length, duplicates, invalid, created,
    quotaWarning: unassignedCount > 0
      ? `${unassignedCount} destinataire(s) sans passerelle disponible sous le quota configuré.`
      : null
  });
});

webApp.get('/admin/api/console-logs', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT id, login, role, action, detail, count, ip, user_agent, created_at
    FROM console_logs
    ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

// ---------- Configuration sécurité : numéro admin pour les alertes SMS ----------
webApp.get('/admin/api/security', requireAdmin, (_req, res) => {
  res.json({
    adminPhone: getAdminPhone(),
    alertThreshold: BRUTE_FORCE_ALERT_THRESHOLD
  });
});

webApp.post('/admin/api/security/phone', requireAdmin, (req, res) => {
  const phone = String((req.body || {}).phone || '').trim();
  if (phone !== '' && !/^\+?[0-9]{4,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  setAdminPhone(phone);
  logConsole(req, 'config sécurité', 'Numéro d\'alerte admin mis à jour');
  res.json({ ok: true, adminPhone: getAdminPhone() });
});

// ---------- Configuration Frizbi (SMS externe) ----------
webApp.get('/admin/api/frizbi-settings', requireAdmin, (_req, res) => {
  const s = getFrizbiSettings();
  res.json({ ...s, client_secret: s.client_secret ? '••••••••' : '' });
});

webApp.post('/admin/api/frizbi-settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  const mode = ['internal', 'frizbi', 'both'].includes(body.mode) ? body.mode : 'internal';
  const bothThreshold = Math.max(1, parseInt(body.bothThreshold, 10) || 10);
  const apiUrl = String(body.apiUrl || '').trim();
  const clientId = String(body.clientId || '').trim();
  const senderId = String(body.senderId || '').trim().slice(0, 11) || 'IVRY';
  if ((mode === 'frizbi' || mode === 'both') && (!apiUrl || !clientId)) {
    return res.status(400).json({ error: 'URL de l’API et Client ID requis pour activer Frizbi' });
  }
  const existing = db.prepare('SELECT client_secret FROM frizbi_settings WHERE id = 1').get();
  const rawSecret = body.clientSecret;
  const clientSecret = (rawSecret === '••••••••' || rawSecret === undefined) && existing
    ? existing.client_secret
    : String(rawSecret || '');
  db.prepare(`
    UPDATE frizbi_settings
    SET mode = ?, both_threshold = ?, api_url = ?, client_id = ?, client_secret = ?, sender_id = ?, updated_at = ?
    WHERE id = 1
  `).run(mode, bothThreshold, apiUrl, clientId, clientSecret, senderId, isoNow());
  logConsole(req, 'config Frizbi', `mode=${mode} seuil=${bothThreshold}`);
  res.json({ ok: true });
});

webApp.post('/admin/api/frizbi/test-connection', requireAdmin, async (req, res) => {
  try {
    const existing = db.prepare('SELECT client_secret FROM frizbi_settings WHERE id = 1').get();
    const body = req.body || {};
    const clientSecret = (body.clientSecret === '••••••••' || !body.clientSecret) && existing
      ? existing.client_secret
      : body.clientSecret;
    const token = await frizbi.frizbiLogin({
      api_url: String(body.apiUrl || '').trim(),
      client_id: String(body.clientId || '').trim(),
      client_secret: clientSecret
    });
    res.json({ success: !!token, message: 'Connexion à Frizbi réussie' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

webApp.post('/admin/api/frizbi/send-test', requireAdmin, async (req, res) => {
  const mobile = normalizePhone(String((req.body || {}).mobile || ''));
  if (!/^\+?[0-9]{4,15}$/.test(mobile)) return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  const settings = getFrizbiSettings();
  if (!settings.api_url || !settings.client_id || !settings.client_secret) {
    return res.status(400).json({ error: 'Paramètres Frizbi incomplets' });
  }
  try {
    await frizbi.frizbiSend(settings, {
      title: 'Test',
      message: 'Ceci est un SMS de test envoyé depuis la passerelle SMS (Frizbi).',
      contacts: [{ id: 'test', mobile, firstName: 'Test', lastName: '' }]
    });
    logConsole(req, 'test Frizbi', mobile);
    res.json({ success: true, message: 'SMS de test envoyé avec succès' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Journal des callbacks/interrogations de statut Frizbi reçus — permet
// d'observer le format réel des données envoyées par Frizbi (non détaillé
// dans la doc V2.3) et de vérifier que les statuts sont bien appliqués.
webApp.get('/admin/api/frizbi/events', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT e.*, m.recipient, m.status AS message_status
    FROM frizbi_events e LEFT JOIN messages m ON m.id = e.message_id
    ORDER BY e.id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

// ---------- Mail → SMS (admin) ----------
function mail2smsBoxFromBody(body, isCreate) {
  const b = body || {};
  const out = {
    name: String(b.name || '').trim(),
    email: String(b.email || '').trim().toLowerCase(),
    imap_host: String(b.imapHost || '').trim(),
    imap_port: parseInt(b.imapPort, 10) || 993,
    imap_secure: b.imapSecure === false ? 0 : 1,
    imap_folder: String(b.imapFolder || '').trim() || 'INBOX',
    login: String(b.login || '').trim(),
    allowed_senders: String(b.allowedSenders || '').trim(),
    reply_enabled: b.replyEnabled === false ? 0 : 1,
    reply_delay_min: Math.max(1, parseInt(b.replyDelayMin, 10) || 5),
    reply_subject: String(b.replySubject || '').trim() || 'Re: ',
    smtp_host: String(b.smtpHost || '').trim() || null,
    smtp_port: parseInt(b.smtpPort, 10) || null,
    smtp_secure: b.smtpSecure === false ? 0 : 1,
    smtp_login: String(b.smtpLogin || '').trim() || null,
    scan_interval_sec: Math.max(10, parseInt(b.scanIntervalSec, 10) || 60),
    processed_folder: String(b.processedFolder || '').trim() || 'SMS Traités',
    active: b.active === false ? 0 : 1
  };
  if (b.password !== undefined) out.password = String(b.password);
  if (b.smtpPassword !== undefined) out.smtp_password = String(b.smtpPassword);
  if (isCreate) {
    if (!out.password) out.password = '';
    if (out.smtp_password === undefined) out.smtp_password = '';
  }
  return out;
}

function mail2smsValidation(out, isCreate) {
  if (!out.name) return 'Nom de la boîte requis';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) return 'Adresse e-mail de la boîte invalide';
  if (!/^\S+$/.test(out.imap_host)) return 'Serveur IMAP requis (ex : imap.gmail.com)';
  if (!out.login) return 'Identifiant de connexion requis';
  if (isCreate && !out.password) return 'Mot de passe ou clé d\'application requis';
  if (!out.allowed_senders) return 'Indiquez au moins un motif d\'expéditeur autorisé (ex : m*@ivry94.fr)';
  return null;
}

const mail2smsBoxSelect = `
  SELECT id, name, email, imap_host, imap_port, imap_secure, imap_folder, login,
    allowed_senders, reply_enabled, reply_delay_min, reply_subject,
    smtp_host, smtp_port, smtp_secure, smtp_login,
    scan_interval_sec, processed_folder, active, last_scan_at, last_status, last_error, created_at,
    CASE WHEN password IS NOT NULL AND password <> '' THEN 1 ELSE 0 END AS has_password,
    CASE WHEN smtp_password IS NOT NULL AND smtp_password <> '' THEN 1 ELSE 0 END AS has_smtp_password
  FROM mail2sms_boxes
`;

webApp.get('/admin/api/mail2sms', requireAdmin, (_req, res) => {
  const boxes = db.prepare(`${mail2smsBoxSelect} ORDER BY id ASC`).all();
  const emails = db.prepare(`
    SELECT e.id, e.box_id, b.name AS box_name, e.message_uid, e.from_addr, e.subject,
      e.received_at, e.processed_at, e.status, e.error, e.recipient_count, e.message_count,
      e.reply_attempts, e.reply_sent_at, e.reply_error
    FROM mail2sms_emails e JOIN mail2sms_boxes b ON b.id = e.box_id
    ORDER BY e.id DESC LIMIT 50
  `).all();
  res.json({ boxes, emails });
});

webApp.post('/admin/api/mail2sms', requireAdmin, (req, res) => {
  const box = mail2smsBoxFromBody(req.body, true);
  const error = mail2smsValidation(box, true);
  if (error) return res.status(400).json({ error });
  const info = db.prepare(`
    INSERT INTO mail2sms_boxes
      (name, email, imap_host, imap_port, imap_secure, imap_folder, login, password,
       allowed_senders, reply_enabled, reply_delay_min, reply_subject,
       smtp_host, smtp_port, smtp_secure, smtp_login, smtp_password,
       scan_interval_sec, processed_folder, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    box.name, box.email, box.imap_host, box.imap_port, box.imap_secure, box.imap_folder, box.login, box.password,
    box.allowed_senders, box.reply_enabled, box.reply_delay_min, box.reply_subject,
    box.smtp_host, box.smtp_port, box.smtp_secure, box.smtp_login, box.smtp_password,
    box.scan_interval_sec, box.processed_folder, box.active, isoNow()
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

webApp.patch('/admin/api/mail2sms/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM mail2sms_boxes WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Boîte mail2sms introuvable' });
  const box = mail2smsBoxFromBody(req.body, false);
  // Mot de passe vide = conserve l'actuel
  if (box.password === '') delete box.password;
  if (box.smtp_password === '') delete box.smtp_password;
  const error = mail2smsValidation({ ...existing, ...box }, false);
  if (error) return res.status(400).json({ error });
  const sets = [];
  const params = [];
  for (const key of ['name', 'email', 'imap_host', 'imap_port', 'imap_secure', 'imap_folder', 'login',
    'password', 'allowed_senders', 'reply_enabled', 'reply_delay_min', 'reply_subject',
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_login', 'smtp_password',
    'scan_interval_sec', 'processed_folder', 'active']) {
    if (!(key in box)) continue;
    sets.push(`${key} = ?`);
    params.push(box[key]);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Aucune modification demandée' });
  params.push(id);
  db.prepare(`UPDATE mail2sms_boxes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

webApp.delete('/admin/api/mail2sms/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM mail2sms_boxes WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Boîte mail2sms introuvable' });
  db.prepare('DELETE FROM mail2sms_emails WHERE box_id = ?').run(id);
  res.json({ ok: true });
});

webApp.post('/admin/api/mail2sms/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await mail2sms.testBox(Number(req.params.id));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: `Connexion IMAP impossible : ${err.message}` });
  }
});

webApp.post('/admin/api/mail2sms/:id/scan', requireAdmin, (req, res) => {
  try {
    // Le relevé s'exécute en arrière-plan : la requête répond immédiatement
    // (pas de timeout 504 du proxy) et le JS suit la progression via
    // GET /admin/api/mail2sms/:id/scan-status.
    const job = mail2sms.startScanJob(Number(req.params.id));
    res.json({ ok: true, ...job });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

webApp.get('/admin/api/mail2sms/:id/scan-status', requireAdmin, (req, res) => {
  const job = mail2sms.getScanJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Aucun relevé en cours ou terminé pour cette boîte' });
  res.json(job);
});

webApp.post('/admin/api/mail2sms/scan-all', requireAdmin, (req, res) => {
  try {
    mail2sms.startScanAll();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

webApp.post('/admin/api/mail2sms/:id/test-smtp', requireAdmin, async (req, res) => {
  try {
    const result = await mail2sms.testSmtp(Number(req.params.id));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

webApp.post('/admin/api/mail2sms/:id/retry-reply/:emailId', requireAdmin, (req, res) => {
  const info = db.prepare(
    'UPDATE mail2sms_emails SET reply_attempts = 0, reply_error = NULL WHERE id = ? AND box_id = ?'
  ).run(Number(req.params.emailId), Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Compte-rendu introuvable' });
  mail2sms.sendPendingReplies().catch(() => {});
  res.json({ ok: true });
});

// ---------- Synchronisation de carnets (admin) ----------
const REMOTE_TIMEOUT_MS = 15000;
const syncRunning = { active: false };

function normalizeSourceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// Lecture directe en base (utilisée quand la source est cette instance) :
// mêmes données que les routes /api/v1/books.
function listRemoteBooksLocal() {
  return db.prepare(`
    SELECT ab.id, ab.name, ab.group_id, ab.created_at, g.name AS group_name,
      (SELECT COUNT(*) FROM contacts c WHERE c.address_book_id = ab.id) AS contact_count
    FROM address_books ab LEFT JOIN groups g ON g.id = ab.group_id
    ORDER BY ab.id ASC
  `).all();
}

function getRemoteBookContactsLocal(id) {
  const book = db.prepare('SELECT * FROM address_books WHERE id = ?').get(Number(id));
  if (!book) return null;
  const group = book.group_id ? db.prepare('SELECT name FROM groups WHERE id = ?').get(book.group_id) : null;
  const contacts = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.entity, c.service, c.direction, c.imei, c.puk, c.line_status, c.plan, c.device_terminal, c.secondary_line, c.phone
    FROM contacts c WHERE c.address_book_id = ? ORDER BY c.id ASC
  `).all(book.id);
  return {
    id: book.id,
    name: book.name,
    group_id: book.group_id,
    group_name: group ? group.name : null,
    contacts
  };
}

// Une source pointant sur cette même instance (URL en localhost / boucle
// locale sur un de nos ports) est servie directement en base, sans aller
// chercher sur le réseau — indispensable pour tester avec une seule
// passerelle, et indépendant de l'exposition du port API.
function isSelfInstance(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    const loopback = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '0.0.0.1'];
    return loopback.includes(host) && (port === PORT_API || port === PORT_WEB);
  } catch (_) {
    return false;
  }
}

async function fetchRemote(url, apiKey) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal
    });
    if (!res.ok) throw new Error(`Réponse HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readRemoteBooks(source) {
  if (isSelfInstance(source.url)) return listRemoteBooksLocal();
  const base = normalizeSourceUrl(source.url);
  const books = await fetchRemote(`${base}/api/v1/books`, source.api_key);
  if (!Array.isArray(books)) throw new Error('Réponse distante invalide');
  return books;
}

async function readRemoteBook(source, remoteBookId) {
  if (isSelfInstance(source.url)) {
    const data = getRemoteBookContactsLocal(remoteBookId);
    if (!data) throw new Error('Carnet distant introuvable');
    return data;
  }
  const base = normalizeSourceUrl(source.url);
  const data = await fetchRemote(`${base}/api/v1/books/${remoteBookId}/contacts`, source.api_key);
  if (!data || !Array.isArray(data.contacts)) throw new Error('Réponse distante invalide');
  return data;
}

// Synchronise un carnet distant : remplace entièrement le contenu du carnet
// local miroir. Crée le carnet local au besoin (groupe NULL = admin uniquement).
async function syncOneBook(syncBook) {
  const source = db.prepare('SELECT * FROM sync_sources WHERE id = ?').get(syncBook.source_id);
  if (!source) throw new Error('Source introuvable');
  const data = await readRemoteBook(source, syncBook.remote_book_id);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    let localBookId = syncBook.local_book_id;
    if (!localBookId) {
      const info = db.prepare(
        'INSERT INTO address_books (group_id, name, created_at) VALUES (NULL, ?, ?)'
      ).run(data.name || syncBook.remote_book_name, isoNow());
      localBookId = info.lastInsertRowid;
      db.prepare('UPDATE sync_books SET local_book_id = ? WHERE id = ?').run(localBookId, syncBook.id);
    }
    db.prepare('DELETE FROM contacts WHERE address_book_id = ?').run(localBookId);
    const insert = db.prepare(
      'INSERT INTO contacts (address_book_id, first_name, last_name, entity, service, direction, imei, puk, line_status, plan, device_terminal, secondary_line, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const now = isoNow();
    for (const c of data.contacts) {
      const phone = normalizePhone(c && c.phone);
      if (!/^\+?[0-9]{4,15}$/.test(phone)) continue;
      insert.run(
        localBookId,
        c.first_name || '', c.last_name || '', c.entity || '',
        c.service || '', c.direction || '', c.imei || '', c.puk || '',
        c.line_status || '', c.plan || '', c.device_terminal || '', c.secondary_line || '',
        phone, now
      );
      inserted++;
    }
    const nowIso = isoNow();
    db.prepare(`
      UPDATE sync_books SET
        remote_book_name = ?, last_synced_at = ?, last_status = 'ok', last_error = NULL
      WHERE id = ?
    `).run(data.name || syncBook.remote_book_name, nowIso, syncBook.id);
    db.prepare('UPDATE sync_sources SET last_synced_at = ?, last_status = ?, last_error = NULL WHERE id = ?')
      .run(nowIso, 'ok', source.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true, inserted };
}

// Tâche horaire : synchronise tous les carnets distants activés.
async function runScheduledSync() {
  if (syncRunning.active) return;
  syncRunning.active = true;
  try {
    const rows = db.prepare('SELECT * FROM sync_books').all();
    for (const row of rows) {
      try {
        await syncOneBook(row);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err).slice(0, 300);
        db.prepare("UPDATE sync_books SET last_status = 'error', last_error = ? WHERE id = ?").run(msg, row.id);
        db.prepare("UPDATE sync_sources SET last_status = 'error', last_error = ? WHERE id = ?").run(msg, row.source_id);
      }
    }
  } finally {
    syncRunning.active = false;
  }
}
setInterval(() => { runScheduledSync().catch(() => {}); }, 60 * 60 * 1000);
setTimeout(() => { runScheduledSync().catch(() => {}); }, 30 * 1000);

webApp.get('/admin/api/sync-sources', requireAdmin, (_req, res) => {
  const sources = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM sync_books sb WHERE sb.source_id = s.id) AS book_count
    FROM sync_sources s ORDER BY s.id ASC
  `).all();
  const books = db.prepare(`
    SELECT sb.*, ab.name AS local_book_name,
      (SELECT COUNT(*) FROM contacts c WHERE c.address_book_id = sb.local_book_id) AS contact_count
    FROM sync_books sb LEFT JOIN address_books ab ON ab.id = sb.local_book_id
    ORDER BY sb.id ASC
  `).all();
  res.json({ sources, books });
});

webApp.post('/admin/api/sync-sources', requireAdmin, (req, res) => {
  const label = String((req.body || {}).label || '').trim();
  const url = normalizeSourceUrl((req.body || {}).url);
  const apiKey = String((req.body || {}).apiKey || '').trim();
  if (!label) return res.status(400).json({ error: 'Libellé requis' });
  if (!/^https?:\/\/.+/.test(url)) return res.status(400).json({ error: 'URL invalide (http:// ou https:// attendu)' });
  if (!apiKey) return res.status(400).json({ error: 'Clé d’authentification requise' });
  const info = db.prepare('INSERT INTO sync_sources (label, url, api_key, created_at) VALUES (?, ?, ?, ?)')
    .run(label, url, apiKey, isoNow());
  res.status(201).json({ id: info.lastInsertRowid, label, url, created_at: isoNow(), book_count: 0 });
});

webApp.delete('/admin/api/sync-sources/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.exec('BEGIN');
  try {
    const syncBooks = db.prepare('SELECT * FROM sync_books WHERE source_id = ?').all(id);
    for (const sb of syncBooks) {
      if (sb.local_book_id) {
        db.prepare('DELETE FROM contacts WHERE address_book_id = ?').run(sb.local_book_id);
        db.prepare('DELETE FROM address_books WHERE id = ?').run(sb.local_book_id);
      }
    }
    db.prepare('DELETE FROM sync_books WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM sync_sources WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

webApp.post('/admin/api/sync-sources/:id/browse', requireAdmin, async (req, res) => {
  try {
    const source = db.prepare('SELECT * FROM sync_sources WHERE id = ?').get(Number(req.params.id));
    if (!source) return res.status(404).json({ error: 'Source introuvable' });
    const books = await readRemoteBooks(source);
    const synced = new Set(
      db.prepare('SELECT remote_book_id FROM sync_books WHERE source_id = ?').all(source.id).map((r) => r.remote_book_id)
    );
    res.json({
      sourceLabel: source.label,
      self: isSelfInstance(source.url),
      books: books.map((b) => ({
        id: b.id,
        name: b.name,
        group_name: b.group_name || (b.group_id != null ? `Groupe #${b.group_id}` : 'Sans groupe'),
        contact_count: b.contact_count || 0,
        synced: synced.has(b.id)
      }))
    });
  } catch (err) {
    res.status(502).json({ error: `Impossible de joindre l'instance distante : ${err.message}` });
  }
});

webApp.post('/admin/api/sync-sources/:id/test', requireAdmin, async (req, res) => {
  const source = db.prepare('SELECT * FROM sync_sources WHERE id = ?').get(Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'Source introuvable' });
  if (isSelfInstance(source.url)) {
    const books = listRemoteBooksLocal();
    return res.json({
      ok: true,
      self: true,
      message: `Instance locale détectée — connexion OK (${books.length} carnet(s) disponible(s), ${books.reduce((sum, b) => sum + (b.contact_count || 0), 0)} contact(s)).`
    });
  }
  try {
    const health = await fetchRemote(`${normalizeSourceUrl(source.url)}/health`, source.api_key);
    if (!health || health.ok !== true) {
      return res.status(502).json({ error: 'Passerelle joignable mais réponse inattendue' });
    }
    const books = await readRemoteBooks(source);
    res.json({
      ok: true,
      self: false,
      message: `Connexion OK — ${books.length} carnet(s) disponible(s), ${books.reduce((sum, b) => sum + (b.contact_count || 0), 0)} contact(s).`
    });
  } catch (err) {
    res.status(502).json({ error: `Passerelle distante injoignable : ${err.message}` });
  }
});

webApp.post('/admin/api/sync-sources/:id/books', requireAdmin, async (req, res) => {
  const source = db.prepare('SELECT * FROM sync_sources WHERE id = ?').get(Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'Source introuvable' });
  const bookIds = Array.isArray(req.body.bookIds)
    ? req.body.bookIds.map(Number).filter(Number.isInteger)
    : [];
  if (!bookIds.length) return res.status(400).json({ error: 'Sélectionnez au moins un carnet' });
  const results = [];
  for (const remoteId of bookIds) {
    const existing = db.prepare(
      'SELECT * FROM sync_books WHERE source_id = ? AND remote_book_id = ?'
    ).get(source.id, remoteId);
    if (existing) {
      results.push({ remoteId, created: false, localBookId: existing.local_book_id });
      continue;
    }
    let data;
    try {
      data = await readRemoteBook(source, remoteId);
    } catch (err) {
      return res.status(502).json({ error: `Carnet ${remoteId} injoignable : ${err.message}` });
    }
    let localBookId;
    db.exec('BEGIN');
    try {
      const name = data.name || `Carnet distant ${remoteId}`;
      const info = db.prepare('INSERT INTO address_books (group_id, name, created_at) VALUES (NULL, ?, ?)')
        .run(name, isoNow());
      localBookId = info.lastInsertRowid;
      const insert = db.prepare(
        'INSERT INTO contacts (address_book_id, first_name, last_name, entity, service, direction, imei, puk, line_status, plan, device_terminal, secondary_line, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const now = isoNow();
      let inserted = 0;
      for (const c of data.contacts) {
        const phone = normalizePhone(c && c.phone);
        if (!/^\+?[0-9]{4,15}$/.test(phone)) continue;
        insert.run(
          localBookId, c.first_name || '', c.last_name || '', c.entity || '',
          c.service || '', c.direction || '', c.imei || '', c.puk || '',
          c.line_status || '', c.plan || '', c.device_terminal || '', c.secondary_line || '',
          phone, now
        );
        inserted++;
      }
      db.prepare(`
        INSERT INTO sync_books (source_id, remote_book_id, remote_book_name, remote_group_id, remote_group_name, local_book_id, last_synced_at, last_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')
      `).run(source.id, remoteId, name, data.group_id || null, data.group_name || null, localBookId, isoNow());
      db.exec('COMMIT');
      results.push({ remoteId, created: true, localBookId, contacts: inserted });
    } catch (err) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: err.message });
    }
  }
  db.prepare('UPDATE sync_sources SET last_status = ?, last_error = NULL, last_synced_at = ? WHERE id = ?')
    .run('ok', isoNow(), source.id);
  res.status(201).json({ results });
});

webApp.post('/admin/api/sync-books/:id/run', requireAdmin, async (req, res) => {
  const syncBook = db.prepare('SELECT * FROM sync_books WHERE id = ?').get(Number(req.params.id));
  if (!syncBook) return res.status(404).json({ error: 'Synchronisation introuvable' });
  try {
    const result = await syncOneBook(syncBook);
    res.json({ ok: true, contacts: result.inserted });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).slice(0, 300);
    db.prepare("UPDATE sync_books SET last_status = 'error', last_error = ? WHERE id = ?").run(msg, syncBook.id);
    res.status(502).json({ error: msg });
  }
});

webApp.delete('/admin/api/sync-books/:id', requireAdmin, (req, res) => {
  const syncBook = db.prepare('SELECT * FROM sync_books WHERE id = ?').get(Number(req.params.id));
  if (!syncBook) return res.status(404).json({ error: 'Synchronisation introuvable' });
  db.exec('BEGIN');
  try {
    if (syncBook.local_book_id) {
      db.prepare('DELETE FROM contacts WHERE address_book_id = ?').run(syncBook.local_book_id);
      db.prepare('DELETE FROM address_books WHERE id = ?').run(syncBook.local_book_id);
    }
    db.prepare('DELETE FROM sync_books WHERE id = ?').run(syncBook.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
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
  a.id, a.login, a.role, a.group_id, a.email, a.is_group_manager, a.disabled, a.created_at, a.last_login_at,
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
    db.prepare('UPDATE web_sessions SET group_id = ? WHERE sid = ?')
      .run(req.session.groupId, parseCookies(req).sid);
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
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || req.query.limit || '500', 10) || 500, 1), 2000);
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.entity, c.service, c.direction, c.imei, c.puk, c.line_status, c.plan, c.device_terminal, c.secondary_line, c.phone, c.created_at,
      CASE WHEN b.phone IS NULL THEN 0 ELSE 1 END AS blacklisted,
      CASE WHEN x.phone IS NULL THEN 0 ELSE 1 END AS mass_excluded
    FROM contacts c
    LEFT JOIN blacklist_numbers b ON b.phone = c.phone
    LEFT JOIN mass_exclusions x ON x.phone = c.phone
    WHERE c.address_book_id = ? ORDER BY c.id ASC LIMIT ? OFFSET ?
  `).all(checked.book.id, pageSize, offset);
  const total = db.prepare('SELECT COUNT(*) c FROM contacts WHERE address_book_id = ?').get(checked.book.id).c;
  res.set('X-Total-Count', total);
  res.set('X-Page-Size', pageSize);
  res.json(rows);
});

webApp.post('/admin/api/address-books/:bookId/contacts', (req, res) => {
  const checked = requireGroupBook(req, res);
  if (checked.error) return res.status(404).json({ error: checked.error });
  const first = String((req.body || {}).firstName || '').trim();
  const last = String((req.body || {}).lastName || '').trim();
  const entity = String((req.body || {}).entity || '').trim();
  const service = String((req.body || {}).service || '').trim();
  const direction = String((req.body || {}).direction || '').trim();
  const imei = String((req.body || {}).imei || '').trim();
  const puk = String((req.body || {}).puk || '').trim();
  const lineStatus = String((req.body || {}).lineStatus || '').trim();
  const plan = String((req.body || {}).plan || '').trim();
  const deviceTerminal = String((req.body || {}).deviceTerminal || '').trim();
  const secondaryLine = String((req.body || {}).secondaryLine || '').trim();
  const phone = normalizePhone((req.body || {}).phone || '');
  if (!/^\+?[0-9]{4,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (!first && !last && !entity) {
    return res.status(400).json({ error: 'Prénom, nom ou entité requis' });
  }
  const info = db.prepare(
    'INSERT INTO contacts (address_book_id, first_name, last_name, entity, service, direction, imei, puk, line_status, plan, device_terminal, secondary_line, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(checked.book.id, first, last, entity, service, direction, imei, puk, lineStatus, plan, deviceTerminal, secondaryLine, phone, isoNow());
  res.status(201).json({ id: info.lastInsertRowid, first_name: first, last_name: last, entity, service, direction, imei, puk, line_status: lineStatus, plan, device_terminal: deviceTerminal, secondary_line: secondaryLine, phone, created_at: isoNow() });
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
  const service = String(body.service !== undefined ? body.service : contact.service || '').trim();
  const direction = String(body.direction !== undefined ? body.direction : contact.direction || '').trim();
  const imei = String(body.imei !== undefined ? body.imei : contact.imei || '').trim();
  const puk = String(body.puk !== undefined ? body.puk : contact.puk || '').trim();
  const lineStatus = String(body.lineStatus !== undefined ? body.lineStatus : contact.line_status || '').trim();
  const plan = String(body.plan !== undefined ? body.plan : contact.plan || '').trim();
  const deviceTerminal = String(body.deviceTerminal !== undefined ? body.deviceTerminal : contact.device_terminal || '').trim();
  const secondaryLine = String(body.secondaryLine !== undefined ? body.secondaryLine : contact.secondary_line || '').trim();
  const phone = normalizePhone(body.phone !== undefined ? body.phone : contact.phone);
  if (!/^\+?[0-9]{4,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }
  if (!first && !last && !entity) {
    return res.status(400).json({ error: 'Prénom, nom ou entité requis' });
  }
  db.prepare(
    'UPDATE contacts SET first_name = ?, last_name = ?, entity = ?, service = ?, direction = ?, imei = ?, puk = ?, line_status = ?, plan = ?, device_terminal = ?, secondary_line = ?, phone = ? WHERE id = ?'
  ).run(first, last, entity, service, direction, imei, puk, lineStatus, plan, deviceTerminal, secondaryLine, phone, contact.id);
  res.json({ ok: true, id: contact.id, first_name: first, last_name: last, entity, service, direction, imei, puk, line_status: lineStatus, plan, device_terminal: deviceTerminal, secondary_line: secondaryLine, phone });
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
    service: String(mp.service !== undefined ? mp.service : (body.service || '')),
    direction: String(mp.direction !== undefined ? mp.direction : (body.direction || '')),
    imei: String(mp.imei !== undefined ? mp.imei : (body.imei || '')),
    puk: String(mp.puk !== undefined ? mp.puk : (body.puk || '')),
    lineStatus: String(mp.lineStatus !== undefined ? mp.lineStatus : (body.lineStatus || '')),
    plan: String(mp.plan !== undefined ? mp.plan : (body.plan || '')),
    deviceTerminal: String(mp.deviceTerminal !== undefined ? mp.deviceTerminal : (body.deviceTerminal || '')),
    secondaryLine: String(mp.secondaryLine !== undefined ? mp.secondaryLine : (body.secondaryLine || '')),
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
  const si = idx(map.service);
  const di = idx(map.direction);
  const ii = idx(map.imei);
  const pi = idx(map.puk);
  const lsi = idx(map.lineStatus);
  const pli = idx(map.plan);
  const dti = idx(map.deviceTerminal);
  const sli = idx(map.secondaryLine);

  const invalid = [];
  const toInsert = [];
  const seen = new Set();
  for (let r = 0; r < rows.length; r++) {
    const raw = Array.isArray(rows[r]) ? rows[r] : [];
    const phone = normalizePhone(raw[phoneIdx] == null ? '' : raw[phoneIdx]);
    const first = fi >= 0 ? String(raw[fi] == null ? '' : raw[fi]).trim() : '';
    const last = li >= 0 ? String(raw[li] == null ? '' : raw[li]).trim() : '';
    const entity = ei >= 0 ? String(raw[ei] == null ? '' : raw[ei]).trim() : '';
    const service = si >= 0 ? String(raw[si] == null ? '' : raw[si]).trim() : '';
    const direction = di >= 0 ? String(raw[di] == null ? '' : raw[di]).trim() : '';
    const imei = ii >= 0 ? String(raw[ii] == null ? '' : raw[ii]).trim() : '';
    const puk = pi >= 0 ? String(raw[pi] == null ? '' : raw[pi]).trim() : '';
    const lineStatus = lsi >= 0 ? String(raw[lsi] == null ? '' : raw[lsi]).trim() : '';
    const plan = pli >= 0 ? String(raw[pli] == null ? '' : raw[pli]).trim() : '';
    const deviceTerminal = dti >= 0 ? String(raw[dti] == null ? '' : raw[dti]).trim() : '';
    const secondaryLine = sli >= 0 ? String(raw[sli] == null ? '' : raw[sli]).trim() : '';
    if (!/^\+?[0-9]{4,15}$/.test(phone)) {
      invalid.push({ row: r + 2, phone, error: 'Numéro invalide' });
      continue;
    }
    const key = phone;
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push({ first, last, entity, service, direction, imei, puk, lineStatus, plan, deviceTerminal, secondaryLine, phone });
  }

  const bookId = checked.book.id;
  const blacklisted = toInsert.filter((contact) => isBlacklisted(contact.phone)).length;
  const overwrite = body.overwrite === true;
  const replaced = overwrite
    ? db.prepare('DELETE FROM contacts WHERE address_book_id = ?').run(bookId).changes
    : 0;
  const insert = db.prepare(
    'INSERT INTO contacts (address_book_id, first_name, last_name, entity, service, direction, imei, puk, line_status, plan, device_terminal, secondary_line, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const createdAt = isoNow();
  db.exec('BEGIN');
  try {
    for (const c of toInsert) {
      insert.run(bookId, c.first, c.last, c.entity, c.service, c.direction, c.imei, c.puk, c.lineStatus, c.plan, c.deviceTerminal, c.secondaryLine, c.phone, createdAt);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.status(201).json({
    rows: rows.length,
    created: toInsert.length,
    blacklisted,
    duplicates: rows.length - toInsert.length - invalid.length,
    invalid,
    replaced
  });
});

// Envoi vers un carnet d'adresses : crée une « campagne » (une entrée
// groupée dans le journal, nommée d'après le carnet) et un message par
// contact sélectionné, rattaché à la campagne et au groupe du carnet.
webApp.post('/admin/api/campaigns', async (req, res) => {
  const body = req.body || {};
  const bookId = Number(body.bookId);
  const excludeBookId = Number(body.excludeBookId) || 0;
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
  let excludedPhones = new Set();
  if (excludeBookId) {
    const excludeBook = db.prepare('SELECT * FROM address_books WHERE id = ?').get(excludeBookId);
    if (!excludeBook || (req.session.role !== 'admin' && excludeBook.group_id !== req.session.groupId)) {
      return res.status(404).json({ error: 'Carnet d’exclusion introuvable' });
    }
    excludedPhones = new Set(db.prepare('SELECT phone FROM contacts WHERE address_book_id = ?').all(excludeBookId).map((row) => row.phone));
  }
  if (body.excludeEventType && body.excludeEventId) {
    const eventPhones = resolveEventPhones(req, body.excludeEventType, Number(body.excludeEventId), String(body.excludeEventState || '') || null);
    if (eventPhones === null) return res.status(404).json({ error: 'Envoi précédent (à exclure) introuvable' });
    eventPhones.forEach((phone) => excludedPhones.add(phone));
  }
  const name = String(body.name || '').trim().slice(0, 120) || null;
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
  ).all(bookId, ...contactIds).filter((contact) => !excludedPhones.has(contact.phone));
  if (contacts.length === 0) {
    return res.status(400).json({ error: 'Aucun destinataire valide dans ce carnet' });
  }
  const blocked = contacts.filter((contact) => isBlacklisted(contact.phone));
  if (blocked.length) {
    return res.status(400).json({ error: `Envoi impossible : ${blocked.map((contact) => contact.phone).join(', ')} est/sont blacklisté(s)` });
  }
  const provider = decideSmsProvider(contacts.length);
  const status = sched ? 'scheduled' : 'pending';
  const scheduledAt = sched ? sched.scheduledAt : null;
  const createdAt = isoNow();
  const groupId = book.group_id;
  let campaignId;
  const clonedAttachmentPaths = [];
  const dispatchEntries = [];
  let unassignedCount = 0;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      'INSERT INTO campaigns (address_book_id, group_id, body, created_by, scheduled_at, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(bookId, groupId, message, req.session.accountId, scheduledAt, createdAt, name);
    campaignId = info.lastInsertRowid;
    const insert = db.prepare(
      'INSERT INTO messages (recipient, body, status, origin, origin_label, attachment_id, created_by, created_by_label, created_at, group_id, campaign_id, scheduled_at, provider, claimed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const c of contacts) {
      const renderedMessage = renderContactBody(message, c);
      if (renderedMessage.length > MAX_MESSAGE_LENGTH) {
        db.exec('ROLLBACK');
        return res.status(400).json({ error: `Message trop long pour ${c.phone} après remplacement des variables (max ${MAX_MESSAGE_LENGTH} caractères)` });
      }
      const claimedBy = provider === 'internal' ? assignGateway(c.phone) : null;
      if (provider === 'internal' && claimedBy == null) unassignedCount++;
      let messageBody = renderedMessage;
      let attachmentId = null;
      if (withAttachment.attachment) {
        const copy = cloneAttachment(withAttachment.attachment);
        clonedAttachmentPaths.push(copy.path);
        attachmentId = copy.id;
        messageBody = `${renderedMessage}\n\nPièce jointe : ${publicAttachmentUrl(req, copy.token)}`;
      }
      const msgInfo = insert.run(c.phone, messageBody, status, 'console', 'Console', attachmentId, req.session.accountId, req.session.login, createdAt, groupId, campaignId, scheduledAt, provider, claimedBy);
      dispatchEntries.push({ messageId: msgInfo.lastInsertRowid, recipient: c.phone, body: messageBody, firstName: c.first_name, lastName: c.last_name });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    for (const filePath of clonedAttachmentPaths) fs.rmSync(filePath, { force: true });
    throw err;
  }
  if (!sched && provider === 'frizbi') {
    await dispatchFrizbiBatch(dispatchEntries, { title: book.name });
  }
  logConsole(req, 'campagne', book.name, contacts.length);
  res.status(201).json({
    id: campaignId, bookName: book.name, name, count: contacts.length, status, provider,
    quotaWarning: unassignedCount > 0
      ? `${unassignedCount} destinataire(s) sans passerelle disponible sous le quota configuré : mis en file sans garantie de répartition.`
      : null
  });
});

webApp.get('/admin/api/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, ab.name AS book_name, acc.login AS creator_login,
      COUNT(m.id) AS total,
      SUM(CASE WHEN m.status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN m.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN m.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM campaigns c
    LEFT JOIN address_books ab ON ab.id = c.address_book_id
    LEFT JOIN accounts acc ON acc.id = c.created_by
    LEFT JOIN messages m ON m.campaign_id = c.id
    WHERE c.deleted_at IS NULL ${req.session.role === 'admin' ? '' : 'AND c.group_id = ?'}
    GROUP BY c.id ORDER BY c.id DESC
  `).all(...(req.session.role === 'admin' ? [] : [req.session.groupId]));
  res.json(campaigns);
});

function campaignVisible(req, id) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!campaign) return null;
  if (req.session.role !== 'admin' && campaign.group_id !== req.session.groupId) return null;
  return campaign;
}

// Détail paginé d'une campagne : ses messages, page par page (contrairement
// à la vérification de flotte, dont le détail reste chargé en une fois).
webApp.get('/admin/api/campaigns/:id', (req, res) => {
  const campaign = campaignVisible(req, req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10) || 25, 1), 500);
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const offset = (page - 1) * pageSize;
  const total = db.prepare('SELECT COUNT(*) c FROM messages WHERE campaign_id = ?').get(campaign.id).c;
  const messages = db.prepare(`
    SELECT m.*, k.label AS gateway_label
    FROM messages m LEFT JOIN keys k ON k.id = m.claimed_by
    WHERE m.campaign_id = ? ORDER BY m.id ASC LIMIT ? OFFSET ?
  `).all(campaign.id, pageSize, offset);
  const bookRow = db.prepare('SELECT name FROM address_books WHERE id = ?').get(campaign.address_book_id);
  res.json({ campaign: { ...campaign, book_name: bookRow ? bookRow.name : null }, messages, total, page, pageSize });
});

// Liste légère (numéro + statut) pour cibler ou exclure les destinataires
// d'une campagne précédente lors de la composition d'un nouvel envoi.
webApp.get('/admin/api/campaigns/:id/recipients', (req, res) => {
  const campaign = campaignVisible(req, req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  const state = String(req.query.state || '').trim();
  const rows = state
    ? db.prepare('SELECT recipient AS phone, status FROM messages WHERE campaign_id = ? AND status = ?').all(campaign.id, state)
    : db.prepare('SELECT recipient AS phone, status FROM messages WHERE campaign_id = ?').all(campaign.id);
  res.json({ recipients: rows });
});

webApp.patch('/admin/api/campaigns/:id', (req, res) => {
  const campaign = campaignVisible(req, req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  const name = String((req.body || {}).name || '').trim().slice(0, 120) || null;
  db.prepare('UPDATE campaigns SET name = ? WHERE id = ?').run(name, campaign.id);
  res.json({ ok: true, id: campaign.id, name });
});

webApp.delete('/admin/api/campaigns/:id', (req, res) => {
  const campaign = campaignVisible(req, req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  db.prepare('UPDATE campaigns SET deleted_at = ? WHERE id = ?').run(isoNow(), campaign.id);
  logConsole(req, 'suppression campagne', `#${campaign.id}`);
  res.json({ ok: true });
});

webApp.get('/admin/api/blacklist', (req, res) => {
  res.json(db.prepare('SELECT phone, created_at, created_by_label FROM blacklist_numbers ORDER BY phone ASC').all());
});

webApp.post('/admin/api/blacklist', (req, res) => {
  const phone = normalizePhone((req.body || {}).phone || '');
  if (!/^\+?[0-9]{4,15}$/.test(phone)) return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  db.prepare('INSERT OR IGNORE INTO blacklist_numbers (phone, created_at, created_by, created_by_label) VALUES (?, ?, ?, ?)')
    .run(phone, isoNow(), req.session.accountId, req.session.login);
  res.status(201).json({ phone, blacklisted: true });
});

webApp.delete('/admin/api/blacklist/:phone', (req, res) => {
  const phone = normalizePhone(req.params.phone);
  db.prepare('DELETE FROM blacklist_numbers WHERE phone = ?').run(phone);
  res.json({ phone, blacklisted: false });
});

// Numéros exclus par défaut des envois en masse (campagnes, vérifications de
// flotte) : contrairement à la liste noire, ce n'est pas un blocage, juste
// une pré-décoche dans les listes de destinataires — l'opérateur peut
// réinclure le numéro pour un envoi ponctuel.
webApp.get('/admin/api/mass-exclusions', (req, res) => {
  res.json(db.prepare('SELECT phone, created_at, created_by_label FROM mass_exclusions ORDER BY phone ASC').all());
});

webApp.post('/admin/api/mass-exclusions', (req, res) => {
  const phone = normalizePhone((req.body || {}).phone || '');
  if (!/^\+?[0-9]{4,15}$/.test(phone)) return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  db.prepare('INSERT OR IGNORE INTO mass_exclusions (phone, created_at, created_by, created_by_label) VALUES (?, ?, ?, ?)')
    .run(phone, isoNow(), req.session.accountId, req.session.login);
  res.status(201).json({ phone, massExcluded: true });
});

webApp.delete('/admin/api/mass-exclusions/:phone', (req, res) => {
  const phone = normalizePhone(req.params.phone);
  db.prepare('DELETE FROM mass_exclusions WHERE phone = ?').run(phone);
  res.json({ phone, massExcluded: false });
});

// Prévisualisation avant envoi (campagne ou vérification de flotte) :
// résout les mêmes filtres (carnet, exclusion carnet, exclusion par envoi
// précédent) que la création réelle, puis simule la répartition par
// passerelle/ligne et le temps d'envoi estimé — sans rien écrire en base.
webApp.post('/admin/api/send-preview', (req, res) => {
  const body = req.body || {};
  const bookId = Number(body.bookId);
  const excludeBookId = Number(body.excludeBookId) || 0;
  const contactIds = Array.isArray(body.contactIds) ? body.contactIds.map(Number).filter(Number.isInteger) : [];
  if (!bookId) return res.status(400).json({ error: 'Carnet d’adresses requis' });
  const book = db.prepare('SELECT * FROM address_books WHERE id = ?').get(bookId);
  if (!book || (req.session.role !== 'admin' && book.group_id !== req.session.groupId)) {
    return res.status(404).json({ error: 'Carnet introuvable' });
  }
  let excludedPhones = new Set();
  if (excludeBookId) {
    const excludeBook = db.prepare('SELECT * FROM address_books WHERE id = ?').get(excludeBookId);
    if (!excludeBook || (req.session.role !== 'admin' && excludeBook.group_id !== req.session.groupId)) {
      return res.status(404).json({ error: 'Carnet d’exclusion introuvable' });
    }
    excludedPhones = new Set(db.prepare('SELECT phone FROM contacts WHERE address_book_id = ?').all(excludeBookId).map((r) => r.phone));
  }
  if (body.excludeEventType && body.excludeEventId) {
    const eventPhones = resolveEventPhones(req, body.excludeEventType, Number(body.excludeEventId), String(body.excludeEventState || '') || null);
    if (eventPhones === null) return res.status(404).json({ error: 'Envoi précédent (à exclure) introuvable' });
    eventPhones.forEach((phone) => excludedPhones.add(phone));
  }
  const contactWhere = contactIds.length ? `AND id IN (${contactIds.map(() => '?').join(',')})` : '';
  const allContacts = db.prepare(`SELECT phone FROM contacts WHERE address_book_id = ? ${contactWhere}`)
    .all(bookId, ...contactIds);
  const nonExcluded = allContacts.filter((c) => !excludedPhones.has(c.phone));
  const blacklistedCount = nonExcluded.filter((c) => isBlacklisted(c.phone)).length;
  const phones = nonExcluded.filter((c) => !isBlacklisted(c.phone)).map((c) => c.phone);

  const sim = simulateAssignment(phones);
  const gwSettings = getGatewaySettings();
  const gateways = sim.gateways.map((g) => {
    const lineCounts = splitByLines(g.assigned, g.simCount);
    return {
      id: g.id,
      label: g.label,
      simCount: g.simCount,
      assigned: g.assigned,
      quotaBefore: g.quotaBefore,
      quotaAfter: g.quotaAfter,
      lines: lineCounts.map((count, i) => ({ index: i + 1, count, estimatedSeconds: estimateSendSeconds(count) })),
      estimatedSeconds: estimateSendSeconds(g.assigned)
    };
  });
  const estimatedTotalSeconds = gateways.length ? Math.max(...gateways.map((g) => g.estimatedSeconds)) : 0;
  res.json({
    totalPhones: phones.length,
    blacklistedCount,
    unassigned: sim.unassigned,
    gateways,
    estimatedTotalSeconds,
    quotaCap: gwSettings.quota_cap,
    quotaWindowDays: gwSettings.quota_window_days
  });
});

// NB : la vérification de flotte reste toujours en interne (passerelles),
// jamais routée vers Frizbi, quel que soit le mode/seuil configuré. Ce
// contrôle attend une RÉPONSE SMS du destinataire ; Frizbi envoie avec un
// sender_id alphanumérique (ex. « IVRY »), qui ne peut recevoir aucune
// réponse (limitation standard GSM, pas spécifique à Frizbi). Router ces
// messages vers Frizbi casserait donc silencieusement le suivi des réponses.
webApp.post('/admin/api/fleet-checks', (req, res) => {
  const body = req.body || {};
  const bookId = Number(body.bookId);
  const excludeBookId = Number(body.excludeBookId) || 0;
  const message = String(body.message || '').trim();
  const contactIds = Array.isArray(body.contactIds)
    ? body.contactIds.map(Number).filter(Number.isInteger)
    : [];
  if (!bookId) return res.status(400).json({ error: 'Carnet d’adresses requis' });
  if (!message) return res.status(400).json({ error: 'Message de vérification vide' });
  if (message.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: `Message trop long (max ${MAX_MESSAGE_LENGTH} caractères)` });
  const book = db.prepare('SELECT * FROM address_books WHERE id = ?').get(bookId);
  if (!book || (req.session.role !== 'admin' && book.group_id !== req.session.groupId)) {
    return res.status(404).json({ error: 'Carnet introuvable' });
  }
  let excludedPhones = new Set();
  if (excludeBookId) {
    const excludeBook = db.prepare('SELECT * FROM address_books WHERE id = ?').get(excludeBookId);
    if (!excludeBook || (req.session.role !== 'admin' && excludeBook.group_id !== req.session.groupId)) {
      return res.status(404).json({ error: 'Carnet d’exclusion introuvable' });
    }
    excludedPhones = new Set(db.prepare('SELECT phone FROM contacts WHERE address_book_id = ?').all(excludeBookId).map((row) => row.phone));
  }
  if (body.excludeEventType && body.excludeEventId) {
    const eventPhones = resolveEventPhones(req, body.excludeEventType, Number(body.excludeEventId), String(body.excludeEventState || '') || null);
    if (eventPhones === null) return res.status(404).json({ error: 'Envoi précédent (à exclure) introuvable' });
    eventPhones.forEach((phone) => excludedPhones.add(phone));
  }
  const name = String(body.name || '').trim().slice(0, 120) || null;
  const contactWhere = contactIds.length
    ? `AND id IN (${contactIds.map(() => '?').join(',')})`
    : '';
  const contacts = db.prepare(`SELECT * FROM contacts WHERE address_book_id = ? ${contactWhere} ORDER BY id ASC`)
    .all(bookId, ...contactIds).filter((contact) => !excludedPhones.has(contact.phone));
  if (!contacts.length) return res.status(400).json({ error: 'Aucun contact sélectionné' });
  const blocked = contacts.filter((contact) => isBlacklisted(contact.phone));
  if (blocked.length) {
    return res.status(400).json({ error: `Vérification impossible : ${blocked.map((contact) => contact.phone).join(', ')} est/sont blacklisté(s)` });
  }
  const createdAt = isoNow();
  let checkId;
  let unassignedCount = 0;
  db.exec('BEGIN');
  try {
    const check = db.prepare(`
      INSERT INTO fleet_checks (group_id, address_book_id, message, created_by, created_by_label, response_hours, created_at, name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(book.group_id, book.id, message, req.session.accountId, req.session.login, FLEET_RESPONSE_HOURS, createdAt, name);
    checkId = check.lastInsertRowid;
    const insertMessage = db.prepare(`
      INSERT INTO messages (recipient, body, status, origin, origin_label, created_by, created_by_label, fleet_check_id, created_at, group_id, claimed_by)
      VALUES (?, ?, 'pending', 'console', 'Console', ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO fleet_check_items
        (fleet_check_id, message_id, contact_id, first_name, last_name, entity, service, direction, imei, puk, line_status, plan, device_terminal, secondary_line, phone, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    for (const contact of contacts) {
      const renderedMessage = renderContactBody(message, contact);
      if (renderedMessage.length > MAX_MESSAGE_LENGTH) {
        db.exec('ROLLBACK');
        return res.status(400).json({ error: `Message trop long pour ${contact.phone} après remplacement des variables (max ${MAX_MESSAGE_LENGTH} caractères)` });
      }
      const claimedBy = assignGateway(contact.phone);
      if (claimedBy == null) unassignedCount++;
      const msg = insertMessage.run(
        contact.phone, renderedMessage, req.session.accountId, req.session.login, checkId, createdAt, book.group_id, claimedBy
      );
      insertItem.run(checkId, msg.lastInsertRowid, contact.id, contact.first_name, contact.last_name, contact.entity,
        contact.service, contact.direction, contact.imei, contact.puk, contact.line_status, contact.plan, contact.device_terminal, contact.secondary_line, contact.phone);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  logConsole(req, 'verif flotte', book.name, contacts.length);
  res.status(201).json({
    id: checkId, bookName: book.name, name, count: contacts.length, responseHours: FLEET_RESPONSE_HOURS, createdAt,
    quotaWarning: unassignedCount > 0
      ? `${unassignedCount} destinataire(s) sans passerelle disponible sous le quota configuré.`
      : null
  });
});

function fleetCheckVisible(req, id) {
  const check = db.prepare('SELECT * FROM fleet_checks WHERE id = ?').get(Number(id));
  if (!check) return null;
  if (req.session.role !== 'admin' && check.group_id !== req.session.groupId) return null;
  return check;
}

webApp.get('/admin/api/fleet-checks', (req, res) => {
  refreshFleetTimeouts();
  const checks = db.prepare(`
    SELECT f.*, ab.name AS book_name,
      COUNT(i.id) AS total,
      SUM(CASE WHEN i.state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN i.state = 'replied' THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN i.state = 'no_response' THEN 1 ELSE 0 END) AS no_response,
      SUM(CASE WHEN i.state = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM fleet_checks f
    LEFT JOIN address_books ab ON ab.id = f.address_book_id
    LEFT JOIN fleet_check_items i ON i.fleet_check_id = f.id
    WHERE f.deleted_at IS NULL ${req.session.role === 'admin' ? '' : 'AND f.group_id = ?'}
    GROUP BY f.id ORDER BY f.id DESC
  `).all(...(req.session.role === 'admin' ? [] : [req.session.groupId]));
  res.json(checks);
});

webApp.get('/admin/api/fleet-checks/:id', (req, res) => {
  const check = fleetCheckVisible(req, req.params.id);
  if (!check) return res.status(404).json({ error: 'Vérification introuvable' });
  refreshFleetTimeouts();
  const items = db.prepare(`
    SELECT i.*, m.status AS message_status, m.created_at AS message_created_at
    FROM fleet_check_items i JOIN messages m ON m.id = i.message_id
    WHERE i.fleet_check_id = ? ORDER BY i.id ASC
  `).all(check.id);
  res.json({ check, items });
});

// Liste légère (numéro + état) pour cibler ou exclure les destinataires
// d'une vérification précédente lors de la composition d'un nouvel envoi.
webApp.get('/admin/api/fleet-checks/:id/recipients', (req, res) => {
  const check = fleetCheckVisible(req, req.params.id);
  if (!check) return res.status(404).json({ error: 'Vérification introuvable' });
  const state = String(req.query.state || '').trim();
  const rows = state
    ? db.prepare('SELECT phone, state FROM fleet_check_items WHERE fleet_check_id = ? AND state = ?').all(check.id, state)
    : db.prepare('SELECT phone, state FROM fleet_check_items WHERE fleet_check_id = ?').all(check.id);
  res.json({ recipients: rows });
});

webApp.patch('/admin/api/fleet-checks/:id', (req, res) => {
  const check = fleetCheckVisible(req, req.params.id);
  if (!check) return res.status(404).json({ error: 'Vérification introuvable' });
  const name = String((req.body || {}).name || '').trim().slice(0, 120) || null;
  db.prepare('UPDATE fleet_checks SET name = ? WHERE id = ?').run(name, check.id);
  res.json({ ok: true, id: check.id, name });
});

webApp.delete('/admin/api/fleet-checks/:id', (req, res) => {
  const check = fleetCheckVisible(req, req.params.id);
  if (!check) return res.status(404).json({ error: 'Vérification introuvable' });
  db.prepare('UPDATE fleet_checks SET deleted_at = ? WHERE id = ?').run(isoNow(), check.id);
  logConsole(req, 'suppression vérification flotte', `#${check.id}`);
  res.json({ ok: true });
});

webApp.get('/admin/api/fleet-checks/:id/export', (req, res) => {
  const check = fleetCheckVisible(req, req.params.id);
  if (!check) return res.status(404).json({ error: 'Vérification introuvable' });
  refreshFleetTimeouts();
  const rows = db.prepare(`
    SELECT i.*, m.created_at AS message_created_at, m.sent_at AS message_sent_at,
      m.delivered_at AS message_delivered_at
    FROM fleet_check_items i JOIN messages m ON m.id = i.message_id
    WHERE i.fleet_check_id = ? ORDER BY i.id ASC
  `).all(check.id);
  const escCsv = (value) => {
    const text = value == null ? '' : String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Vérification', 'Carnet', 'Prénom', 'Nom', 'Entité', 'Service', 'Direction', 'IMEI', 'PUK', 'Statut ligne', 'Forfait', 'Terminal communiquant', 'Ligne secondaire', 'Téléphone', 'Message créé le', 'Envoyé le', 'Remis le', 'État', 'Réponse le', 'Délai réponse (s)', 'Réponse', 'Erreur'];
  const lines = rows.map((row) => {
    const responseDelay = row.response_at && row.delivered_at
      ? Math.max(0, Math.round((Date.parse(row.response_at) - Date.parse(row.delivered_at)) / 1000))
      : '';
    return [check.id, check.address_book_id, row.first_name, row.last_name, row.entity, row.service, row.direction, row.imei, row.puk, row.line_status, row.plan, row.device_terminal, row.secondary_line, row.phone,
      row.message_created_at, row.message_sent_at, row.message_delivered_at, row.state,
      row.response_at, responseDelay, row.response_body, row.error].map(escCsv).join(';');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="verification_flotte_${check.id}.csv"`);
  res.send('\uFEFF' + header.join(';') + '\r\n' + lines.join('\r\n'));
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
// passent en "pending" (récupérés par les passerelles) s'ils sont routés en
// interne, ou sont directement envoyés via Frizbi s'ils sont routés externe
// (Frizbi n'a pas de file d'attente : l'appel se fait au moment de l'envoi).
setInterval(() => {
  try {
    const now = isoNow();
    db.prepare(
      "UPDATE messages SET status = 'pending', updated_at = ? WHERE status = 'scheduled' AND scheduled_at <= ? AND provider = 'internal'"
    ).run(now, now);
    const dueFrizbi = db.prepare(
      "SELECT id, recipient, body FROM messages WHERE status = 'scheduled' AND scheduled_at <= ? AND provider = 'frizbi'"
    ).all(now);
    if (dueFrizbi.length) {
      dispatchFrizbiBatch(
        dueFrizbi.map((m) => ({ messageId: m.id, recipient: m.recipient, body: m.body })),
        { title: 'Ville d’Ivry' }
      ).catch((err) => console.error('[FRIZBI] dispatch programmé error:', err));
    }
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

// Moissonnage des boîtes mail (mail → SMS) et envoi des compte-rendus.
mail2sms.start();
process.on('exit', () => mail2sms.stop());
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Une rejet de promesse non rattaché (ex : erreur IMAP survenue après
// l'interruption d'un relevé) ne doit pas faire planter la passerelle : on la
// journalise et on continue.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
