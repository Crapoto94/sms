'use strict';

const $ = (id) => document.getElementById(id);

let currentTab = 'messages';

const fmtDate = (iso) => {
  if (!iso) return '—';
  const value = typeof iso === 'string' && /^\d+$/.test(iso) ? Number(iso) : iso;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
};

const badge = (label, cls) => `<span class="badge ${cls}">${label}</span>`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// ---------- Mode clair / sombre ----------
function initTheme() {
  const btn = $('btnTheme');
  if (!btn) return;
  const apply = (light) => {
    document.body.classList.toggle('light', light);
    btn.textContent = light ? 'Mode sombre' : 'Mode clair';
  };
  apply(localStorage.getItem('sms-theme') === 'light');
  btn.addEventListener('click', () => {
    const light = !document.body.classList.contains('light');
    localStorage.setItem('sms-theme', light ? 'light' : 'dark');
    apply(light);
  });
}
initTheme();

// ---------- Historique SMS d'un numéro / d'un carnet ----------
async function openSmsHistory(title, url) {
  const data = await api(url);
  const msgs = Array.isArray(data) ? data : (data.items || []);
  $('smsHistoryTitle').textContent = title + (msgs.length ? ` (${msgs.length})` : '');
  $('smsHistoryBody').innerHTML = msgs.length
    ? `<table>
        <thead><tr><th>ID</th><th>Date</th><th>Destinataire</th><th>Message</th><th>Statut</th><th>Passerelle</th><th>Erreur</th></tr></thead>
        <tbody>${msgs.map((m) => `<tr>
          <td>${m.id}</td>
          <td>${fmtDate(m.created_at)}</td>
          <td class="code">${esc(m.recipient)}</td>
          <td>${esc(m.body)}</td>
          <td>${stateOf(m.status)}</td>
          <td>${esc(m.gateway_label || m.device_id || '—')}</td>
          <td class="muted">${esc(m.error || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : '<p class="muted">Aucun SMS envoyé vers ce numéro.</p>';
  $('smsHistoryModal').classList.remove('hidden');
}

$('btnCloseSmsHistory').addEventListener('click', () => $('smsHistoryModal').classList.add('hidden'));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('non authentifié');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function uploadAttachment(file, expiresInDays) {
  const form = new FormData();
  form.append('file', file);
  form.append('expiresInDays', String(expiresInDays));
  const res = await fetch('/admin/api/attachments', { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------- Onglets ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
    $('keys').classList.toggle('hidden', currentTab !== 'keys');
    $('gateways').classList.toggle('hidden', currentTab !== 'gateways');
    $('messages').classList.toggle('hidden', currentTab !== 'messages');
    $('books').classList.toggle('hidden', currentTab !== 'books');
    $('fleet').classList.toggle('hidden', currentTab !== 'fleet');
    $('sync').classList.toggle('hidden', currentTab !== 'sync');
    $('mail2sms').classList.toggle('hidden', currentTab !== 'mail2sms');
    $('logs').classList.toggle('hidden', currentTab !== 'logs');
    $('journal').classList.toggle('hidden', currentTab !== 'journal');
    $('accounts').classList.toggle('hidden', currentTab !== 'accounts');
    $('groups').classList.toggle('hidden', currentTab !== 'groups');
    $('help').classList.toggle('hidden', currentTab !== 'help');
    if (currentTab === 'keys') loadKeys();
    if (currentTab === 'gateways') loadGateways();
    if (currentTab === 'messages') {
      if (msgView === 'sent') loadMessages();
      else loadIncoming();
    }
    if (currentTab === 'books') loadBooks();
    if (currentTab === 'fleet') loadFleet();
    if (currentTab === 'sync') loadSync();
    if (currentTab === 'mail2sms') loadMail2Sms();
    if (currentTab === 'logs') loadLogs();
    if (currentTab === 'journal') loadJournal();
    if (currentTab === 'accounts') loadAccounts();
    if (currentTab === 'groups') loadGroups();
  });
});

loadCurrentUser();

async function loadCurrentUser() {
  try {
    const s = await api('/admin/api/session');
    $('currentUser').textContent = s.isAdmin ? `Connecté en tant qu'admin` : `Connecté en tant que « ${s.login} »`;
    $('appVersion').textContent = `v${s.version}`;
  } catch { /* la redirection 401 gère le reste */ }
}

$('logout').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login.html';
});

// ---------- Clés ----------
async function loadKeys() {
  const keys = await api('/admin/api/keys');
  $('keysBody').innerHTML = keys.map((k) => {
    let state = badge('Actif', 'ok');
    if (k.revoked) state = badge('Révoquée', 'revoked');
    else if (k.expired) state = badge('Expirée', 'expired');
    const typeLabel = k.type === 'gateway' ? 'Passerelle' : 'Web';
    return `<tr>
      <td>${k.id}</td>
      <td>${esc(k.label)}</td>
      <td>${typeLabel}</td>
      <td class="code">${esc(k.device_id || '—')}</td>
      <td>${fmtDate(k.created_at)}</td>
      <td>${fmtDate(k.expires_at)}</td>
      <td>${fmtDate(k.last_used_at)}</td>
      <td>${state}</td>
      <td>
        ${k.revoked ? '' : `<button data-revoke="${k.id}" class="danger">Révoquer</button> `}
        <button data-del="${k.id}" class="ghost">Supprimer</button>
      </td>
    </tr>`;
  }).join('');
  document.querySelectorAll('[data-revoke]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/admin/api/keys/${b.dataset.revoke}/revoke`, { method: 'POST' });
      loadKeys();
    });
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer définitivement cette clé ?')) return;
      await api(`/admin/api/keys/${b.dataset.del}`, { method: 'DELETE' });
      loadKeys();
    });
  });
}

$('btnNewKey').addEventListener('click', () => {
  $('keyLabel').value = '';
  $('keyType').value = 'web';
  $('keyDays').value = '';
  $('modalError').textContent = '';
  $('modal').classList.remove('hidden');
});
$('btnCancelKey').addEventListener('click', () => $('modal').classList.add('hidden'));

$('btnCreateKey').addEventListener('click', async () => {
  try {
    const data = await api('/admin/api/keys', {
      method: 'POST',
      body: JSON.stringify({
        label: $('keyLabel').value,
        type: $('keyType').value,
        days: $('keyDays').value
      })
    });
    $('modal').classList.add('hidden');
    $('tokenValue').value = data.token;
    $('tokenModal').classList.remove('hidden');
    loadKeys();
  } catch (e) {
    $('modalError').textContent = e.message;
  }
});

$('btnCopyToken').addEventListener('click', async () => {
  const text = $('tokenValue').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('tokenValue').select();
    document.execCommand('copy');
  }
  $('btnCopyToken').textContent = 'Copié ✓';
  setTimeout(() => { $('btnCopyToken').textContent = 'Copier'; }, 1500);
});
$('btnCloseToken').addEventListener('click', () => $('tokenModal').classList.add('hidden'));

// ---------- Passerelles ----------
function updateOnlineBadge(n) {
  const el = $('onlineBadge');
  if (!el) return;
  el.textContent = n;
  el.classList.toggle('off', !n);
  el.title = `${n} passerelle(s) active(s)`;
}

async function refreshOnlineBadge() {
  try {
    const stats = await api('/admin/api/stats');
    updateOnlineBadge(stats.gatewaysOnline);
  } catch { /* silencieux */ }
}

async function loadGateways() {
  const [gateways, stats] = await Promise.all([
    api('/admin/api/gateways'),
    api('/admin/api/stats')
  ]);
  $('online').textContent = `${stats.gatewaysOnline} passerelle(s) en ligne`;
  updateOnlineBadge(stats.gatewaysOnline);
  $('gatewaysBody').innerHTML = gateways.length
    ? gateways.map((g) => {
        const state = g.online ? badge('En ligne', 'ok') : badge('Hors ligne', 'off');
        return `<tr>
          <td>${esc(g.label || '—')}</td>
          <td class="code">${esc(g.device_id || '—')}</td>
          <td>${esc(g.app_version || '—')}</td>
          <td>${fmtDate(g.last_seen_at)}</td>
          <td>${g.sending}</td>
          <td>${g.sent}</td>
          <td>${g.delivered}</td>
          <td>${g.failed}</td>
          <td>${state}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="9" class="muted">Aucune passerelle connectée.</td></tr>';
}

// ---------- Messages ----------
const CANCELABLE = ['scheduled', 'pending', 'sending', 'sent'];
const stateOf = (s) => badge({
  scheduled: 'Programmé', pending: 'En attente', sending: 'En cours', sent: 'Envoyé', delivered: 'Remis', failed: 'Échec', cancelled: 'Annulé'
}[s] || s, s);

let msgView = 'sent';

const MESSAGE_HEADERS = '<tr><th>Date</th><th>Origine</th><th>Destinataire</th><th>Statut</th><th>Passerelle</th><th>Groupe</th><th>Pièce jointe</th><th>Erreur</th></tr>';

function messageOrigin(m) {
  if (m.origin === 'web') return `${badge('API WEB', 'ok')} ${esc(m.origin_label || '')}`;
  if (m.origin === 'console') return badge('Console', 'off');
  return esc(m.origin_label || m.origin || '—');
}

function repairFilename(name) {
  const value = String(name || '');
  if (!/[ÃÂâ]/.test(value)) return value;
  try {
    return decodeURIComponent(Array.from(value)
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join(''));
  } catch (_) {
    return value;
  }
}

function messageAttachment(m) {
  if (!m.attachment_name) return '—';
  const opened = Number(m.attachment_open_count || 0);
  const state = opened
    ? `<button type="button" class="badge ok attachment-open-info" data-attachment-info="${m.attachment_id}" title="Voir les détails des ouvertures">Ouverte (${opened})</button>`
    : badge('Non ouverte', 'off');
  const file = `<a href="/admin/api/attachments/${m.attachment_id}/preview" target="_blank" rel="noopener">${esc(repairFilename(m.attachment_name))}</a>`;
  return `${state} ${file}`;
}

function cancelButton(m) {
  return CANCELABLE.includes(m.status)
    ? `<button data-cancelmsg="${m.id}" class="ghost">Annuler</button>`
    : '';
}

let recipientCounts = {};

function recipientPastille(phone) {
  const n = Number(recipientCounts[phone] || 0);
  return `<span data-recipient="${esc(phone)}" class="sms-pastille${n ? '' : ' empty'}" title="Voir les SMS envoyés à ${esc(phone)}">${n}</span>`;
}

function adminMessageRow(m) {
  return `<tr>
    <td>${m.id}</td>
    <td>${fmtDate(m.created_at)}</td>
    <td>${messageOrigin(m)}</td>
    <td class="code">${esc(m.recipient)} ${recipientPastille(m.recipient)}</td>
    <td>${esc(m.body)}</td>
    <td>${stateOf(m.status)}</td>
    <td>${esc(m.gateway_label || m.device_id || '—')}</td>
    <td>${esc(m.group_name || '—')}</td>
    <td>${messageAttachment(m)}</td>
    <td class="muted">${esc(m.error || '')}</td>
    <td>${cancelButton(m)}</td>
  </tr>`;
}

function campaignDetailRow(m) {
  return `<tr>
    <td>${fmtDate(m.created_at)}</td>
    <td>${messageOrigin(m)}</td>
    <td class="code">${esc(m.recipient)} ${recipientPastille(m.recipient)}</td>
    <td>${stateOf(m.status)}</td>
    <td>${esc(m.gateway_label || m.device_id || '—')}</td>
    <td>${esc(m.group_name || '—')}</td>
    <td>${messageAttachment(m)}</td>
    <td class="muted">${esc(m.error || '')}</td>
  </tr>`;
}

function campaignKpi(c, byStatus) {
  if (c.rows.length <= 5) return '';
  const chips = [];
  const defs = [
    ['kpi-ok', 'Remis', byStatus.delivered],
    ['kpi-sent', 'Envoyés', byStatus.sent],
    ['kpi-flight', 'En cours', (byStatus.pending || 0) + (byStatus.sending || 0) + (byStatus.scheduled || 0)],
    ['kpi-fail', 'Échecs', byStatus.failed],
    ['kpi-off', 'Annulés', byStatus.cancelled]
  ];
  for (const [cls, label, n] of defs) {
    if (n > 0) chips.push(`<span class="kpi ${cls}" title="${label}">${label} <b>${n}</b></span>`);
  }
  return `<div class="campaign-kpi"><span class="kpi kpi-total" title="Destinataires">Total <b>${c.rows.length}</b></span>${chips.join('')}</div>`;
}

function renderMessageList(messages) {
  const campaigns = new Map();
  const singles = [];
  for (const m of messages) {
    if (m.campaign_id) {
      if (!campaigns.has(m.campaign_id)) {
        campaigns.set(m.campaign_id, { id: m.campaign_id, book: m.campaign_book_name || 'Carnet', rows: [] });
      }
      campaigns.get(m.campaign_id).rows.push(m);
    } else {
      singles.push(m);
    }
  }
  const html = [];
  for (const c of campaigns.values()) {
    const byStatus = {};
    for (const m of c.rows) byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    const delivered = byStatus.delivered || 0;
    const failed = byStatus.failed || 0;
    const inFlight = (byStatus.pending || 0) + (byStatus.sending || 0) + (byStatus.scheduled || 0);
    const cancelable = c.rows.some((m) => CANCELABLE.includes(m.status));
    const first = c.rows[0];
    const schedNote = first.scheduled_at ? ` · programmé le ${fmtDate(first.scheduled_at)}` : '';
    const sender = first.creator_login || first.created_by_label || 'Console';
    const summary = `<span class="badge ok">Carnet</span> <strong>${esc(c.book)}</strong> · ${c.rows.length} destinataire(s) · <b class="summary">${delivered} délivré(s)</b>${failed ? ` · ${failed} échec(s)` : ''}${inFlight ? ` · ${inFlight} en cours` : ''}`;
    html.push({ time: Date.parse(first.created_at), html: `<tr class="campaign-row" data-campaign="${c.id}">
      <td colspan="10">${summary}${campaignKpi(c, byStatus)}<span class="muted">${fmtDate(first.created_at)}${schedNote} · Envoyé par <b>${esc(sender)}</b> · ${messageOrigin(first)} · ${messageAttachment(first)} · ${esc(first.body)} · cliquer pour le détail</span></td>
      <td>${cancelable ? `<button data-cancelcamp="${c.id}" class="ghost">Annuler</button>` : ''}</td>
    </tr>
    <tr class="campaign-detail hidden" data-campaign="${c.id}">
      <td colspan="11">
        <table>
          <thead>${MESSAGE_HEADERS}</thead>
          <tbody>${c.rows.map((m) => campaignDetailRow(m)).join('')}</tbody>
        </table>
      </td>
    </tr>` });
  }
  for (const m of singles) html.push({ time: Date.parse(m.created_at), html: adminMessageRow(m) });
  html.sort((a, b) => b.time - a.time);
  return html.map((e) => e.html).join('');
}

function bindCampaignToggles() {
  document.querySelectorAll('.campaign-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const id = row.dataset.campaign;
      const detail = document.querySelector(`.campaign-detail[data-campaign="${id}"]`);
      if (detail) detail.classList.toggle('hidden');
    });
  });
}

async function cancelMessage(id) {
  try {
    await api(`/admin/api/messages/${id}/cancel`, { method: 'POST' });
    loadMessages();
  } catch (e) { alert(e.message); }
}

async function cancelCampaign(id) {
  if (!confirm('Annuler tous les envois pas encore terminés de cette campagne ?')) return;
  try {
    const res = await api(`/admin/api/campaigns/${id}/cancel`, { method: 'POST' });
    alert(`${res.cancelled} message(s) annulé(s).`);
    loadMessages();
  } catch (e) { alert(e.message); }
}

function bindMessageActions() {
  document.querySelectorAll('[data-cancelmsg]').forEach((b) => {
    b.addEventListener('click', () => cancelMessage(Number(b.dataset.cancelmsg)));
  });
  document.querySelectorAll('[data-cancelcamp]').forEach((b) => {
    b.addEventListener('click', () => cancelCampaign(Number(b.dataset.cancelcamp)));
  });
  document.querySelectorAll('[data-recipient]').forEach((b) => {
    b.addEventListener('click', () => {
      openSmsHistory(`SMS envoyés vers ${b.dataset.recipient}`, `/admin/api/messages?recipient=${encodeURIComponent(b.dataset.recipient)}&limit=200`);
    });
  });
  document.querySelectorAll('[data-attachment-info]').forEach((b) => {
    b.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const data = await api(`/admin/api/attachments/${b.dataset.attachmentInfo}/opens`);
        const lines = (data.opens || []).map((o) =>
          `${fmtDate(o.opened_at)} — ${o.device_type || 'Appareil inconnu'} — IP ${o.ip || '—'}\n${o.user_agent || ''}`
        );
        alert(`${repairFilename(data.name)}\nExpiration : ${fmtDate(data.expiresAt)}\nOuvertures : ${data.openCount}\n\n${lines.join('\n') || 'Aucune ouverture.'}`);
      } catch (e) { alert(e.message); }
    });
  });
}

let msgPage = 1;
const MSG_PAGE_SIZE = 25;
let msgTotal = 0;

async function loadMessages() {
  const status = $('statusFilter').value;
  const search = $('msgSearch').value.trim();
  const q = new URLSearchParams({ page: msgPage, pageSize: MSG_PAGE_SIZE, status });
  if (search) q.set('search', search);
  const res = await api(`/admin/api/messages?${q.toString()}`);
  const messages = res.items || [];
  msgTotal = res.total || 0;
  recipientCounts = {};
  const phones = [...new Set(messages.map((m) => m.recipient))];
  if (phones.length) {
    try {
      const r = await api(`/admin/api/messages/counts?recipients=${encodeURIComponent(phones.join(','))}`);
      recipientCounts = r.counts || {};
    } catch { /* pastilles vides si le comptage échoue */ }
  }
  $('messagesBody').innerHTML = messages.length
    ? renderMessageList(messages)
    : '<tr><td colspan="11" class="muted">Aucun message.</td></tr>';
  bindCampaignToggles();
  bindMessageActions();
  renderMsgPagination();
}

function renderMsgPagination() {
  const totalPages = Math.max(1, Math.ceil(msgTotal / MSG_PAGE_SIZE));
  const el = $('msgPagination');
  const prev = `<button data-msgpage="prev" class="ghost" ${msgPage <= 1 ? 'disabled' : ''}>&laquo; Précédent</button>`;
  const next = `<button data-msgpage="next" class="ghost" ${msgPage >= totalPages ? 'disabled' : ''}>Suivant &raquo;</button>`;
  el.innerHTML = `${prev}<span class="muted" style="margin:0 10px">Page ${msgPage} / ${totalPages} — ${msgTotal} message(s)</span>${next}`;
  el.querySelectorAll('[data-msgpage]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.msgpage === 'prev') msgPage = Math.max(1, msgPage - 1);
      else msgPage = Math.min(totalPages, msgPage + 1);
      loadMessages();
    });
  });
}

$('statusFilter').addEventListener('change', () => { msgPage = 1; loadMessages(); });
let msgSearchTimer = null;
$('msgSearch').addEventListener('input', () => {
  clearTimeout(msgSearchTimer);
  msgSearchTimer = setTimeout(() => { msgPage = 1; loadMessages(); }, 350);
});

// ---------- Toggle Messages envoyés / reçus ----------
$('btnMsgSent').addEventListener('click', () => switchMsgView('sent'));
$('btnMsgReceived').addEventListener('click', () => switchMsgView('received'));

function switchMsgView(view) {
  msgView = view;
  $('btnMsgSent').classList.toggle('active', view === 'sent');
  $('btnMsgReceived').classList.toggle('active', view === 'received');
  $('messagesSentTable').classList.toggle('hidden', view !== 'sent');
  $('messagesReceivedTable').classList.toggle('hidden', view !== 'received');
  $('btnNewMessage').classList.toggle('hidden', view !== 'sent');
  $('btnImportCsv').classList.toggle('hidden', view !== 'sent');
  $('btnExport').classList.toggle('hidden', view !== 'sent');
  $('statusFilter').classList.toggle('hidden', view !== 'sent');
  $('msgSearch').classList.toggle('hidden', view !== 'sent');
  $('msgPagination').classList.toggle('hidden', view !== 'sent');
  if (view === 'sent') loadMessages();
  else loadIncoming();
}

async function loadIncoming() {
  try {
    const rows = await api('/admin/api/incoming?limit=100');
    $('incomingBody').innerHTML = rows.length
      ? rows.map((m) => `<tr>
          <td>${fmtDate(m.received_at)}</td>
          <td class="code">${esc(m.sender)}</td>
          <td>${esc(m.body)}</td>
          <td>${esc(m.gateway_label || '—')}</td>
          <td class="code">${esc(m.device_id || '—')}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="muted">Aucun message reçu.</td></tr>';
  } catch { /* silencieux */ }
}

$('btnExport').addEventListener('click', () => {
  const status = $('statusFilter').value;
  const url = '/admin/api/messages/export' + (status ? `?status=${encodeURIComponent(status)}` : '');
  window.location.href = url;
});

// ---------- Envoi manuel ----------
$('btnNewMessage').addEventListener('click', () => {
  location.href = '/send.html';
});
$('btnCancelMessage').addEventListener('click', () => $('messageModal').classList.add('hidden'));
$('smsBody').addEventListener('input', updateSmsCounter);

function updateSmsCounter() {
  const len = $('smsBody').value.length;
  $('smsCounter').textContent = len;
  $('smsSegments').textContent = smsSegments(len) > 1 ? `${smsSegments(len)} segments` : '1 segment';
}

function smsSegments(len) {
  const GSM7 = /^[\x00-\x7F]*$/.test($('smsBody').value) ? 153 : 67;
  return len <= (GSM7 === 153 ? 160 : 70) ? 1 : Math.ceil(len / GSM7);
}

function insertEmoji(emoji) {
  const ta = $('smsBody');
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
  ta.focus();
  const pos = start + emoji.length;
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input'));
}
document.querySelectorAll('.emoji-palette button').forEach((b) => {
  b.addEventListener('click', () => insertEmoji(b.dataset.emoji));
});

$('btnSendMessage').addEventListener('click', () => {
  $('messageError').textContent = '';
  const recipient = $('smsRecipient').value.trim();
  const message = $('smsBody').value.trim();
  const attachmentFile = $('smsAttachment').files[0] || null;
  const attachmentExpiry = $('smsAttachmentExpiry').value;
  if (!/^\+?[0-9]{4,15}$/.test(recipient)) {
    $('messageError').textContent = 'Numéro de téléphone invalide.';
    return;
  }
  if (!message) {
    $('messageError').textContent = 'Le message est vide.';
    return;
  }
  $('confirmTitle').textContent = "Confirmer l'envoi du SMS";
  $('confirmBody').innerHTML = `
    <p><b>Destinataire :</b> <span class="code">${esc(recipient)}</span></p>
    <p><b>Message :</b><br>${esc(message)}</p>
    ${attachmentFile ? `<p><b>Pièce jointe :</b> ${esc(attachmentFile.name)}</p>` : ''}
    <p class="muted">Envoi immédiat.</p>`;
  $('confirmError').textContent = '';
  $('confirmModal').classList.remove('hidden');
  pendingAdminSend = async () => {
    const attachment = attachmentFile ? await uploadAttachment(attachmentFile, attachmentExpiry) : null;
    await api('/admin/api/messages', {
      method: 'POST',
      body: JSON.stringify({ recipient, message, attachmentId: attachment ? attachment.id : null })
    });
    $('messageModal').classList.add('hidden');
    $('smsAttachment').value = '';
    loadMessages();
  };
});
let pendingAdminSend = null;
$('btnCancelConfirm').addEventListener('click', () => {
  pendingAdminSend = null;
  $('confirmModal').classList.add('hidden');
});
$('btnConfirmSend').addEventListener('click', async () => {
  const fn = pendingAdminSend;
  if (!fn) return;
  $('confirmError').textContent = '';
  try {
    await fn();
    pendingAdminSend = null;
    $('confirmModal').classList.add('hidden');
  } catch (e) {
    $('confirmError').textContent = e.message;
  }
});

// ---------- Import CSV ----------
const PHONE_RE = /^\+?[0-9]{4,15}$/;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_IMPORT = 5000;
let parsedImport = null;

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const counts = [';', ',', '\t'].map((s) => ({ s, n: firstLine.split(s).length - 1 }));
  const sep = counts.reduce((a, b) => (b.n > a.n ? b : a), { s: ';', n: 0 }).s;
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, sep };
}

function analyzeCsv(rows) {
  const seen = new Set();
  const items = [];
  const duplicates = [];
  const invalid = [];
  let header = false;
  let longCount = 0;

  const first = (rows[0] || []).map((c) => String(c ?? '').trim());
  if (first[0] && !PHONE_RE.test(first[0])) header = true;

  for (let i = header ? 1 : 0; i < rows.length; i++) {
    const cols = rows[i].map((c) => String(c ?? '').trim());
    while (cols.length > 0 && cols[cols.length - 1] === '') cols.pop();
    const recipient = cols[0] || '';
    const message = cols[1] || '';
    if (!recipient && !message) continue;
    const errs = [];
    if (!PHONE_RE.test(recipient)) errs.push(`Numéro invalide (« ${recipient || '(vide)'} »)`);
    if (!message) errs.push('Message vide');
    else if (message.length > MAX_MESSAGE_LENGTH) errs.push(`Message trop long (${message.length}/${MAX_MESSAGE_LENGTH})`);
    if (errs.length) {
      invalid.push({ line: i + 1, recipient, message, error: errs.join(', ') });
      continue;
    }
    if (message.length > 160) longCount++;
    const key = recipient + '\u0001' + message;
    if (seen.has(key)) {
      duplicates.push({ line: i + 1, recipient, message });
      continue;
    }
    seen.add(key);
    items.push({ recipient, message });
  }
  return { items, duplicates, invalid, header, totalRows: rows.length, longCount };
}

function handleCsvFile(file) {
  $('importError').textContent = '';
  $('importResult').classList.add('hidden');
  $('dropZone').querySelector('p').textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { rows } = parseCsv(String(reader.result || ''));
      const analysis = analyzeCsv(rows);
      parsedImport = analysis;
      if (analysis.items.length > MAX_IMPORT) {
        $('importError').textContent = `Fichier trop volumineux (${analysis.items.length} SMS, max ${MAX_IMPORT}).`;
        return;
      }
      const longNote = analysis.longCount > 0 ? ` · ${analysis.longCount} message(s) long(s) → multipart` : '';
      const summary = `Fichier : ${analysis.totalRows} ligne(s)${analysis.header ? ' (entête ignorée)' : ''} — ` +
        `<strong>${analysis.items.length} SMS à envoyer</strong> · ${analysis.duplicates.length} doublon(s) ignoré(s) · ${analysis.invalid.length} ligne(s) invalide(s)${longNote}.`;
      $('importSummary').innerHTML = summary;
      $('btnConfirmImport').textContent = `Envoyer ${analysis.items.length} SMS`;
      const inv = $('importInvalid');
      if (analysis.invalid.length) {
        inv.classList.remove('hidden');
        inv.innerHTML = '<p class="error" style="margin:10px 0 4px">Lignes invalides (ignorées) :</p><ul>' +
          analysis.invalid.slice(0, 20).map((i) => `<li>Ligne ${i.line} : ${esc(i.recipient)} — ${esc(i.error)}</li>`).join('') +
          (analysis.invalid.length > 20 ? `<li>… et ${analysis.invalid.length - 20} autre(s)</li>` : '') + '</ul>';
      } else {
        inv.classList.add('hidden');
      }
      if (analysis.items.length === 0 && analysis.invalid.length === 0) {
        $('importError').textContent = 'Aucun SMS valide trouvé dans ce fichier.';
        return;
      }
      $('importResult').classList.remove('hidden');
    } catch (e) {
      $('importError').textContent = 'Impossible de lire le fichier : ' + e.message;
    }
  };
  reader.onerror = () => { $('importError').textContent = 'Erreur de lecture du fichier.'; };
  reader.readAsText(file, 'utf-8');
}

$('btnImportCsv').addEventListener('click', () => {
  parsedImport = null;
  $('csvFile').value = '';
  $('importError').textContent = '';
  $('importResult').classList.add('hidden');
  $('dropZone').querySelector('p').textContent = 'Cliquez ou déposez le fichier ici';
  $('importModal').classList.remove('hidden');
});
$('btnCancelImport').addEventListener('click', () => $('importModal').classList.add('hidden'));
$('dropZone').addEventListener('click', () => $('csvFile').click());
['dragover', 'dragleave', 'drop'].forEach((ev) =>
  $('dropZone').addEventListener(ev, (e) => e.preventDefault()));
$('dropZone').addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleCsvFile(f);
});
$('csvFile').addEventListener('change', () => {
  const f = $('csvFile').files[0];
  if (f) handleCsvFile(f);
});
$('btnConfirmImport').addEventListener('click', async () => {
  if (!parsedImport || parsedImport.items.length === 0) return;
  $('importError').textContent = '';
  try {
    const res = await api('/admin/api/messages/import', {
      method: 'POST',
      body: JSON.stringify({ messages: parsedImport.items })
    });
    $('importModal').classList.add('hidden');
    loadMessages();
    alert(`Import terminé : ${res.created} SMS créé(s), ${res.duplicates} doublon(s) ignoré(s), ${res.invalid.length} ligne(s) invalide(s).`);
  } catch (e) {
    $('importError').textContent = e.message;
  }
});

// ---------- Logs ----------
async function loadLogs() {
  const limit = $('logLimit').value;
  const [logs, authLogs] = await Promise.all([
    api(`/admin/api/logs?limit=${limit}`),
    api(`/admin/api/auth-logs?limit=${limit}`)
  ]);
  $('logsBody').innerHTML = logs.length
    ? logs.map((l) => `<tr>
        <td>${fmtDate(l.created_at)}</td>
        <td>${esc(l.gateway_label || '—')}</td>
        <td class="code">${esc(l.device_id || '—')}</td>
        <td>${l.reports}</td>
        <td>${l.claimed}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">Aucun appel enregistré.</td></tr>';
  $('authLogsBody').innerHTML = authLogs.length
    ? authLogs.map((a) => `<tr>
        <td>${fmtDate(a.created_at)}</td>
        <td>${esc(a.gateway_label || `clé #${a.key_id}`)}</td>
        <td class="code">${esc(a.ip || '—')}</td>
        <td class="muted">${esc(a.reason)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">Aucune tentative échouée.</td></tr>';
}
$('logLimit').addEventListener('change', loadLogs);

// ---------- Journal de la console ----------
const JOURNAL_LABELS = {
  connexion: 'Connexion',
  envoi: 'Envoi SMS',
  import: 'Import CSV',
  campagne: 'Campagne',
  'verif flotte': 'Vérification flotte'
};

function shortUA(ua) {
  if (!ua) return '—';
  const browser = /Edg\/([\d.]+)/.exec(ua) ? `Edge ${/Edg\/([\d.]+)/.exec(ua)[1]}`
    : /OPR\/([\d.]+)/.exec(ua) ? `Opera ${/OPR\/([\d.]+)/.exec(ua)[1]}`
    : /Chrome\/([\d.]+)/.exec(ua) ? `Chrome ${/Chrome\/([\d.]+)/.exec(ua)[1]}`
    : /Firefox\/([\d.]+)/.exec(ua) ? `Firefox ${/Firefox\/([\d.]+)/.exec(ua)[1]}`
    : /Safari\//.test(ua) ? 'Safari'
    : /curl\//.test(ua) ? 'curl'
    : 'Autre';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} · ${os}` : browser;
}

async function loadJournal() {
  const limit = $('journalLimit').value;
  const logs = await api(`/admin/api/console-logs?limit=${limit}`);
  $('journalBody').innerHTML = logs.length
    ? logs.map((l) => `<tr>
        <td>${fmtDate(l.created_at)}</td>
        <td>${esc(l.login)}</td>
        <td>${esc(JOURNAL_LABELS[l.action] || l.action)}</td>
        <td class="muted">${esc(l.detail || '—')}</td>
        <td>${l.count}</td>
        <td class="code">${esc(l.ip || '—')}</td>
        <td class="muted" title="${esc(l.user_agent || '')}">${esc(shortUA(l.user_agent))}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Aucune activité enregistrée pour le moment.</td></tr>';
}
$('journalLimit').addEventListener('change', loadJournal);

// ---------- Synchronisation de carnets ----------
let syncCache = null;
let browseSourceId = null;

function syncStateBadge(s) {
  if (!s || !s.last_status) return '<span class="muted">jamais</span>';
  return s.last_status === 'ok' ? badge('OK', 'ok') : badge('Erreur', 'failed');
}

function renderSyncSources(sources) {
  $('syncSourcesBody').innerHTML = sources.length
    ? sources.map((s) => `<tr>
        <td>${esc(s.label)}</td>
        <td class="code">${esc(s.url)}</td>
        <td>${s.book_count}</td>
        <td>${s.last_synced_at ? fmtDate(s.last_synced_at) : '<span class="muted">jamais</span>'}</td>
        <td>${syncStateBadge(s)}${s.last_error ? `<div class="muted" title="${esc(s.last_error)}">${esc(s.last_error)}</div>` : ''}</td>
        <td>
          <button data-synctest="${s.id}" class="ghost">Tester</button>
          <button data-syncbrowse="${s.id}" class="ghost">Parcourir</button>
          <button data-syncsource-del="${s.id}" class="danger">Supprimer</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="muted">Aucune source distante. Ajoutez-en une ci-contre.</td></tr>';
}

function renderSyncBooks(books) {
  $('syncBooksBody').innerHTML = books.length
    ? books.map((b) => `<tr>
        <td>${esc(syncCache && syncCache.sources.find((s) => s.id === b.source_id)?.label || `source #${b.source_id}`)}</td>
        <td>${b.local_book_id ? `${esc(b.local_book_name)} <span class="badge ok">admin</span>` : '<span class="muted">non créé</span>'}</td>
        <td>${esc(b.remote_book_name)}</td>
        <td>${b.contact_count}</td>
        <td>${b.last_synced_at ? fmtDate(b.last_synced_at) : '<span class="muted">jamais</span>'}</td>
        <td>${syncStateBadge(b)}${b.last_error ? `<div class="muted" title="${esc(b.last_error)}">${esc(b.last_error)}</div>` : ''}</td>
        <td>
          <button data-syncrun="${b.id}" class="ghost">Synchroniser maintenant</button>
          <button data-syncbook-del="${b.id}" class="danger">Retirer</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Aucun carnet synchronisé.</td></tr>';
}

async function loadSync() {
  syncCache = await api('/admin/api/sync-sources');
  renderSyncSources(syncCache.sources || []);
  renderSyncBooks(syncCache.books || []);
}

$('btnAddSyncSource').addEventListener('click', async () => {
  $('syncSourceError').textContent = '';
  try {
    await api('/admin/api/sync-sources', {
      method: 'POST',
      body: JSON.stringify({
        label: $('syncLabel').value.trim(),
        url: $('syncUrl').value.trim(),
        apiKey: $('syncKey').value.trim()
      })
    });
    $('syncLabel').value = '';
    $('syncUrl').value = '';
    $('syncKey').value = '';
    loadSync();
  } catch (e) { $('syncSourceError').textContent = e.message; }
});

$('syncSourcesBody').addEventListener('click', async (e) => {
  const test = e.target.closest('[data-synctest]');
  const browse = e.target.closest('[data-syncbrowse]');
  const del = e.target.closest('[data-syncsource-del]');
  if (test) {
    try {
      const res = await api(`/admin/api/sync-sources/${test.dataset.synctest}/test`, { method: 'POST' });
      alert(res.message || 'Connexion OK');
    } catch (err) { alert(err.message); }
  } else if (browse) {
    $('syncBrowseError').textContent = '';
    browseSourceId = Number(browse.dataset.syncbrowse);
    try {
      const data = await api(`/admin/api/sync-sources/${browseSourceId}/browse`, { method: 'POST' });
      $('syncBrowseTitle').textContent = `Carnets disponibles sur « ${data.sourceLabel} » — cochez ceux à synchroniser.${data.self ? ' (instance locale détectée)' : ''}`;
      $('syncBrowseBody').innerHTML = (data.books || []).length
        ? data.books.map((b) => `<tr>
            <td><input type="checkbox" value="${b.id}" ${b.synced ? 'checked disabled' : ''}></td>
            <td>${esc(b.name)}${b.synced ? ' <span class="badge ok">déjà synchronisé</span>' : ''}</td>
            <td>${esc(b.group_name)}</td>
            <td>${b.contact_count}</td>
            <td class="muted">—</td>
          </tr>`).join('')
        : '<tr><td colspan="5" class="muted">Aucun carnet sur cette instance.</td></tr>';
      $('syncBrowseWrap').classList.remove('hidden');
    } catch (err) { $('syncBrowseError').textContent = err.message; }
  } else if (del) {
    if (!confirm('Supprimer cette source et tous les carnets synchronisés associés ?')) return;
    try {
      await api(`/admin/api/sync-sources/${del.dataset.syncsourceDel}`, { method: 'DELETE' });
      loadSync();
    } catch (err) { alert(err.message); }
  }
});

$('btnSyncSelected').addEventListener('click', async () => {
  $('syncBrowseError').textContent = '';
  const checked = Array.from(document.querySelectorAll('#syncBrowseBody input:checked:not(:disabled)'))
    .map((i) => Number(i.value));
  if (!checked.length) { $('syncBrowseError').textContent = 'Cochez au moins un carnet.'; return; }
  try {
    const res = await api(`/admin/api/sync-sources/${browseSourceId}/books`, {
      method: 'POST',
      body: JSON.stringify({ bookIds: checked })
    });
    $('syncBrowseWrap').classList.add('hidden');
    alert(`Synchronisation activée : ${res.results.length} carnet(s) créé(s) localement.`);
    loadSync();
  } catch (err) { $('syncBrowseError').textContent = err.message; }
});

$('btnCancelBrowse').addEventListener('click', () => {
  $('syncBrowseWrap').classList.add('hidden');
  browseSourceId = null;
});

$('syncBooksBody').addEventListener('click', async (e) => {
  const run = e.target.closest('[data-syncrun]');
  const del = e.target.closest('[data-syncbook-del]');
  if (run) {
    try {
      const res = await api(`/admin/api/sync-books/${run.dataset.syncrun}/run`, { method: 'POST' });
      alert(`${res.contacts} contact(s) synchronisé(s).`);
      loadSync();
    } catch (err) { alert(err.message); loadSync(); }
  } else if (del) {
    if (!confirm('Retirer cette synchronisation ? Le carnet local et ses contacts seront supprimés.')) return;
    try {
      await api(`/admin/api/sync-books/${del.dataset.syncbookDel}`, { method: 'DELETE' });
      loadSync();
    } catch (err) { alert(err.message); }
  }
});

// ---------- Mail → SMS ----------
let mail2smsEditId = null;
let mail2smsBoxes = [];

function showM2sResult(title, text) {
  $('m2sResultTitle').textContent = title;
  $('m2sResultBody').textContent = text;
  $('m2sResultModal').classList.remove('hidden');
}

$('btnCloseM2sResult').addEventListener('click', () => $('m2sResultModal').classList.add('hidden'));

function mail2smsStateBadge(b) {
  if (!b.active) return badge('Désactivée', 'off');
  if (b.last_status === 'error') return badge('Erreur', 'failed');
  return badge('Active', 'ok');
}

function mail2smsEmailBadge(s) {
  const map = {
    processed: ['Traité', 'ok'],
    error: ['Erreur', 'failed'],
    ignored: ['Ignoré', 'off'],
    replied: ['Répondu', 'ok'],
    replied_error: ['Répondu (erreur)', 'revoked']
  };
  const [label, cls] = map[s] || [s, 'off'];
  return badge(label, cls);
}

function renderMail2SmsBoxes(boxes) {
  $('mail2smsBoxesBody').innerHTML = boxes.length
    ? boxes.map((b) => `<tr>
        <td>${esc(b.name)}</td>
        <td class="code">${esc(b.email)}</td>
        <td class="code">${esc(b.imap_host)}:${b.imap_port}${b.imap_secure ? ' (TLS)' : ''}</td>
        <td class="code">${esc(String(b.allowed_senders).split('\n').join(' · '))}</td>
        <td>${b.last_scan_at ? fmtDate(b.last_scan_at) : '<span class="muted">jamais</span>'}</td>
        <td>${mail2smsStateBadge(b)}${b.last_error ? `<div class="muted" title="${esc(b.last_error)}">${esc(b.last_error)}</div>` : ''}</td>
        <td>
          <button data-m2s-test="${b.id}" class="ghost">Tester</button>
          <button data-m2s-smtp="${b.id}" class="ghost">Tester SMTP</button>
          <button data-m2s-scan="${b.id}" class="ghost">Scanner</button>
          <button data-m2s-edit="${b.id}" class="ghost">Éditer</button>
          <button data-m2s-del="${b.id}" class="danger">Supprimer</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Aucune boîte configurée. Ajoutez-en une ci-dessus.</td></tr>';
}

function renderMail2SmsEmails(emails) {
  $('mail2smsEmailsBody').innerHTML = emails.length
    ? emails.map((e) => `<tr>
        <td>${fmtDate(e.received_at)}</td>
        <td>${esc(e.box_name)}</td>
        <td class="code">${esc(e.from_addr)}</td>
        <td>${esc(e.subject)}</td>
        <td>${e.recipient_count || 0} dest. / ${e.message_count || 0} SMS</td>
        <td>${mail2smsEmailBadge(e.status)}</td>
        <td>${e.reply_sent_at
            ? fmtDate(e.reply_sent_at)
            : (e.status === 'ignored' ? '—' : (e.reply_error
                ? `<span class="muted" title="${esc(e.reply_error)}">échec (${e.reply_attempts})</span>
                   <button data-m2s-retry-reply="${e.id}" data-m2s-box="${e.box_id}" class="ghost">Réessayer</button>
                   <div class="muted" style="white-space:normal;font-size:12px">${esc(String(e.reply_error).slice(0, 120))}${e.reply_error.length > 120 ? '…' : ''}</div>`
                : 'en attente'))}</td>
        <td class="muted">${esc(e.error || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="muted">Aucun e-mail traité pour le moment.</td></tr>';
}

async function loadMail2Sms() {
  const data = await api('/admin/api/mail2sms');
  mail2smsBoxes = data.boxes || [];
  renderMail2SmsBoxes(mail2smsBoxes);
  renderMail2SmsEmails(data.emails || []);
}

function resetMail2SmsForm() {
  mail2smsEditId = null;
  ['m2sName', 'm2sEmail', 'm2sLogin', 'm2sPassword', 'm2sImapHost', 'm2sAllowed', 'm2sSmtpHost', 'm2sSmtpPort', 'm2sSmtpLogin', 'm2sSmtpPassword', 'm2sReplySubject'].forEach((id) => { $(id).value = ''; });
  $('m2sImapPort').value = '993';
  $('m2sImapFolder').value = 'INBOX';
  $('m2sProcessedFolder').value = 'SMS Traités';
  $('m2sScanInterval').value = '60';
  $('m2sReplyDelay').value = '5';
  $('m2sImapSecure').checked = true;
  $('m2sActive').checked = true;
  $('m2sReplyEnabled').checked = true;
  $('m2sSmtpSecure').checked = true;
  $('m2sFormTitle').textContent = 'Nouvelle boîte mail';
  $('btnSaveMailBox').textContent = 'Ajouter la boîte';
  $('btnCancelMailEdit').classList.add('hidden');
  $('mail2smsError').textContent = '';
}

function fillMail2SmsForm(b) {
  mail2smsEditId = b.id;
  $('m2sName').value = b.name;
  $('m2sEmail').value = b.email;
  $('m2sLogin').value = b.login;
  $('m2sPassword').value = '';
  $('m2sImapHost').value = b.imap_host;
  $('m2sImapPort').value = b.imap_port;
  $('m2sImapFolder').value = b.imap_folder || 'INBOX';
  $('m2sProcessedFolder').value = b.processed_folder || 'SMS Traités';
  $('m2sImapSecure').checked = !!b.imap_secure;
  $('m2sAllowed').value = b.allowed_senders;
  $('m2sScanInterval').value = b.scan_interval_sec;
  $('m2sActive').checked = !!b.active;
  $('m2sReplyEnabled').checked = !!b.reply_enabled;
  $('m2sReplyDelay').value = b.reply_delay_min;
  $('m2sReplySubject').value = b.reply_subject || 'Re: ';
  $('m2sSmtpHost').value = b.smtp_host || '';
  $('m2sSmtpPort').value = b.smtp_port || '';
  $('m2sSmtpLogin').value = b.smtp_login || '';
  $('m2sSmtpPassword').value = '';
  $('m2sSmtpSecure').checked = b.smtp_secure !== 0;
  $('m2sFormTitle').textContent = `Modifier la boîte « ${b.name} »`;
  $('btnSaveMailBox').textContent = 'Enregistrer';
  $('btnCancelMailEdit').classList.remove('hidden');
  $('mail2smsError').textContent = '';
}

function mail2smsFormPayload() {
  return {
    name: $('m2sName').value.trim(),
    email: $('m2sEmail').value.trim(),
    login: $('m2sLogin').value.trim(),
    password: $('m2sPassword').value,
    imapHost: $('m2sImapHost').value.trim(),
    imapPort: $('m2sImapPort').value,
    imapFolder: $('m2sImapFolder').value.trim(),
    processedFolder: $('m2sProcessedFolder').value.trim() || 'SMS Traités',
    imapSecure: $('m2sImapSecure').checked,
    allowedSenders: $('m2sAllowed').value.trim(),
    scanIntervalSec: $('m2sScanInterval').value,
    active: $('m2sActive').checked,
    replyEnabled: $('m2sReplyEnabled').checked,
    replyDelayMin: $('m2sReplyDelay').value,
    replySubject: $('m2sReplySubject').value,
    smtpHost: $('m2sSmtpHost').value.trim(),
    smtpPort: $('m2sSmtpPort').value,
    smtpLogin: $('m2sSmtpLogin').value.trim(),
    smtpPassword: $('m2sSmtpPassword').value,
    smtpSecure: $('m2sSmtpSecure').checked
  };
}

$('btnSaveMailBox').addEventListener('click', async () => {
  $('mail2smsError').textContent = '';
  try {
    const payload = mail2smsFormPayload();
    if (mail2smsEditId) {
      await api(`/admin/api/mail2sms/${mail2smsEditId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/admin/api/mail2sms', { method: 'POST', body: JSON.stringify(payload) });
    }
    resetMail2SmsForm();
    loadMail2Sms();
  } catch (e) { $('mail2smsError').textContent = e.message; }
});

$('btnCancelMailEdit').addEventListener('click', resetMail2SmsForm);

$('btnScanAllMail').addEventListener('click', async () => {
  try {
    await api('/admin/api/mail2sms/scan-all', { method: 'POST' });
    showM2sResult('Scanner toutes les boîtes', 'Relevé déclenché pour toutes les boîtes actives.\nLes résultats détaillés sont disponibles dans la colonne « État » de chaque boîte.');
    loadMail2Sms();
  } catch (e) { showM2sResult('Scanner toutes les boîtes', `Échec : ${e.message}`); }
});

$('mail2smsBoxesBody').addEventListener('click', async (e) => {
  const test = e.target.closest('[data-m2s-test]');
  const smtp = e.target.closest('[data-m2s-smtp]');
  const scan = e.target.closest('[data-m2s-scan]');
  const edit = e.target.closest('[data-m2s-edit]');
  const del = e.target.closest('[data-m2s-del]');
  if (test) {
    const box = mail2smsBoxes.find((b) => b.id === Number(test.dataset.m2sTest));
    const name = box ? box.name : `boîte #${test.dataset.m2sTest}`;
    try {
      const res = await api(`/admin/api/mail2sms/${test.dataset.m2sTest}/test`, { method: 'POST' });
      const lines = [
        `Test de connexion IMAP — boîte « ${name} »`,
        '',
        `Connexion : OK`,
        `Messages dans « ${(box && box.imap_folder) || 'INBOX'} » : ${res.messages}`,
        `Non lus : ${res.unseen}`,
        '',
        'Le test vérifie uniquement l\'accès à la boîte. Il ne moissonne rien et n\'envoie aucun SMS.'
      ];
      showM2sResult('Test de connexion IMAP', lines.join('\n'));
    } catch (err) {
      showM2sResult(`Test de connexion IMAP — « ${name} »`, `Échec de la connexion :\n\n${err.message}`);
    }
  } else if (smtp) {
    const box = mail2smsBoxes.find((b) => b.id === Number(smtp.dataset.m2sSmtp));
    const name = box ? box.name : `boîte #${smtp.dataset.m2sSmtp}`;
    showM2sResult(`Test SMTP — « ${name} »`, 'Test SMTP en cours…');
    try {
      const res = await api(`/admin/api/mail2sms/${smtp.dataset.m2sSmtp}/test-smtp`, { method: 'POST' });
      const lines = [
        `Test SMTP — boîte « ${name} »`,
        '',
        ...(res.results || []).map((r) => `${r.ok ? 'OK' : 'ÉCHEC'} — ${r.label}${r.error ? ` : ${r.error}` : ''}`),
        '',
        res.ok
          ? 'Connexion SMTP fonctionnelle : le compte-rendu devrait partir.'
          : 'Aucune variante ne répond : le port est probablement bloqué depuis ce serveur ou les identifiants sont invalides.'
      ];
      showM2sResult('Test SMTP', lines.join('\n'));
    } catch (err) {
      showM2sResult(`Test SMTP — « ${name} »`, `Échec du test :\n\n${err.message}`);
    }
  } else if (scan) {
    if (scan.dataset.m2sBusy) return;
    scan.dataset.m2sBusy = '1';
    const box = mail2smsBoxes.find((b) => b.id === Number(scan.dataset.m2sScan));
    const name = box ? box.name : `boîte #${scan.dataset.m2sScan}`;
    const lines = [`Relevé de la boîte « ${name} »`, ''];
    const renderLines = () => { $('m2sResultBody').textContent = lines.join('\n'); };
    showM2sResult('Relevé de la boîte', lines.join('\n'));
    renderLines();
    try {
      await api(`/admin/api/mail2sms/${scan.dataset.m2sScan}/scan`, { method: 'POST' });
      const started = Date.now();
      let finished = false;
      while (!finished && Date.now() - started < 30 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 1000));
        let job;
        try {
          job = await api(`/admin/api/mail2sms/${scan.dataset.m2sScan}/scan-status`);
        } catch (err) {
          lines.push(`Erreur du suivi : ${err.message}`);
          break;
        }
        if (job && Array.isArray(job.lines) && job.lines.length) {
          lines.length = 2;
          lines.push(...job.lines);
          renderLines();
        }
        if (job && (job.status === 'done' || job.status === 'error')) finished = true;
      }
      if (!finished) lines.push('Le relevé continue en arrière-plan ; l\'état de la boîte sera mis à jour.');
      renderLines();
      loadMail2Sms();
    } catch (err) {
      lines.push(`Échec du déclenchement : ${err.message}`);
      renderLines();
      loadMail2Sms();
    } finally {
      delete scan.dataset.m2sBusy;
    }
  } else if (edit) {
    const box = mail2smsBoxes.find((b) => b.id === Number(edit.dataset.m2sEdit));
    if (box) fillMail2SmsForm(box);
  } else if (del) {
    if (!confirm('Supprimer cette boîte et l\'historique des e-mails traités ?')) return;
    try {
      await api(`/admin/api/mail2sms/${del.dataset.m2sDel}`, { method: 'DELETE' });
      loadMail2Sms();
    } catch (err) { alert(err.message); }
  }
});

$('mail2smsEmailsBody').addEventListener('click', async (e) => {
  const retryReply = e.target.closest('[data-m2s-retry-reply]');
  if (!retryReply) return;
  const emailId = retryReply.dataset.m2sRetryReply;
  const boxId = retryReply.dataset.m2sBox;
  try {
    await api(`/admin/api/mail2sms/${boxId}/retry-reply/${emailId}`, { method: 'POST' });
    showM2sResult('Compte-rendu', 'Envoi du compte-rendu relancé. Le résultat apparaîtra dans le tableau des e-mails.');
    loadMail2Sms();
  } catch (err) { alert(err.message); }
});

// ---------- Comptes ----------
let pendingAccountId = null;
let pendingAccountEdit = false;
let groupsCache = [];

async function loadGroupsOptions() {
  try {
    groupsCache = await api('/admin/api/groups');
  } catch { groupsCache = []; }
  return groupsCache;
}

async function loadAccounts() {
  const accounts = await api('/admin/api/accounts');
  $('accountsBody').innerHTML = accounts.length
    ? accounts.map((a) => {
        const state = a.disabled ? badge('Désactivé', 'revoked') : badge('Actif', 'ok');
        const toggleLabel = a.disabled ? 'Activer' : 'Désactiver';
        const roleBadge = a.role === 'admin' ? badge('Admin', 'ok') : badge('Utilisateur', 'off');
        return `<tr>
          <td>${a.id}</td>
          <td>${esc(a.login)}</td>
          <td>${roleBadge}</td>
          <td>${esc(a.group_name || '—')}</td>
          <td>${esc(a.email || '—')}</td>
          <td><input type="checkbox" data-manager="${a.id}" ${a.is_group_manager ? 'checked' : ''} ${a.role !== 'admin' && !a.group_id ? 'disabled' : ''}></td>
          <td>${fmtDate(a.created_at)}</td>
          <td>${a.last_login_at ? fmtDate(a.last_login_at) : '<span class="muted">jamais</span>'}</td>
          <td>${state}</td>
          <td>
            <button data-editacc="${a.id}" class="ghost">Éditer</button>
            <button data-pwd="${a.id}" class="ghost">Mot de passe</button>
            <button data-toggle="${a.id}" data-disabled="${a.disabled ? 1 : 0}" class="ghost">${toggleLabel}</button>
            <button data-delacc="${a.id}" class="danger">Supprimer</button>
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="10" class="muted">Aucun compte. Les comptes se connectent avec un identifiant et un mot de passe.</td></tr>';
  document.querySelectorAll('[data-pwd]').forEach((b) => {
    b.addEventListener('click', () => openAccountModal(Number(b.dataset.pwd)));
  });
  document.querySelectorAll('[data-editacc]').forEach((b) => {
    b.addEventListener('click', async () => {
      const a = accounts.find((x) => x.id === Number(b.dataset.editacc));
      if (a) openAccountModal(a.id, a);
    });
  });
  document.querySelectorAll('[data-manager]').forEach((b) => {
    b.addEventListener('change', async () => {
      try {
        await api(`/admin/api/accounts/${b.dataset.manager}`, {
          method: 'PATCH',
          body: JSON.stringify({ isGroupManager: b.checked })
        });
      } catch (e) { alert(e.message); loadAccounts(); }
    });
  });
  document.querySelectorAll('[data-toggle]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api(`/admin/api/accounts/${b.dataset.toggle}/disable`, {
          method: 'POST',
          body: JSON.stringify({ disabled: b.dataset.disabled === '0' })
        });
        loadAccounts();
      } catch (e) { alert(e.message); }
    });
  });
  document.querySelectorAll('[data-delacc]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer définitivement ce compte ?')) return;
      try {
        await api(`/admin/api/accounts/${b.dataset.delacc}`, { method: 'DELETE' });
        loadAccounts();
      } catch (e) { alert(e.message); }
    });
  });
  loadAdminPhone();
}

async function loadAdminPhone() {
  try {
    const s = await api('/admin/api/security');
    $('adminPhone').value = s.adminPhone || '';
  } catch (e) { /* silencieux */ }
}

$('btnSaveAdminPhone').addEventListener('click', async () => {
  try {
    const phone = ($('adminPhone').value || '').trim();
    const s = await api('/admin/api/security/phone', { method: 'POST', body: JSON.stringify({ phone }) });
    $('adminPhoneStatus').textContent = 'Enregistré ✓';
    setTimeout(() => { $('adminPhoneStatus').textContent = ''; }, 2000);
  } catch (e) { alert(e.message); }
});

async function fillGroupSelect(value) {
  const groups = groupsCache.length ? groupsCache : await loadGroupsOptions();
  const options = ['<option value="">Aucun</option>']
    .concat(groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`));
  $('accountGroup').innerHTML = options.join('');
  $('accountGroup').value = value != null ? String(value) : '';
}

async function openAccountModal(id = null, account = null) {
  pendingAccountId = id;
  pendingAccountEdit = !!(id && account);
  $('accountModalError').textContent = '';
  $('accountPassword').value = '';
  $('accountEmail').value = account ? (account.email || '') : '';
  $('accountManager').checked = !!(account && account.is_group_manager);
  await fillGroupSelect(account ? account.group_id : '');
  if (id === null) {
    $('accountModalTitle').textContent = 'Nouveau compte';
    $('accountLoginWrap').classList.remove('hidden');
    $('accountLogin').value = '';
    $('accountRole').value = 'user';
    $('btnSaveAccount').textContent = 'Créer';
  } else if (pendingAccountEdit) {
    $('accountModalTitle').textContent = `Éditer « ${account.login} »`;
    $('accountLoginWrap').classList.add('hidden');
    $('accountRole').value = account.role;
    $('btnSaveAccount').textContent = 'Enregistrer';
  } else {
    $('accountModalTitle').textContent = 'Réinitialiser le mot de passe';
    $('accountLoginWrap').classList.add('hidden');
    $('btnSaveAccount').textContent = 'Enregistrer';
  }
  $('accountModal').classList.remove('hidden');
  if (id === null) $('accountLogin').focus();
  else $('accountPassword').focus();
}

$('btnNewAccount').addEventListener('click', async () => {
  await loadGroupsOptions();
  openAccountModal(null);
});
$('btnCancelAccount').addEventListener('click', () => $('accountModal').classList.add('hidden'));

$('btnSaveAccount').addEventListener('click', async () => {
  $('accountModalError').textContent = '';
  try {
    const role = $('accountRole').value;
    const groupId = $('accountGroup').value ? Number($('accountGroup').value) : null;
    const email = $('accountEmail').value.trim();
    const isGroupManager = $('accountManager').checked;
    if (pendingAccountEdit) {
      await api(`/admin/api/accounts/${pendingAccountId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role, groupId, email, isGroupManager })
      });
    } else if (pendingAccountId === null) {
      await api('/admin/api/accounts', {
        method: 'POST',
        body: JSON.stringify({
          login: $('accountLogin').value,
          password: $('accountPassword').value,
          role,
          groupId,
          email,
          isGroupManager
        })
      });
    } else {
      await api(`/admin/api/accounts/${pendingAccountId}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: $('accountPassword').value })
      });
    }
    $('accountModal').classList.add('hidden');
    loadAccounts();
  } catch (e) {
    $('accountModalError').textContent = e.message;
  }
});

// ---------- Groupes ----------
let pendingGroupId = null;

async function loadGroups() {
  const groups = await api('/admin/api/groups');
  $('groupsBody').innerHTML = groups.length
    ? groups.map((g) => `<tr>
        <td>${g.id}</td>
        <td>${esc(g.name)}</td>
        <td>${g.member_count}</td>
        <td>${esc(g.managers || '—')}</td>
        <td>${g.message_count}</td>
        <td>${fmtDate(g.created_at)}</td>
        <td>
          <button data-editgroup="${g.id}" data-name="${esc(g.name)}" class="ghost">Renommer</button>
          <button data-delgroup="${g.id}" class="danger">Supprimer</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Aucun groupe. Créez un groupe puis rattachez-y les comptes utilisateurs.</td></tr>';
  document.querySelectorAll('[data-editgroup]').forEach((b) => {
    b.addEventListener('click', () => {
      pendingGroupId = Number(b.dataset.editgroup);
      $('groupModalTitle').textContent = 'Renommer le groupe';
      $('groupName').value = b.dataset.name;
      $('btnSaveGroup').textContent = 'Enregistrer';
      $('groupModalError').textContent = '';
      $('groupModal').classList.remove('hidden');
      $('groupName').focus();
    });
  });
  document.querySelectorAll('[data-delgroup]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce groupe ? Les comptes et messages ne seront plus rattachés à aucun groupe, et les carnets du groupe seront supprimés.')) return;
      try {
        await api(`/admin/api/groups/${b.dataset.delgroup}`, { method: 'DELETE' });
        loadGroups();
      } catch (e) { alert(e.message); }
    });
  });
}

$('btnNewGroup').addEventListener('click', () => {
  pendingGroupId = null;
  $('groupModalTitle').textContent = 'Nouveau groupe';
  $('groupName').value = '';
  $('btnSaveGroup').textContent = 'Créer';
  $('groupModalError').textContent = '';
  $('groupModal').classList.remove('hidden');
  $('groupName').focus();
});
$('btnCancelGroup').addEventListener('click', () => $('groupModal').classList.add('hidden'));

$('btnSaveGroup').addEventListener('click', async () => {
  $('groupModalError').textContent = '';
  try {
    if (pendingGroupId === null) {
      await api('/admin/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: $('groupName').value })
      });
    } else {
      await api(`/admin/api/groups/${pendingGroupId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: $('groupName').value })
      });
    }
    $('groupModal').classList.add('hidden');
    loadGroups();
  } catch (e) {
    $('groupModalError').textContent = e.message;
  }
});

// ---------- Carnets d'adresses (admin) ----------
let viewBookId = null;
let pendingBookId = null;
let pendingContactId = null;
let adminBooks = [];
let bookCsvRows = [];
let bookCsvHeaderCells = [];

async function loadBooks() {
  adminBooks = await api('/admin/api/address-books');
  $('booksBody').innerHTML = adminBooks.length
    ? adminBooks.map((b) => `<tr>
        <td>${b.id}</td>
        <td>${esc(b.name)}${b.group_id === null ? ' <span class="sync-pastille" title="Carnet synchronisé — visible administrateur uniquement">Distant</span>' : ''} <span data-bookhistory="${b.id}" class="sms-pastille${b.message_count ? '' : ' empty'}" title="Voir les SMS envoyés">${b.message_count || 0}</span></td>
        <td>${esc(b.group_name || '—')}</td>
        <td>${b.contact_count}</td>
        <td>${fmtDate(b.created_at)}</td>
        <td>
          <button data-editbook="${b.id}" data-name="${esc(b.name)}" class="ghost">Renommer</button>
          <button data-importbook="${b.id}" class="ghost">Importer</button>
          <button data-delbook="${b.id}" class="danger">Supprimer</button>
          <button data-openbook="${b.id}" class="ghost">Ouvrir</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="muted">Aucun carnet d\'adresses.</td></tr>';
  document.querySelectorAll('[data-openbook]').forEach((b) => {
    b.addEventListener('click', () => openBook(Number(b.dataset.openbook)));
  });
  document.querySelectorAll('[data-editbook]').forEach((b) => {
    b.addEventListener('click', () => openBookModal(Number(b.dataset.editbook), b.dataset.name));
  });
  document.querySelectorAll('[data-importbook]').forEach((b) => {
    b.addEventListener('click', () => openBookImportModal(Number(b.dataset.importbook)));
  });
  document.querySelectorAll('[data-delbook]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce carnet et tous ses contacts ?')) return;
      await api(`/admin/api/address-books/${b.dataset.delbook}`, { method: 'DELETE' });
      loadBooks();
    });
  });
  document.querySelectorAll('[data-bookhistory]').forEach((b) => {
    b.addEventListener('click', () => {
      const book = adminBooks.find((x) => x.id === Number(b.dataset.bookhistory));
      openSmsHistory(`SMS envoyés — ${book ? book.name : ''}`, `/admin/api/messages?bookId=${b.dataset.bookhistory}&limit=200`);
    });
  });
}

async function openBook(bookId) {
  viewBookId = bookId;
  const book = adminBooks.find((b) => b.id === bookId);
  $('bookContactsTitle').textContent = `Contacts — ${book ? book.name : ''}`;
  await loadContacts();
  $('booksBody').closest('table').classList.add('hidden');
  $('bookContacts').classList.remove('hidden');
}

$('btnBackBooks').addEventListener('click', () => {
  $('bookContacts').classList.add('hidden');
  $('booksBody').closest('table').classList.remove('hidden');
  loadBooks();
});

async function loadBlacklist() {
  const rows = await api('/admin/api/blacklist');
  $('blacklistBody').innerHTML = rows.length ? rows.map((row) => `<tr><td class="code">${esc(row.phone)}</td><td>${fmtDate(row.created_at)}</td><td><button class="ghost" data-unblacklist="${esc(row.phone)}">Remettre normal</button></td></tr>`).join('') : '<tr><td colspan="3" class="muted">Aucun numéro blacklisté.</td></tr>';
  document.querySelectorAll('[data-unblacklist]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/admin/api/blacklist/${encodeURIComponent(button.dataset.unblacklist)}`, { method: 'DELETE' });
    loadBlacklist(); loadContacts();
  }));
}

$('btnShowBlacklist').addEventListener('click', () => {
  $('blacklistPanel').classList.toggle('hidden');
  if (!$('blacklistPanel').classList.contains('hidden')) loadBlacklist();
});

const CONTACT_COLS = [
  { key: 'first_name', label: 'Prénom' },
  { key: 'last_name', label: 'Nom' },
  { key: 'entity', label: 'Entité' },
  { key: 'service', label: 'Service' },
  { key: 'direction', label: 'Direction' },
  { key: 'imei', label: 'IMEI' },
  { key: 'puk', label: 'PUK' },
  { key: 'line_status', label: 'Statut ligne' },
  { key: 'plan', label: 'Forfait' },
  { key: 'device_terminal', label: 'Terminal com.' },
  { key: 'secondary_line', label: 'Ligne sec.' },
  { key: 'phone', label: 'Téléphone' }
];
let allContacts = [];
let contactVisibleCols = new Set(CONTACT_COLS.map((c) => c.key));
let contactPage = 1;
const CONTACT_PAGE_SIZE = 25;
let contactCounts = {};

function contactTextCells(c) {
  return CONTACT_COLS
    .filter((col) => contactVisibleCols.has(col.key) && c[col.key] != null && String(c[col.key]) !== '')
    .map((col) => String(c[col.key]).toLowerCase())
    .join(' ');
}

function renderContactColToggles() {
  $('contactColToggles').innerHTML = `<span class="muted" style="margin-right:8px">Colonnes :</span>` + CONTACT_COLS.map((col) => {
    const on = contactVisibleCols.has(col.key);
    return `<label style="margin-right:10px;white-space:nowrap"><input type="checkbox" data-contactcol="${col.key}" ${on ? 'checked' : ''}>${esc(col.label)}</label>`;
  }).join('');
}

function renderContactsHead() {
  renderContactColToggles();
  const visible = CONTACT_COLS.filter((c) => contactVisibleCols.has(c.key));
  $('contactsHead').innerHTML = '<tr>' + visible.map((c) => `<th>${esc(c.label)}</th>`).join('') + '<th></th></tr>';
}

function renderContactPagination(filteredCount) {
  const totalPages = Math.max(1, Math.ceil(filteredCount / CONTACT_PAGE_SIZE));
  const el = $('contactPagination');
  const prev = `<button data-cpage="prev" class="ghost" ${contactPage <= 1 ? 'disabled' : ''}>&laquo; Précédent</button>`;
  const next = `<button data-cpage="next" class="ghost" ${contactPage >= totalPages ? 'disabled' : ''}>Suivant &raquo;</button>`;
  el.innerHTML = `${prev}<span class="muted" style="margin:0 10px">Page ${contactPage} / ${totalPages} — ${filteredCount} contact(s)</span>${next}`;
}

function renderContactRows() {
  const visible = CONTACT_COLS.filter((c) => contactVisibleCols.has(c.key));
  const q = $('contactSearch').value.trim().toLowerCase();
  const filtered = q ? allContacts.filter((c) => contactTextCells(c).includes(q)) : allContacts;
  const totalPages = Math.max(1, Math.ceil(filtered.length / CONTACT_PAGE_SIZE));
  if (contactPage > totalPages) contactPage = totalPages;
  const pageItems = filtered.slice((contactPage - 1) * CONTACT_PAGE_SIZE, contactPage * CONTACT_PAGE_SIZE);
  $('contactsBody').innerHTML = pageItems.length
    ? pageItems.map((c) => {
        let tds = '';
        for (const col of visible) {
          if (col.key === 'phone') {
            tds += `<td class="code">${esc(c.phone)} ${c.blacklisted ? '<span class="badge failed">Blacklisté</span>' : ''} <span data-recipient="${esc(c.phone)}" class="sms-pastille${contactCounts[c.phone] ? '' : ' empty'}">${contactCounts[c.phone] || 0}</span></td>`;
          } else {
            tds += `<td>${esc(c[col.key] || '')}</td>`;
          }
        }
        return `<tr>${tds}<td>
          <button data-editcontact="${c.id}" data-cname="${esc(c.first_name || '')}" data-clast="${esc(c.last_name || '')}" data-centity="${esc(c.entity || '')}" data-cservice="${esc(c.service || '')}" data-cdirection="${esc(c.direction || '')}" data-cimei="${esc(c.imei || '')}" data-cpuk="${esc(c.puk || '')}" data-clinestatus="${esc(c.line_status || '')}" data-cplan="${esc(c.plan || '')}" data-cdeviceterminal="${esc(c.device_terminal || '')}" data-csecondaryline="${esc(c.secondary_line || '')}" data-cphone="${esc(c.phone)}" class="ghost">Éditer</button>
          <button data-blacklist-phone="${esc(c.phone)}" class="ghost">${c.blacklisted ? 'Remettre normal' : 'Blacklister'}</button>
          <button data-delcontact="${c.id}" class="ghost">Supprimer</button>
        </td></tr>`;
      }).join('')
    : `<tr><td colspan="${visible.length + 1}" class="muted">Aucun contact.</td></tr>`;
  renderContactPagination(filtered.length);
  document.querySelectorAll('[data-editcontact]').forEach((b) => {
    b.addEventListener('click', () => openContactModal(Number(b.dataset.editcontact), b.dataset));
  });
  document.querySelectorAll('[data-delcontact]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce contact ?')) return;
      await api(`/admin/api/contacts/${b.dataset.delcontact}`, { method: 'DELETE' });
      loadContacts();
    });
  });
  document.querySelectorAll('[data-blacklist-phone]').forEach((b) => {
    b.addEventListener('click', async () => {
      const phone = b.dataset.blacklistPhone;
      if (!confirm(b.textContent === 'Blacklister' ? `Blacklister ${phone} dans tous les carnets ?` : `Remettre ${phone} en service ?`)) return;
      await api(b.textContent === 'Blacklister' ? '/admin/api/blacklist' : `/admin/api/blacklist/${encodeURIComponent(phone)}`, {
        method: b.textContent === 'Blacklister' ? 'POST' : 'DELETE',
        ...(b.textContent === 'Blacklister' ? { body: JSON.stringify({ phone }) } : {})
      });
      loadContacts();
    });
  });
  document.querySelectorAll('[data-recipient]').forEach((b) => {
    b.addEventListener('click', () => {
      openSmsHistory(`SMS envoyés vers ${b.dataset.recipient}`, `/admin/api/messages?recipient=${encodeURIComponent(b.dataset.recipient)}&limit=200`);
    });
  });
}

async function loadContacts() {
  allContacts = await fetchAllBookContacts(viewBookId);
  contactCounts = {};
  const phones = [...new Set(allContacts.map((c) => c.phone))];
  if (phones.length) {
    try {
      const r = await api(`/admin/api/messages/counts?recipients=${encodeURIComponent(phones.join(','))}`);
      contactCounts = r.counts || {};
    } catch { /* pastilles vides si le comptage échoue */ }
  }
  contactPage = 1;
  renderContactsHead();
  renderContactRows();
}

$('contactColToggles').addEventListener('change', (event) => {
  const cb = event.target.closest('[data-contactcol]');
  if (!cb) return;
  if (cb.checked) contactVisibleCols.add(cb.dataset.contactcol);
  else contactVisibleCols.delete(cb.dataset.contactcol);
  renderContactsHead();
  renderContactRows();
});

let contactSearchTimer = null;
$('contactSearch').addEventListener('input', () => {
  clearTimeout(contactSearchTimer);
  contactSearchTimer = setTimeout(() => { contactPage = 1; renderContactRows(); }, 300);
});

$('contactPagination').addEventListener('click', (event) => {
  const b = event.target.closest('[data-cpage]');
  if (!b) return;
  const totalPages = Math.max(1, Math.ceil(allContacts.length / CONTACT_PAGE_SIZE));
  if (b.dataset.cpage === 'prev') contactPage = Math.max(1, contactPage - 1);
  else contactPage = Math.min(totalPages, contactPage + 1);
  renderContactRows();
});

async function fillBookGroupSelect() {
  const groups = await api('/admin/api/groups');
  $('bookGroup').innerHTML = groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('') || '<option value="">—</option>';
}

function openBookModal(id = null, name = '') {
  pendingBookId = id;
  $('bookName').value = name;
  $('bookModalError').textContent = '';
  $('bookModalTitle').textContent = id === null ? 'Nouveau carnet d\'adresses' : 'Renommer le carnet';
  $('btnSaveBook').textContent = id === null ? 'Créer' : 'Enregistrer';
  $('bookGroupWrap').classList.toggle('hidden', id !== null);
  if (id === null) fillBookGroupSelect();
  $('bookModal').classList.remove('hidden');
  $('bookName').focus();
}

$('btnNewBook').addEventListener('click', () => openBookModal(null));
$('btnCancelBook').addEventListener('click', () => $('bookModal').classList.add('hidden'));

$('btnSaveBook').addEventListener('click', async () => {
  $('bookModalError').textContent = '';
  try {
    if (pendingBookId === null) {
      await api('/admin/api/address-books', {
        method: 'POST',
        body: JSON.stringify({ name: $('bookName').value, groupId: Number($('bookGroup').value) })
      });
    } else {
      await api(`/admin/api/address-books/${pendingBookId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: $('bookName').value })
      });
    }
    $('bookModal').classList.add('hidden');
    loadBooks();
  } catch (e) {
    $('bookModalError').textContent = e.message;
  }
});

function openContactModal(id = null, data = null) {
  pendingContactId = id;
  $('contactFirstName').value = data ? data.cname : '';
  $('contactLastName').value = data ? data.clast : '';
  $('contactEntity').value = data ? data.centity : '';
  $('contactService').value = data ? data.cservice : '';
  $('contactDirection').value = data ? data.cdirection : '';
  $('contactImei').value = data ? data.cimei : '';
  $('contactPuk').value = data ? data.cpuk : '';
  $('contactLineStatus').value = data ? data.clinestatus : '';
  $('contactPlan').value = data ? data.cplan : '';
  $('contactDeviceTerminal').value = data ? data.cdeviceterminal : '';
  $('contactSecondaryLine').value = data ? data.csecondaryline : '';
  $('contactPhone').value = data ? data.cphone : '';
  $('contactModalError').textContent = '';
  $('contactModalTitle').textContent = id === null ? 'Nouveau contact' : 'Modifier le contact';
  $('btnSaveContact').textContent = id === null ? 'Créer' : 'Enregistrer';
  $('contactModal').classList.remove('hidden');
  $('contactFirstName').focus();
}

$('btnAddContact').addEventListener('click', () => openContactModal(null));
$('btnCancelContact').addEventListener('click', () => $('contactModal').classList.add('hidden'));

$('btnSaveContact').addEventListener('click', async () => {
  $('contactModalError').textContent = '';
  const body = {
    firstName: $('contactFirstName').value,
    lastName: $('contactLastName').value,
    entity: $('contactEntity').value,
    service: $('contactService').value,
    direction: $('contactDirection').value,
    imei: $('contactImei').value,
    puk: $('contactPuk').value,
    lineStatus: $('contactLineStatus').value,
    plan: $('contactPlan').value,
    deviceTerminal: $('contactDeviceTerminal').value,
    secondaryLine: $('contactSecondaryLine').value,
    phone: $('contactPhone').value
  };
  try {
    if (pendingContactId === null) {
      await api(`/admin/api/address-books/${viewBookId}/contacts`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
    } else {
      await api(`/admin/api/contacts/${pendingContactId}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
    }
    $('contactModal').classList.add('hidden');
    loadContacts();
  } catch (e) {
    $('contactModalError').textContent = e.message;
  }
});

// ---------- Import CSV contacts (admin) ----------
function parseBookCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const counts = [';', ',', '\t'].map((s) => ({ s, n: firstLine.split(s).length - 1 }));
  const sep = counts.reduce((a, b) => (b.n > a.n ? b : a), { s: ';', n: 0 }).s;
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function handleBookCsvFile(file) {
  $('bookImportErrorTop').textContent = '';
  $('bookDropZone').querySelector('p').textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseBookCsv(String(reader.result || ''));
      if (rows.length === 0) {
        $('bookImportErrorTop').textContent = 'Fichier vide.';
        return;
      }
      bookCsvHeaderCells = rows[0].map((c) => String(c ?? '').trim());
      bookCsvRows = rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
      const fields = [
        { v: '', l: '— Ignorer —' },
        { v: 'phone', l: 'Téléphone (obligatoire)' },
        { v: 'firstName', l: 'Prénom' },
        { v: 'lastName', l: 'Nom' },
        { v: 'entity', l: 'Entité' },
        { v: 'service', l: 'Service' },
        { v: 'direction', l: 'Direction' },
        { v: 'imei', l: 'IMEI' },
        { v: 'puk', l: 'PUK' },
        { v: 'lineStatus', l: 'Statut ligne' },
        { v: 'plan', l: 'Forfait' },
        { v: 'deviceTerminal', l: 'Terminal communiquant' },
        { v: 'secondaryLine', l: 'Ligne secondaire' }
      ];
      $('bookMappingBody').innerHTML = bookCsvHeaderCells.map((h, i) => `<tr>
        <td>${esc(h || `Colonne ${i + 1}`)}</td>
        <td><select data-col="${i}">${fields.map((f) => `<option value="${f.v}" ${f.v === 'phone' && i === 0 ? 'selected' : ''}>${f.l}</option>`).join('')}</select></td>
      </tr>`).join('');
      $('bookCsvHeader').classList.remove('hidden');
    } catch (e) {
      $('bookImportErrorTop').textContent = 'Impossible de lire le fichier : ' + e.message;
    }
  };
  reader.onerror = () => { $('bookImportErrorTop').textContent = 'Erreur de lecture du fichier.'; };
  reader.readAsText(file, 'utf-8');
}

function openBookImportModal(bookId) {
  viewBookId = bookId;
  $('bookCsvFile').value = '';
  $('bookImportErrorTop').textContent = '';
  $('bookImportError').textContent = '';
  $('bookCsvHeader').classList.add('hidden');
  $('bookDropZone').querySelector('p').textContent = 'Cliquez ou déposez le fichier ici';
  $('bookImportModal').classList.remove('hidden');
}

$('btnImportBook').addEventListener('click', () => openBookImportModal(viewBookId));
$('btnCancelBookImport').addEventListener('click', () => $('bookImportModal').classList.add('hidden'));
$('bookDropZone').addEventListener('click', () => $('bookCsvFile').click());
['dragover', 'dragleave', 'drop'].forEach((ev) =>
  $('bookDropZone').addEventListener(ev, (e) => e.preventDefault()));
$('bookDropZone').addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleBookCsvFile(f);
});
$('bookCsvFile').addEventListener('change', () => {
  const f = $('bookCsvFile').files[0];
  if (f) handleBookCsvFile(f);
});

$('btnConfirmBookImport').addEventListener('click', async () => {
  $('bookImportError').textContent = '';
  const map = { firstName: '', lastName: '', entity: '', phone: '' };
  document.querySelectorAll('#bookMappingBody select').forEach((s) => {
    const val = s.value;
    if (val) map[val] = s.dataset.col;
  });
  if (map.phone === '') {
    $('bookImportError').textContent = 'Mappez une colonne sur « Téléphone » avant d\'importer.';
    return;
  }
  try {
    const res = await api(`/admin/api/address-books/${viewBookId}/import`, {
      method: 'POST',
      body: JSON.stringify({
        map,
        rows: bookCsvRows,
        overwrite: $('bookOverwrite').checked
      })
    });
    $('bookImportModal').classList.add('hidden');
    loadContacts();
    loadBooks();
    const created = Number(res.created || 0);
    const replaced = Number(res.replaced || 0);
    const blacklisted = Number(res.blacklisted || 0);
    const invalid = Array.isArray(res.invalid) ? res.invalid : [];
    const lines = [];
    lines.push('<p style="margin-top:12px">');
    if (created > 0) lines.push(`<span class="badge ok">${created} numéro(s) importé(s)</span> `);
    if (replaced > 0) lines.push(`<span class="badge pending">${replaced} contact(s) mis à jour</span> `);
    if (Number(res.duplicates || 0) > 0) lines.push(`<span class="badge off">${res.duplicates} doublon(s) ignoré(s)</span> `);
    if (blacklisted > 0) lines.push(`<span class="badge failed">${blacklisted} numéro(s) blacklisté(s)</span> `);
    if (invalid.length > 0) lines.push(`<span class="badge failed">${invalid.length} ligne(s) invalide(s)</span> `);
    lines.push('</p>');
    if (invalid.length > 0) {
      lines.push('<p class="error" style="margin:12px 0 4px">Lignes invalides (non importées) :</p><ul class="import-invalid-list">');
      invalid.slice(0, 20).forEach((i) => {
        lines.push(`<li>Ligne ${i.row ?? '—'} : ${esc(i.phone || '(vide)')} — ${esc(i.error || 'invalide')}</li>`);
      });
      if (invalid.length > 20) lines.push(`<li>… et ${invalid.length - 20} autre(s)</li>`);
      lines.push('</ul>');
    }
    $('bookImportResultTitle').textContent = (created + replaced + blacklisted) > 0 ? 'Import réussi' : 'Import terminé';
    $('bookImportResultBody').innerHTML = lines.join('');
    $('bookImportResultModal').classList.remove('hidden');
  } catch (e) {
    $('bookImportError').textContent = e.message;
  }
});

$('btnCloseBookImportResult').addEventListener('click', () => $('bookImportResultModal').classList.add('hidden'));

// ---------- Vérification de flotte ----------
let fleetContacts = [];
let fleetSelected = new Set();
let fleetCheckId = null;
let fleetBooks = [];

function insertVariable(target, variable) {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, start) + variable + target.value.slice(end);
  target.focus();
  const pos = start + variable.length;
  target.setSelectionRange(pos, pos);
  target.dispatchEvent(new Event('input'));
}
document.querySelectorAll('[data-variable]').forEach((button) => {
  button.addEventListener('click', () => {
    insertVariable($(button.dataset.variableTarget || 'smsBody'), button.dataset.variable);
  });
});

async function excludedPhonesFor(selectId) {
  const bookId = Number($(selectId).value || 0);
  if (!bookId) return new Set();
  const rows = await api(`/admin/api/address-books/${bookId}/contacts`);
  return new Set(rows.map((contact) => contact.phone));
}

async function loadFleet() {
  const booksList = await api('/admin/api/address-books');
  fleetBooks = booksList;
  const select = $('fleetBookSelect');
  const previous = select.value;
  select.innerHTML = ['<option value="">—</option>']
    .concat(booksList.map((book) => `<option value="${book.id}">${esc(book.name)}${book.group_name ? ` (${esc(book.group_name)})` : ''}</option>`)).join('');
  select.value = booksList.some((book) => String(book.id) === previous)
    ? previous : (booksList.length ? String(booksList[0].id) : '');
  fillFleetExcludeBookSelect();
  await loadFleetContacts();
  await loadFleetChecks();
}

function fillFleetExcludeBookSelect() {
  const select = $('fleetExcludeBookSelect');
  const previous = select.value;
  const primaryId = $('fleetBookSelect').value;
  select.innerHTML = '<option value="">— Aucun numéro exclu —</option>' + fleetBooks
    .filter((book) => String(book.id) !== String(primaryId))
    .map((book) => `<option value="${book.id}">${esc(book.name)}</option>`).join('');
  if (fleetBooks.some((book) => String(book.id) === previous && String(book.id) !== String(primaryId))) select.value = previous;
}

async function fetchAllBookContacts(bookId) {
  const all = [];
  let page = 1;
  while (page <= 100) {
    const rows = await api(`/admin/api/address-books/${bookId}/contacts?pageSize=2000&page=${page}`);
    all.push(...rows);
    if (rows.length < 2000) break;
    page++;
  }
  return all;
}

async function loadFleetContacts() {
  const bookId = Number($('fleetBookSelect').value || 0);
  const [bookContacts, excludedPhones] = bookId
    ? await Promise.all([fetchAllBookContacts(bookId), excludedPhonesFor('fleetExcludeBookSelect')])
    : [[], new Set()];
  fleetContacts = bookContacts;
  const isExcluded = (contact) => excludedPhones.has(contact.phone);
  fleetSelected = new Set(fleetContacts.filter((contact) => !contact.blacklisted && !isExcluded(contact) && !contact.recent_checked).map((contact) => contact.id));
  const skipped = fleetContacts.filter((c) => c.recent_checked).length;
  $('fleetContactList').innerHTML = fleetContacts.length
    ? fleetContacts.map((contact) => {
        const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.entity || contact.phone;
        const checked = contact.blacklisted || isExcluded(contact) ? 'disabled' : (contact.recent_checked ? '' : 'checked');
        return `<label class="contact-row"><input type="checkbox" data-fleet-contact="${contact.id}" ${checked}><span class="who"><b>${esc(name)}</b><br><span class="phone">${esc(contact.phone)}</span>${contact.blacklisted ? ' · <span class="badge failed">Blacklisté</span>' : isExcluded(contact) ? ' · <span class="badge off">Exclu</span>' : contact.recent_checked ? ' · <span class="badge off">Déjà vérifié</span>' : ''}</span></label>`;
      }).join('')
    : '<div class="contact-list-empty muted">Ce carnet ne contient aucun contact.</div>';
  updateFleetCount(skipped);
}

function updateFleetCount(skipped) {
  const list = fleetContacts.filter((c) => !c.blacklisted);
  $('fleetCount').textContent = `${fleetSelected.size} / ${list.length} contact(s) sélectionné(s)${skipped ? ` (${skipped} déjà vérifié(s), décoché(s) par défaut)` : ''}`;
}

$('fleetBookSelect').addEventListener('change', async () => {
  fillFleetExcludeBookSelect();
  await loadFleetContacts();
});
$('fleetExcludeBookSelect').addEventListener('change', loadFleetContacts);
$('fleetContactList').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-fleet-contact]');
  if (!checkbox) return;
  const id = Number(checkbox.dataset.fleetContact);
  if (checkbox.checked) fleetSelected.add(id); else fleetSelected.delete(id);
  updateFleetCount();
});

function fleetState(state) {
  return badge({
    pending: 'En attente', sent: 'Envoyé', delivered: 'Remis', replied: 'Répondu', no_response: 'Sans réponse', failed: 'Échec'
  }[state] || state, state === 'replied' ? 'ok' : state === 'failed' ? 'failed' : state === 'no_response' ? 'off' : 'pending');
}

async function loadFleetChecks() {
  const checks = await api('/admin/api/fleet-checks');
  $('fleetChecksBody').innerHTML = checks.length
    ? checks.map((check) => `<tr>
        <td>${check.id}</td><td>${fmtDate(check.created_at)}</td><td>${esc(check.book_name || '—')}</td>
        <td>${check.total || 0}</td><td>${check.delivered || 0}</td><td>${check.replied || 0}</td><td>${check.no_response || 0}</td><td>${check.failed || 0}</td>
        <td><button class="ghost" data-fleet-open="${check.id}">Détails</button></td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="muted">Aucune vérification lancée.</td></tr>';
  document.querySelectorAll('[data-fleet-open]').forEach((button) => {
    button.addEventListener('click', () => openFleetCheck(Number(button.dataset.fleetOpen)));
  });
}

// Colonnes des détails de vérification flotte. La colonne « Réponse » est
// toujours affichée (always). Chaqué colonne visible a un filtre dédié.
const FLEET_COLS = [
  { key: 'first_name', label: 'Prénom' },
  { key: 'last_name', label: 'Nom' },
  { key: 'entity', label: 'Entité' },
  { key: 'service', label: 'Service' },
  { key: 'direction', label: 'Direction' },
  { key: 'imei', label: 'IMEI' },
  { key: 'puk', label: 'PUK' },
  { key: 'line_status', label: 'Statut ligne' },
  { key: 'plan', label: 'Forfait' },
  { key: 'device_terminal', label: 'Terminal com.' },
  { key: 'secondary_line', label: 'Ligne sec.' },
  { key: 'phone', label: 'Téléphone' },
  { key: 'state', label: 'État' },
  { key: 'delivered_at', label: 'Remis le' },
  { key: 'response_at', label: 'Réponse le' },
  { key: 'delay', label: 'Délai' },
  { key: 'response', label: 'Réponse', always: true }
];

let fleetItems = [];
let fleetVisibleCols = new Set(FLEET_COLS.map((c) => c.key));
let fleetStatusFilter = 'all';
let fleetColFilters = {};

const FLEET_STATE_TEXT = { pending: 'en attente', sent: 'envoyé', delivered: 'remis', replied: 'répondu', no_response: 'sans réponse', failed: 'échec' };

function fleetCellText(col, item) {
  switch (col) {
    case 'state': return FLEET_STATE_TEXT[item.state] || item.state || '';
    case 'delivered_at': return item.delivered_at ? fmtDate(item.delivered_at) : '';
    case 'response_at': return item.response_at ? fmtDate(item.response_at) : '';
    case 'delay': return item.response_at && item.delivered_at
      ? `${Math.max(0, Math.round((Date.parse(item.response_at) - Date.parse(item.delivered_at)) / 1000))} s` : '';
    case 'response': return item.response_body || item.error || '';
    default: return item[col] || '';
  }
}

function fleetCell(col, item) {
  if (col === 'state') return fleetState(item.state);
  if (col === 'delay') return item.response_at && item.delivered_at
    ? `${Math.max(0, Math.round((Date.parse(item.response_at) - Date.parse(item.delivered_at)) / 1000))} s` : '—';
  return esc(fleetCellText(col, item) || '—');
}

function fleetMatchesFilters(item) {
  if (fleetStatusFilter === 'replied' && item.state !== 'replied') return false;
  if (fleetStatusFilter === 'failed' && item.state !== 'failed') return false;
  if (fleetStatusFilter === 'no_response' && (item.state === 'replied' || item.state === 'failed')) return false;
  for (const col of FLEET_COLS) {
    if (!fleetVisibleCols.has(col.key)) continue;
    const f = (fleetColFilters[col.key] || '').trim().toLowerCase();
    if (f && !fleetCellText(col.key, item).toLowerCase().includes(f)) return false;
  }
  return true;
}

function renderFleetColToggles() {
  $('fleetColToggles').innerHTML = FLEET_COLS.map((col) => {
    const on = fleetVisibleCols.has(col.key) || col.always;
    const disabled = col.always ? ' disabled' : '';
    return `<label style="margin-right:10px;white-space:nowrap"><input type="checkbox" data-fleetcol="${col.key}" ${on ? 'checked' : ''}${disabled}>${esc(col.label)}${col.always ? ' <span class="muted">(toujours)</span>' : ''}</label>`;
  }).join('');
}

function renderFleetHead() {
  renderFleetColToggles();
  const visible = FLEET_COLS.filter((c) => fleetVisibleCols.has(c.key));
  let head = '<tr>';
  for (const col of visible) head += `<th>${esc(col.label)}${col.always ? ' <span class="muted">*</span>' : ''}</th>`;
  head += '</tr><tr>';
  for (const col of visible) {
    head += `<th><input data-colfilter="${col.key}" value="${esc(fleetColFilters[col.key] || '')}" placeholder="Filtrer…" style="min-width:70px"></th>`;
  }
  head += '</tr>';
  $('fleetItemsHead').innerHTML = head;
}

function renderFleetRows() {
  const visible = FLEET_COLS.filter((c) => fleetVisibleCols.has(c.key));
  const filtered = fleetItems.filter(fleetMatchesFilters);
  $('fleetItemsBody').innerHTML = filtered.length
    ? filtered.map((item) => {
        return `<tr>${visible.map((col) => `<td>${fleetCell(col.key, item)}</td>`).join('')}</tr>`;
      }).join('')
    : `<tr><td colspan="${visible.length}" class="muted">Aucun résultat.</td></tr>`;
  $('fleetDetailCount').textContent = `${filtered.length} / ${fleetItems.length} ligne(s)`;
}

async function openFleetCheck(id) {
  const data = await api(`/admin/api/fleet-checks/${id}`);
  fleetCheckId = id;
  fleetItems = data.items;
  fleetStatusFilter = 'all';
  fleetColFilters = {};
  fleetVisibleCols = new Set(FLEET_COLS.map((c) => c.key));
  $('fleetStatusFilter').value = 'all';
  $('fleetDetailTitle').textContent = `Vérification #${id}`;
  $('fleetDetail').classList.remove('hidden');
  renderFleetHead();
  renderFleetRows();
}

$('fleetStatusFilter').addEventListener('change', () => {
  fleetStatusFilter = $('fleetStatusFilter').value;
  renderFleetRows();
});

$('fleetColToggles').addEventListener('change', (event) => {
  const cb = event.target.closest('[data-fleetcol]');
  if (!cb) return;
  if (cb.checked) fleetVisibleCols.add(cb.dataset.fleetcol);
  else fleetVisibleCols.delete(cb.dataset.fleetcol);
  renderFleetHead();
  renderFleetRows();
});

$('fleetItemsHead').addEventListener('input', (event) => {
  const input = event.target.closest('[data-colfilter]');
  if (!input) return;
  fleetColFilters[input.dataset.colfilter] = input.value;
  renderFleetRows();
});

$('btnExportFleet').addEventListener('click', () => {
  if (fleetCheckId) location.href = `/admin/api/fleet-checks/${fleetCheckId}/export`;
});

$('btnStartFleet').addEventListener('click', async () => {
  $('fleetError').textContent = '';
  const bookId = Number($('fleetBookSelect').value || 0);
  const message = $('fleetMessage').value.trim();
  const contactIds = [...fleetSelected];
  if (!bookId || !contactIds.length || !message) {
    $('fleetError').textContent = 'Sélectionnez un carnet, au moins un contact et saisissez un message.';
    return;
  }
  try {
    const result = await api('/admin/api/fleet-checks', {
      method: 'POST',
      body: JSON.stringify({ bookId, excludeBookId: Number($('fleetExcludeBookSelect').value || 0) || null, contactIds, message })
    });
    alert(`Vérification #${result.id} lancée pour ${result.count} contact(s).`);
    await loadFleetChecks();
    await openFleetCheck(result.id);
  } catch (error) {
    $('fleetError').textContent = error.message;
  }
});

// ---------- Rafraîchissement automatique ----------
document.querySelector('[data-tab="messages"]').click();
refreshOnlineBadge();
setInterval(() => {
  refreshOnlineBadge();
  if (currentTab === 'gateways') loadGateways();
  if (currentTab === 'messages') loadMessages();
  if (currentTab === 'logs') loadLogs();
  if (currentTab === 'mail2sms') loadMail2Sms();
  if (currentTab === 'books' && $('bookContacts').classList.contains('hidden')) loadBooks();
  if (currentTab === 'fleet') {
    loadFleetChecks();
    if (fleetCheckId) openFleetCheck(fleetCheckId);
  }
}, 10000);
