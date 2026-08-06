'use strict';

// ---------------------------------------------------------------------------
// Mail → SMS
//
// Moissonne des boîtes mail (IMAP) et transforme certains e-mails en SMS :
//   - le sujet de l'e-mail devient le contenu du SMS,
//   - le corps indique les destinataires : des numéros de téléphone et/ou le
//     nom d'un carnet d'adresses (ligne « carnet : <nom> », « #<nom> », ou une
//     ligne qui correspond exactement au nom d'un carnet existant),
//   - les pièces jointes sont conservées et un lien public est ajouté au SMS,
//   - après quelques minutes, un e-mail de compte-rendu est envoyé à
//     l'expéditeur avec le statut de chaque SMS (destinataire, statut, heure…).
//
// Seuls les expéditeurs autorisés (motifs type « m*@ivry94.fr ») sont traités.
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const PORT_API = parseInt(process.env.PORT_API || '3250', 10);
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || '1000', 10);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MAIL = 5;
const POLL_DEFAULT_MS = parseInt(process.env.MAIL2SMS_POLL_SEC || '60', 10) * 1000;
const REPLY_POLL_MS = parseInt(process.env.MAIL2SMS_REPLY_POLL_SEC || '30', 10) * 1000;
const MAX_REPLY_ATTEMPTS = 5;
// Bornes le nombre d'e-mails traités par relevé : chaque relevé reste ainsi
// rapide (pas de timeout 504 du proxy), le reste est pris au relevé suivant.
const MAX_SCAN_EMAILS = parseInt(process.env.MAIL2SMS_MAX_PER_SCAN || '50', 10);
const IMAP_TIMEOUT_MS = parseInt(process.env.MAIL2SMS_IMAP_TIMEOUT_MS || '120000', 10);

const PHONE_RE = /^\+?[0-9]{4,15}$/;

const isoNow = () => new Date().toISOString();

// --- Normalisation d'un numéro de téléphone (copie de server.js) -----------
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

const isBlacklisted = (phone) =>
  Boolean(db.prepare('SELECT 1 FROM blacklist_numbers WHERE phone = ?').get(phone));

const attachmentPublicUrl = (token) => {
  const base = String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT_API}`).replace(/\/$/, '');
  return `${base}/api/v1/attachments/${encodeURIComponent(token)}`;
};

const readableFilename = (name) => {
  const value = String(name || 'piece-jointe');
  if (!/[ÃÂâ]/.test(value)) return value;
  try {
    return decodeURIComponent(Array.from(value)
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join(''));
  } catch (_) {
    return value;
  }
};

// --- Motifs d'expéditeurs autorisés (m*@ivry94.fr, *@exemple.fr, …) ---------
function senderPatternToRegExp(pattern) {
  const p = String(pattern || '').trim().toLowerCase();
  if (!p) return null;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function senderAllowed(box, address) {
  const sender = String(address || '').trim().toLowerCase();
  if (!sender) return false;
  return String(box.allowed_senders || '')
    .split(/[\n,;]/)
    .map(senderPatternToRegExp)
    .filter(Boolean)
    .some((re) => re.test(sender));
}

// --- Extraction des destinataires depuis le corps de l'e-mail --------------
function parseBody(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const phones = new Set();
  const bookNames = new Set();
  const leftover = [];

  for (const line of lines) {
    const bookMatch = /^(?:carnet\s*:?\s*|#)\s*(.+)$/i.exec(line);
    if (bookMatch) {
      bookNames.add(bookMatch[1].trim());
      continue;
    }
    const wholePhone = normalizePhone(line);
    if (PHONE_RE.test(wholePhone)) {
      phones.add(wholePhone);
      continue;
    }
    const tokens = line.split(/[\s,;]+/).filter(Boolean);
    let recognized = false;
    for (const token of tokens) {
      const phone = normalizePhone(token);
      if (PHONE_RE.test(phone)) {
        phones.add(phone);
        recognized = true;
      }
    }
    if (!recognized) leftover.push(line);
  }
  return { phones: [...phones], bookNames: [...bookNames], leftover };
}

function findBookId(name) {
  const exact = db.prepare('SELECT id FROM address_books WHERE name = ? COLLATE NOCASE LIMIT 1')
    .get(String(name || '').trim());
  if (exact) return exact.id;
  return null;
}

function resolveRecipients(body) {
  const { phones, bookNames, leftover } = parseBody(body);
  const resolved = new Set(phones);

  const names = [...bookNames];
  for (const line of leftover) {
    const id = findBookId(line);
    if (id != null) names.push(line);
  }

  for (const name of names) {
    const bookId = findBookId(name);
    if (bookId == null) continue;
    const rows = db.prepare('SELECT phone FROM contacts WHERE address_book_id = ?').all(bookId);
    for (const row of rows) {
      const phone = normalizePhone(row.phone);
      if (PHONE_RE.test(phone)) resolved.add(phone);
    }
  }

  const recipients = [...resolved].filter((p) => !isBlacklisted(p));
  return { recipients, resolved: resolved.size };
}

// --- Pièces jointes ---------------------------------------------------------
function storeAttachment(attachment) {
  if (!attachment || !attachment.content || !attachment.content.length) return null;
  if (attachment.content.length > MAX_ATTACHMENT_SIZE) return null;
  const storedName = crypto.randomBytes(12).toString('base64url');
  const filePath = path.join(ATTACHMENTS_DIR, storedName);
  fs.writeFileSync(filePath, attachment.content);
  const now = isoNow();
  const info = db.prepare(`
    INSERT INTO attachments
      (token, original_name, stored_name, mime_type, size, owner_key_id, owner_account_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(
    storedName,
    readableFilename(attachment.filename || 'piece-jointe'),
    storedName,
    attachment.contentType || 'application/octet-stream',
    attachment.content.length,
    now
  );
  return {
    id: info.lastInsertRowid,
    name: readableFilename(attachment.filename || 'piece-jointe'),
    url: attachmentPublicUrl(storedName),
    filePath
  };
}

function bodyWithAttachments(body, attachments) {
  let content = String(body || '');
  const links = attachments.map((a) => a.url).join('\n');
  if (!links) return content;
  const suffix = `\n\nPièce jointe : ${links}`;
  if ((content + suffix).length <= MAX_MESSAGE_LENGTH) return content + suffix;
  const available = Math.max(0, MAX_MESSAGE_LENGTH - suffix.length);
  return content.slice(0, available) + suffix;
}

// --- SMTP -------------------------------------------------------------------
function smtpConfig(box) {
  const host = String(box.smtp_host || box.imap_host || '').trim();
  const secure = box.smtp_secure != null ? Boolean(box.smtp_secure) : true;
  const port = box.smtp_port || (secure ? 465 : 587);
  return {
    host,
    port,
    secure,
    auth: {
      user: String(box.smtp_login || box.login || ''),
      pass: String(box.smtp_password || box.password || '')
    }
  };
}

async function sendReplyMail(box, to, subject, text, html) {
  const cfg = smtpConfig(box);
  if (!cfg.host) throw new Error('Serveur SMTP non configuré');
  const transporter = nodemailer.createTransport(cfg);
  try {
    await transporter.sendMail({
      from: `"${box.name}" <${box.email}>`,
      to,
      subject,
      text,
      html
    });
  } finally {
    transporter.close();
  }
}

// --- Construction du compte-rendu -------------------------------------------
const STATUS_LABELS = {
  scheduled: 'Programmé',
  pending: 'En attente',
  sending: 'En cours d’envoi',
  sent: 'Envoyé',
  delivered: 'Remis',
  failed: 'Échec',
  cancelled: 'Annulé'
};

function messageTime(m, field) {
  return m[field] ? new Date(m[field]).toLocaleString('fr-FR') : '—';
}

function buildReport(email, messages) {
  const counts = {};
  for (const m of messages) counts[m.status] = (counts[m.status] || 0) + 1;
  const summary = [
    `SMS demandés : ${messages.length}`,
    `Remis : ${counts.delivered || 0}`,
    `Envoyés : ${counts.sent || 0}`,
    `En attente / en cours : ${(counts.pending || 0) + (counts.sending || 0) + (counts.scheduled || 0)}`,
    `Échecs : ${counts.failed || 0}`,
    `Annulés : ${counts.cancelled || 0}`
  ].join('\n');

  const rows = messages.map((m) => {
    const line = `- ${m.recipient} — ${STATUS_LABELS[m.status] || m.status}` +
      ` (créé ${messageTime(m, 'created_at')}, envoyé ${messageTime(m, 'sent_at')}, remis ${messageTime(m, 'delivered_at')})`;
    return m.error ? `${line} — erreur : ${m.error}` : line;
  });

  const text = [
    `Bonjour,`,
    ``,
    `Votre demande « ${email.subject} » envoyée par e-mail le ${messageTime(email, 'received_at')} a été traitée.`,
    ``,
    summary,
    ``,
    rows.join('\n') || 'Aucun SMS n’a pu être créé.',
    ``,
    `— Passerelle SMS`
  ].join('\n');

  const htmlRows = messages.map((m) => `<tr>
    <td style="padding:6px 10px;border:1px solid #ddd">${m.recipient}</td>
    <td style="padding:6px 10px;border:1px solid #ddd">${STATUS_LABELS[m.status] || m.status}</td>
    <td style="padding:6px 10px;border:1px solid #ddd">créé ${messageTime(m, 'created_at')}<br>envoyé ${messageTime(m, 'sent_at')}<br>remis ${messageTime(m, 'delivered_at')}</td>
    <td style="padding:6px 10px;border:1px solid #ddd">${m.error || ''}</td>
  </tr>`).join('');

  const html = `<p>Votre demande « <strong>${email.subject.replace(/[<>&]/g, '')}</strong> » reçue le ${messageTime(email, 'received_at')} a été traitée.</p>
  <p><strong>${messages.length}</strong> SMS demandé(s) : ${counts.delivered || 0} remis, ${counts.sent || 0} envoyés, ${counts.failed || 0} en échec.</p>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <thead><tr>
      <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Destinataire</th>
      <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Statut</th>
      <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Horaires</th>
      <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Erreur</th>
    </tr></thead>
    <tbody>${htmlRows || '<tr><td colspan="4">Aucun SMS n’a pu être créé.</td></tr>'}</tbody>
  </table>
  <p>— Passerelle SMS</p>`;

  return { text, html };
}

function buildErrorReport(email, error) {
  const text = [
    `Bonjour,`,
    ``,
    `Votre demande « ${email.subject} » (reçue le ${messageTime(email, 'received_at')}) n’a pas pu être traitée :`,
    ``,
    String(error || 'Raison inconnue'),
    ``,
    `Rappel du format attendu : le sujet de l’e-mail est le contenu du SMS, et le corps contient les numéros de téléphone et/ou le nom du carnet d’adresses (ligne « carnet : <nom> »).`,
    ``,
    `— Passerelle SMS`
  ].join('\n');
  const html = `<p>Votre demande « <strong>${email.subject.replace(/[<>&]/g, '')}</strong> » n’a pas pu être traitée :</p>
  <p>${String(error || 'Raison inconnue').replace(/[<>&]/g, '')}</p>
  <p>Rappel du format attendu : le sujet de l’e-mail est le contenu du SMS, et le corps contient les numéros de téléphone et/ou le nom du carnet d’adresses (ligne « carnet : <nom> »).</p>
  <p>— Passerelle SMS</p>`;
  return { text, html };
}

// --- Envoi des compte-rendus dus --------------------------------------------
async function sendPendingReplies() {
  const rows = db.prepare(`
    SELECT e.*, b.name AS box_name, b.email AS box_email, b.reply_enabled, b.reply_delay_min,
      b.reply_subject, b.smtp_host, b.smtp_port, b.smtp_secure, b.smtp_login, b.smtp_password,
      b.imap_host, b.login, b.password
    FROM mail2sms_emails e
    JOIN mail2sms_boxes b ON b.id = e.box_id
    WHERE b.reply_enabled = 1
      AND e.reply_sent_at IS NULL
      AND e.reply_attempts < ?
      AND e.status IN ('processed', 'error')
      AND e.processed_at <= ?
    ORDER BY e.id ASC
  `).all(MAX_REPLY_ATTEMPTS, new Date(Date.now() - (5 * 60 * 1000)).toISOString());

  for (const email of rows) {
    try {
      let text;
      let html;
      if (email.status === 'error') {
        const report = buildErrorReport(email, email.error);
        text = report.text;
        html = report.html;
      } else {
        const messages = db.prepare(
          'SELECT * FROM messages WHERE mail2sms_email_id = ? ORDER BY id ASC'
        ).all(email.id);
        const report = buildReport(email, messages);
        text = report.text;
        html = report.html;
      }
      const subject = String(email.reply_subject || 'Re: ') + email.subject;
      await sendReplyMail(email, email.from_addr, subject, text, html);
      db.prepare(
        'UPDATE mail2sms_emails SET status = ?, reply_sent_at = ?, reply_error = NULL WHERE id = ?'
      ).run(email.status === 'error' ? 'replied_error' : 'replied', isoNow(), email.id);
    } catch (err) {
      db.prepare(
        'UPDATE mail2sms_emails SET reply_attempts = reply_attempts + 1, reply_error = ? WHERE id = ?'
      ).run(String(err && err.message ? err.message : err).slice(0, 500), email.id);
    }
  }
}

// --- Moissonnage d'une boîte ------------------------------------------------
function imapConfig(box) {
  return {
    host: String(box.imap_host || '').trim(),
    port: Number(box.imap_port) || 993,
    secure: box.imap_secure != null ? Boolean(box.imap_secure) : true,
    auth: {
      user: String(box.login || '').trim(),
      pass: String(box.password || '')
    },
    logger: false,
    verifyOnly: false,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: IMAP_TIMEOUT_MS
  };
}

async function processMail(box, message) {
  const uid = String(message.uid);
  const exists = db.prepare('SELECT 1 FROM mail2sms_emails WHERE box_id = ? AND message_uid = ?')
    .get(box.id, uid);
  if (exists) return 'exists';

  const envelope = message.envelope || {};
  const from = (envelope.from || []).map((a) => a.address).filter(Boolean)[0] || '';
  const subject = String(envelope.subject || '').trim();
  const receivedAt = message.internalDate ? new Date(message.internalDate).toISOString() : isoNow();
  const messageId = String(envelope.messageId || '').slice(0, 255);
  const now = isoNow();

  let parsed = null;
  try {
    parsed = await simpleParser(message.source);
  } catch (err) {
    db.prepare(`
      INSERT INTO mail2sms_emails
        (box_id, message_uid, message_id, from_addr, subject, received_at, processed_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?)
    `).run(box.id, uid, messageId, from, subject, receivedAt, now,
      `Lecture de l'e-mail impossible : ${String(err.message || err).slice(0, 500)}`);
    return 'error';
  }

  const parsedFrom = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || from;

  const recordError = (error) => {
    db.prepare(`
      INSERT INTO mail2sms_emails
        (box_id, message_uid, message_id, from_addr, subject, received_at, processed_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?)
    `).run(box.id, uid, messageId, parsedFrom, subject, receivedAt, now, String(error).slice(0, 500));
  };

  if (!senderAllowed(box, parsedFrom)) {
    db.prepare(`
      INSERT INTO mail2sms_emails
        (box_id, message_uid, message_id, from_addr, subject, received_at, processed_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ignored', ?)
    `).run(box.id, uid, messageId, parsedFrom, subject, receivedAt, now,
      `Expéditeur non autorisé (${parsedFrom}). Motifs autorisés : ${box.allowed_senders}`);
    return 'ignored';
  }

  if (!subject) {
    recordError('Sujet vide : le contenu du SMS doit être mis dans le sujet de l\'e-mail.');
    return 'error';
  }
  if (subject.length > MAX_MESSAGE_LENGTH) {
    recordError(`Sujet trop long (${subject.length} caractères, maximum ${MAX_MESSAGE_LENGTH}).`);
    return 'error';
  }

  const { recipients, resolved } = resolveRecipients(parsed.text || '');
  if (recipients.length === 0) {
    recordError(resolved === 0
      ? 'Aucun destinataire trouvé : indiquez des numéros de téléphone et/ou un nom de carnet d\'adresses dans le corps de l\'e-mail.'
      : 'Aucun destinataire valide (tous les numéros trouvés sont blacklistés).');
    return 'error';
  }

  const attachments = (parsed.attachments || [])
    .filter((a) => a.content && a.content.length > 0)
    .slice(0, MAX_ATTACHMENTS_PER_MAIL);
  const stored = [];
  for (const a of attachments) {
    const storedOne = storeAttachment(a);
    if (storedOne) stored.push(storedOne);
  }

  const emailBody = bodyWithAttachments(subject, stored);
  const insertMessage = db.prepare(`
    INSERT INTO messages
      (recipient, body, status, origin, origin_label, attachment_id, created_by_label, created_at, mail2sms_email_id)
    VALUES (?, ?, 'pending', 'mail2sms', ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let emailRowId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO mail2sms_emails
        (box_id, message_uid, message_id, from_addr, subject, received_at, processed_at, status, recipient_count, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'processed', ?, 0)
    `).run(box.id, uid, messageId, parsedFrom, subject, receivedAt, now, recipients.length);
    emailRowId = info.lastInsertRowid;

    for (const phone of recipients) {
      insertMessage.run(
        phone,
        emailBody,
        box.name,
        stored.length === 1 ? stored[0].id : null,
        `Mail → SMS (${box.name})`,
        now,
        emailRowId
      );
      inserted++;
    }
    db.prepare('UPDATE mail2sms_emails SET message_count = ? WHERE id = ?').run(inserted, emailRowId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    for (const one of stored) {
      try { fs.rmSync(one.filePath, { force: true }); } catch { /* ignore */ }
    }
    throw err;
  }
  return 'processed';
}

// --- Déplacement des e-mails traités dans un dossier IMAP -------------------
// « SMS Traités » par défaut : le dossier est créé s'il n'existe pas. Après un
// traitement réussi, l'e-mail quitte la boîte de réception et n'est plus relu.
// Lève une erreur en cas d'échec : l'appelant laisse alors l'e-mail non lu et
// le relevé suivant retentera le déplacement.
async function moveToProcessedFolder(client, box, uid) {
  const folder = String(box.processed_folder || '').trim();
  if (!folder) return false;
  const existing = await client.list();
  const found = (existing || []).some((m) => String(m.path) === folder);
  if (!found) await client.mailboxCreate(folder);
  await client.messageMove(uid, folder, { uid: true });
  return true;
}

async function scanBox(box) {
  const client = new ImapFlow(imapConfig(box));
  const counts = { processed: 0, ignored: 0, errors: 0, moveErrors: 0, remaining: false };
  const markSeen = (uid) => client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock(String(box.imap_folder || 'INBOX'));
    try {
      let handled = 0;
      let lastMoveError = null;
      for await (const message of client.fetch({ seen: false }, {
        envelope: true,
        uid: true,
        internalDate: true,
        source: true
      })) {
        if (handled >= MAX_SCAN_EMAILS) {
          counts.remaining = true;
          break;
        }
        handled++;
        let result;
        try {
          result = await processMail(box, message);
        } catch (err) {
          counts.errors++;
          try {
            db.prepare(`
              INSERT INTO mail2sms_emails
                (box_id, message_uid, message_id, from_addr, subject, received_at, processed_at, status, error)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?)
            `).run(box.id, String(message.uid), '', '', '', isoNow(), isoNow(),
              `Traitement impossible : ${String(err && err.message ? err.message : err).slice(0, 500)}`);
          } catch { /* ignore */ }
          await markSeen(message.uid);
          continue;
        }

        if (result === 'processed') {
          counts.processed++;
          const folder = String(box.processed_folder || '').trim();
          if (!folder) {
            await markSeen(message.uid);
          } else {
            try {
              await moveToProcessedFolder(client, box, message.uid);
            } catch (err) {
              counts.moveErrors++;
              lastMoveError = err;
              // L'e-mail reste non lu : le prochain relevé retentera le déplacement.
            }
          }
        } else if (result === 'ignored') {
          counts.ignored++;
          await markSeen(message.uid);
        } else if (result === 'error') {
          counts.errors++;
          await markSeen(message.uid);
        } else if (result === 'exists') {
          const rec = db.prepare(
            'SELECT status FROM mail2sms_emails WHERE box_id = ? AND message_uid = ?'
          ).get(box.id, String(message.uid));
          if (rec && rec.status === 'processed') {
            try {
              await moveToProcessedFolder(client, box, message.uid);
            } catch { /* ignore : retenté au relevé suivant */ }
          } else {
            await markSeen(message.uid);
          }
        }
      }
      if (lastMoveError) counts.moveError = lastMoveError;
    } finally {
      lock.release();
    }
    await client.logout();
  } finally {
    client.close();
  }
  return counts;
}

function recordBoxScan(box, counts) {
  const status = counts.moveErrors > 0 ? 'error' : 'ok';
  const error = counts.moveErrors > 0
    ? `${counts.moveErrors} e-mail(s) traité(s) non déplacé(s) vers « ${box.processed_folder} »` +
      (counts.moveError ? ` (${String(counts.moveError.message || counts.moveError).slice(0, 400)})` : '')
    : null;
  db.prepare('UPDATE mail2sms_boxes SET last_scan_at = ?, last_status = ?, last_error = ? WHERE id = ?')
    .run(isoNow(), status, error, box.id);
}

async function scanBoxById(boxId) {
  const box = db.prepare('SELECT * FROM mail2sms_boxes WHERE id = ?').get(Number(boxId));
  if (!box) throw new Error('Boîte mail2sms introuvable');
  if (!box.active) throw new Error('Boîte désactivée : activez-la avant de scanner');
  const counts = await scanBox(box);
  recordBoxScan(box, counts);
  return { ok: true, box: box.name, processedFolder: box.processed_folder || 'SMS Traités', ...counts };
}

async function scanAll() {
  if (mail2smsRunning) return;
  mail2smsRunning = true;
  try {
    const boxes = db.prepare('SELECT * FROM mail2sms_boxes WHERE active = 1').all();
    for (const box of boxes) {
      const intervalMs = (Number(box.scan_interval_sec) || 60) * 1000;
      if (box.last_scan_at && Date.now() - Date.parse(box.last_scan_at) < intervalMs) continue;
      try {
        const counts = await scanBox(box);
        recordBoxScan(box, counts);
      } catch (err) {
        db.prepare('UPDATE mail2sms_boxes SET last_status = ?, last_error = ? WHERE id = ?')
          .run('error', String(err && err.message ? err.message : err).slice(0, 500), box.id);
      }
    }
  } finally {
    mail2smsRunning = false;
  }
}

let mail2smsRunning = false;
let timers = [];

async function testBox(boxId) {
  const box = db.prepare('SELECT * FROM mail2sms_boxes WHERE id = ?').get(Number(boxId));
  if (!box) throw new Error('Boîte mail2sms introuvable');
  const client = new ImapFlow(imapConfig(box));
  try {
    await client.connect();
    const lock = await client.getMailboxLock(String(box.imap_folder || 'INBOX'));
    let messages = 0;
    let unseen = 0;
    try {
      messages = client.mailbox.exists || 0;
      unseen = (await client.search({ seen: false })).length;
    } finally {
      lock.release();
    }
    return { ok: true, messages, unseen };
  } finally {
    await client.logout().catch(() => {});
    client.close();
  }
}

function start() {
  timers.push(setInterval(() => { scanAll().catch(() => {}); }, POLL_DEFAULT_MS));
  timers.push(setInterval(() => { sendPendingReplies().catch(() => {}); }, REPLY_POLL_MS));
  setTimeout(() => { scanAll().catch(() => {}); }, 10 * 1000);
  setTimeout(() => { sendPendingReplies().catch(() => {}); }, 20 * 1000);
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

module.exports = {
  scanAll,
  scanBoxById,
  sendPendingReplies,
  testBox,
  start,
  stop
};
