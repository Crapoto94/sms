'use strict';

const $ = (id) => document.getElementById(id);

let currentTab = 'composer';
let session = null;
let books = [];
let contacts = [];

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
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

// ---------- Passerelles en ligne (bandeau) ----------
function updateOnlineBadge(n) {
  const el = $('onlineBadge');
  if (!el) return;
  el.textContent = n;
  el.classList.toggle('off', !n);
  el.title = `${n} passerelle(s) active(s)`;
}

async function refreshOnlineBadge() {
  try {
    const stats = await api('/admin/api/gateways/online');
    updateOnlineBadge(stats.online);
  } catch { /* silencieux */ }
}

// ---------- Historique SMS d'un numéro / d'un carnet ----------
async function openSmsHistory(title, url) {
  const msgs = await api(url);
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
  if (res.status === 403) {
    location.href = '/';
    throw new Error('non autorisé');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------- Onglets ----------
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  $('composer').classList.toggle('hidden', tab !== 'composer');
  $('messages').classList.toggle('hidden', tab !== 'messages');
  $('books').classList.toggle('hidden', tab !== 'books');
  if (tab === 'composer') loadComposer();
  if (tab === 'messages') loadMessages();
  if (tab === 'books') loadBooks();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

$('logout').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login.html';
});

// ---------- Session ----------
async function loadSession() {
  session = await api('/admin/api/session');
  $('currentUser').textContent = `Connecté en tant que « ${session.login} »`;
  $('appVersion').textContent = `v${session.version}`;
  if (session.role !== 'user') {
    location.href = '/';
    return;
  }
}

// ---------- Composer ----------
let selectedContacts = new Set();
let loadedBookId = null;
let composerBookId = null;
let composerMode = 'single';

function scheduledIso() {
  const v = $('scheduleAt').value;
  if (!v) return undefined;
  return new Date(v).toISOString();
}

function updateComposerMode() {
  const book = composerMode === 'book';
  $('singleRecipient').classList.toggle('hidden', book);
  $('bookRecipient').classList.toggle('hidden', !book);
  $('btnSendSingle').classList.toggle('hidden', book);
  $('btnSendToSelected').classList.toggle('hidden', !book);
  updateComposerCount();
}

document.querySelectorAll('input[name=mode]').forEach((r) => {
  r.addEventListener('change', () => {
    composerMode = r.value;
    updateComposerMode();
  });
});

async function loadComposer() {
  const bookSelect = $('bookSelect');
  const prev = bookSelect.value;
  books = await api('/admin/api/address-books');
  bookSelect.innerHTML = ['<option value="">—</option>']
    .concat(books.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`))
    .join('');
  if (books.some((b) => String(b.id) === prev)) {
    bookSelect.value = prev;
  } else {
    bookSelect.value = books.length ? String(books[0].id) : '';
  }
  await loadRecipients();
}

async function loadRecipients() {
  const id = Number($('bookSelect').value || 0);
  composerBookId = id;
  const list = $('recipientList');
  contacts = id ? await api(`/admin/api/address-books/${id}/contacts`) : [];
  if (id !== loadedBookId) {
    loadedBookId = id;
    selectedContacts = new Set(contacts.map((c) => c.id));
  }
  if (!contacts.length) {
    list.innerHTML = '<div class="contact-list-empty muted">' + (id ? 'Ce carnet ne contient aucun contact.' : 'Choisissez un carnet pour afficher les contacts.') + '</div>';
    updateComposerCount();
    return;
  }
  list.innerHTML = contacts.map((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    const label = name || c.entity || c.phone;
    return `<label class="contact-row">
      <input type="checkbox" data-id="${c.id}" ${selectedContacts.has(c.id) ? 'checked' : ''}>
      <span class="who">
        <b>${esc(label)}</b><br>
        ${c.entity && name ? `<span class="muted">${esc(c.entity)}</span> · ` : ''}<span class="phone">${esc(c.phone)}</span>
      </span>
    </label>`;
  }).join('');
  updateComposerCount();
}

$('bookSelect').addEventListener('change', loadRecipients);

$('recipientList').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  const id = Number(cb.dataset.id);
  if (cb.checked) selectedContacts.add(id);
  else selectedContacts.delete(id);
  updateComposerCount();
});

$('btnToggleAll').addEventListener('click', () => {
  if (!contacts.length) return;
  const allChecked = contacts.every((c) => selectedContacts.has(c.id));
  if (allChecked) selectedContacts.clear();
  else selectedContacts = new Set(contacts.map((c) => c.id));
  document.querySelectorAll('#recipientList input[type=checkbox]').forEach((cb) => {
    cb.checked = selectedContacts.has(Number(cb.dataset.id));
  });
  updateComposerCount();
});

function updateComposerCount() {
  const s = $('smsBody').value;
  const segs = smsSegments(s.length, s);
  if (composerMode === 'single') {
    $('composerCount').textContent = `${s.length}/1000 caractères · ${segs > 1 ? segs + ' segments' : '1 segment'}`;
  } else {
    const checked = document.querySelectorAll('#recipientList input:checked').length;
    $('composerCount').textContent = `${checked} destinataire(s) · ${s.length}/1000 caractères · ${segs > 1 ? segs + ' segments' : '1 segment'}`;
  }
  $('btnToggleAll').textContent = contacts.length > 0 && contacts.every((c) => selectedContacts.has(c.id))
    ? 'Tout décocher' : 'Tout cocher';
  $('composerSummary').classList.add('hidden');
  $('composerError').textContent = '';
}

$('smsBody').addEventListener('input', () => {
  updateComposerCount();
  const s = $('smsBody').value;
  $('smsCounter').textContent = s.length;
  $('smsSegments').textContent = smsSegments(s.length, s) > 1 ? `${smsSegments(s.length, s)} segments` : '1 segment';
});

function smsSegments(len, s) {
  const GSM7 = /^[\x00-\x7F]*$/.test(s) ? 153 : 67;
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

// ---------- Confirmation avant envoi ----------
let pendingSend = null;

function scheduleLabel() {
  const v = $('scheduleAt').value;
  return v ? `le ${fmtDate(new Date(v).toISOString())}` : 'immédiatement';
}

function askConfirm(title, bodyHtml, onConfirm) {
  $('confirmTitle').textContent = title;
  $('confirmBody').innerHTML = bodyHtml;
  $('confirmError').textContent = '';
  pendingSend = onConfirm;
  $('confirmModal').classList.remove('hidden');
}

$('btnCancelConfirm').addEventListener('click', () => {
  pendingSend = null;
  $('confirmModal').classList.add('hidden');
});

$('btnConfirmSend').addEventListener('click', async () => {
  const fn = pendingSend;
  if (!fn) return;
  $('confirmError').textContent = '';
  try {
    await fn();
    pendingSend = null;
    $('confirmModal').classList.add('hidden');
  } catch (e) {
    $('confirmError').textContent = e.message;
  }
});

$('btnSendSingle').addEventListener('click', () => {
  $('composerError').textContent = '';
  const recipient = $('smsRecipient').value.trim().replace(/[\s.\-()]/g, '');
  const body = $('smsBody').value.trim();
  if (!/^\+?[0-9]{4,15}$/.test(recipient)) {
    $('composerError').textContent = 'Numéro de téléphone invalide.';
    return;
  }
  if (!body) {
    $('composerError').textContent = 'Le message est vide.';
    return;
  }
  askConfirm('Confirmer l\'envoi du SMS', `
    <p><b>Destinataire :</b> <span class="code">${esc(recipient)}</span></p>
    <p><b>Message :</b><br>${esc(body)}</p>
    <p class="muted">Envoi ${scheduleLabel()}.</p>
  `, async () => {
    const res = await api('/admin/api/messages', {
      method: 'POST',
      body: JSON.stringify({ recipient, message: body, scheduledAt: scheduledIso() })
    });
    $('composerSummary').classList.remove('hidden');
    $('composerSummary').textContent = res.status === 'scheduled'
      ? `Message programmé : pris en compte, envoi prévu ${scheduleLabel()}.`
      : 'Message pris en compte, envoi immédiat.';
    $('smsRecipient').value = '';
    $('smsBody').value = '';
    updateComposerCount();
  });
});

$('btnSendToSelected').addEventListener('click', () => {
  $('composerError').textContent = '';
  const checks = Array.from(document.querySelectorAll('#recipientList input:checked'));
  const body = $('smsBody').value.trim();
  if (!checks.length) {
    $('composerError').textContent = 'Cochez au moins un destinataire.';
    return;
  }
  if (!body) {
    $('composerError').textContent = 'Le message est vide.';
    return;
  }
  if (!composerBookId) {
    $('composerError').textContent = 'Choisissez un carnet d\'adresses.';
    return;
  }
  const contactIds = checks.map((c) => Number(c.dataset.id));
  const book = books.find((b) => b.id === composerBookId);
  askConfirm(`Confirmer l'envoi au carnet (${checks.length} destinataire${checks.length > 1 ? 's' : ''})`, `
    <p><b>Carnet :</b> ${esc(book ? book.name : '')}</p>
    <p><b>Destinataires :</b> ${checks.length}</p>
    <p><b>Message :</b><br>${esc(body)}</p>
    <p class="muted">Envoi ${scheduleLabel()}.</p>
  `, async () => {
    const res = await api('/admin/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ bookId: composerBookId, contactIds, message: body, scheduledAt: scheduledIso() })
    });
    $('composerSummary').classList.remove('hidden');
    $('composerSummary').textContent = res.status === 'scheduled'
      ? `${res.count} SMS programmés pour le carnet « ${res.bookName} » : pris en compte, envoi prévu ${scheduleLabel()}.`
      : `${res.count} SMS pris en compte pour le carnet « ${res.bookName} », envoi immédiat.`;
    checks.forEach((c) => { c.checked = false; });
    selectedContacts = new Set();
    updateComposerCount();
  });
});

// ---------- Messages ----------
const CANCELABLE = ['scheduled', 'pending', 'sending', 'sent'];
const MESSAGE_HEADERS = '<tr><th>Date</th><th>Destinataire</th><th>Statut</th><th>Passerelle</th><th>Erreur</th></tr>';

function stateOf(s) {
  return badge({
    scheduled: 'Programmé', pending: 'En attente', sending: 'En cours', sent: 'Envoyé', delivered: 'Remis', failed: 'Échec', cancelled: 'Annulé'
  }[s] || s, s);
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

function messageRow(m) {
  return `<tr>
    <td>${m.id}</td>
    <td>${fmtDate(m.created_at)}</td>
    <td class="code">${esc(m.recipient)} ${recipientPastille(m.recipient)}</td>
    <td>${esc(m.body)}</td>
    <td>${stateOf(m.status)}</td>
    <td>${esc(m.gateway_label || m.device_id || '—')}</td>
    <td class="muted">${esc(m.error || '')}</td>
    <td>${cancelButton(m)}</td>
  </tr>`;
}

function campaignDetailRow(m) {
  return `<tr>
    <td>${fmtDate(m.created_at)}</td>
    <td class="code">${esc(m.recipient)} ${recipientPastille(m.recipient)}</td>
    <td>${stateOf(m.status)}</td>
    <td>${esc(m.gateway_label || m.device_id || '—')}</td>
    <td class="muted">${esc(m.error || '')}</td>
  </tr>`;
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
    const summary = `<span class="badge ok">Carnet</span> <strong>${esc(c.book)}</strong> · ${c.rows.length} destinataire(s) · <b class="summary">${delivered} délivré(s)</b>${failed ? ` · ${failed} échec(s)` : ''}${inFlight ? ` · ${inFlight} en cours` : ''}`;
    html.push({ time: Date.parse(first.created_at), html: `<tr class="campaign-row" data-campaign="${c.id}">
      <td colspan="7">${summary}<br><span class="muted">${fmtDate(first.created_at)}${schedNote} · ${esc(first.body)} · cliquer pour le détail</span></td>
      <td>${cancelable ? `<button data-cancelcamp="${c.id}" class="ghost">Annuler</button>` : ''}</td>
    </tr>
    <tr class="campaign-detail hidden" data-campaign="${c.id}">
      <td colspan="8">
        <table>
          <thead>${MESSAGE_HEADERS}</thead>
          <tbody>${c.rows.map((m) => campaignDetailRow(m)).join('')}</tbody>
        </table>
      </td>
    </tr>` });
  }
  for (const m of singles) html.push({ time: Date.parse(m.created_at), html: messageRow(m) });
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
}

async function loadMessages() {
  const status = $('statusFilter').value;
  const messages = await api(`/admin/api/messages?limit=100&status=${encodeURIComponent(status)}`);
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
    : '<tr><td colspan="8" class="muted">Aucun message dans votre groupe.</td></tr>';
  bindCampaignToggles();
  bindMessageActions();
}

$('statusFilter').addEventListener('change', loadMessages);

// ---------- Carnets ----------
let viewBookId = null;

async function loadBooks() {
  books = await api('/admin/api/address-books');
  $('booksList').innerHTML = books.length
    ? books.map((b) => `<div class="book-card">
        <div>
          <strong>${esc(b.name)}</strong>
          <span class="muted"> · ${b.contact_count} contact(s)${b.group_name ? ` · ${esc(b.group_name)}` : ''}</span>
          <span data-bookhistory="${b.id}" class="sms-pastille${b.message_count ? '' : ' empty'}" title="Voir les SMS envoyés">${b.message_count || 0}</span>
        </div>
        <div>
          <button data-renamebook="${b.id}" data-name="${esc(b.name)}" class="ghost">Renommer</button>
          <button data-delbook="${b.id}" class="ghost">Supprimer</button>
          <button data-openbook="${b.id}" class="ghost">Ouvrir</button>
        </div>
      </div>`).join('')
    : '<p class="muted">Aucun carnet d\'adresses. Créez-en un pour commencer.</p>';
  document.querySelectorAll('[data-openbook]').forEach((b) => {
    b.addEventListener('click', () => openBook(Number(b.dataset.openbook)));
  });
  document.querySelectorAll('[data-renamebook]').forEach((b) => {
    b.addEventListener('click', () => openBookModal(Number(b.dataset.renamebook), b.dataset.name));
  });
  document.querySelectorAll('[data-delbook]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce carnet et tous ses contacts ?')) return;
      await api(`/admin/api/address-books/${b.dataset.delbook}`, { method: 'DELETE' });
      loadBooks();
      loadComposer();
    });
  });
  document.querySelectorAll('[data-bookhistory]').forEach((b) => {
    b.addEventListener('click', () => {
      const book = books.find((x) => x.id === Number(b.dataset.bookhistory));
      openSmsHistory(`SMS envoyés — ${book ? book.name : ''}`, `/admin/api/messages?bookId=${b.dataset.bookhistory}&limit=200`);
    });
  });
}

async function openBook(bookId) {
  viewBookId = bookId;
  const book = books.find((b) => b.id === bookId);
  $('bookContactsTitle').textContent = `Contacts — ${book ? book.name : ''}`;
  await loadContacts();
  $('booksList').classList.add('hidden');
  $('bookContacts').classList.remove('hidden');
}

async function loadContacts() {
  const rows = await api(`/admin/api/address-books/${viewBookId}/contacts`);
  const phones = rows.map((c) => c.phone);
  let counts = {};
  try {
    const r = await api(`/admin/api/messages/counts?recipients=${encodeURIComponent(phones.join(','))}`);
    counts = r.counts || {};
  } catch { /* pastilles vides si le comptage échoue */ }
  $('contactsBody').innerHTML = rows.length
    ? rows.map((c) => `<tr>
        <td>${esc(c.first_name || '')}</td>
        <td>${esc(c.last_name || '')}</td>
        <td>${esc(c.entity || '')}</td>
        <td class="code">${esc(c.phone)} <span data-recipient="${esc(c.phone)}" class="sms-pastille${counts[c.phone] ? '' : ' empty'}">${counts[c.phone] || 0}</span></td>
        <td>
          <button data-editcontact="${c.id}" data-cname="${esc(c.first_name || '')}" data-clast="${esc(c.last_name || '')}" data-centity="${esc(c.entity || '')}" data-cphone="${esc(c.phone)}" class="ghost">Éditer</button>
          <button data-delcontact="${c.id}" class="ghost">Supprimer</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">Aucun contact.</td></tr>';
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
  document.querySelectorAll('[data-recipient]').forEach((b) => {
    b.addEventListener('click', () => {
      openSmsHistory(`SMS envoyés vers ${b.dataset.recipient}`, `/admin/api/messages?recipient=${encodeURIComponent(b.dataset.recipient)}&limit=200`);
    });
  });
}

$('btnBackBooks').addEventListener('click', () => {
  $('bookContacts').classList.add('hidden');
  $('booksList').classList.remove('hidden');
  loadBooks();
});

let pendingBookId = null;
let pendingContactId = null;

function openBookModal(id = null, name = '') {
  pendingBookId = id;
  $('bookName').value = name;
  $('bookModalError').textContent = '';
  $('bookModalTitle').textContent = id === null ? 'Nouveau carnet d\'adresses' : 'Renommer le carnet';
  $('btnSaveBook').textContent = id === null ? 'Créer' : 'Enregistrer';
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
        body: JSON.stringify({ name: $('bookName').value })
      });
    } else {
      await api(`/admin/api/address-books/${pendingBookId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: $('bookName').value })
      });
    }
    $('bookModal').classList.add('hidden');
    loadBooks();
    loadComposer();
  } catch (e) {
    $('bookModalError').textContent = e.message;
  }
});

// ---------- Ajout / édition de contact ----------
function openContactModal(id = null, data = null) {
  pendingContactId = id;
  $('contactFirstName').value = data ? data.cname : '';
  $('contactLastName').value = data ? data.clast : '';
  $('contactEntity').value = data ? data.centity : '';
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
    loadBooks();
    loadComposer();
  } catch (e) {
    $('contactModalError').textContent = e.message;
  }
});

// ---------- Import CSV contacts ----------
let csvRows = [];
let csvHeaderCells = [];

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
  return rows;
}

function handleCsvFile(file) {
  $('importError').textContent = '';
  $('importResult').textContent = '';
  $('dropZone').querySelector('p').textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCsv(String(reader.result || ''));
      if (rows.length === 0) {
        $('importError').textContent = 'Fichier vide.';
        return;
      }
      csvHeaderCells = rows[0].map((c) => String(c ?? '').trim());
      csvRows = rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
      const fields = [
        { v: '', l: '— Ignorer —' },
        { v: 'phone', l: 'Téléphone (obligatoire)' },
        { v: 'firstName', l: 'Prénom' },
        { v: 'lastName', l: 'Nom' },
        { v: 'entity', l: 'Entité' }
      ];
      $('mappingBody').innerHTML = csvHeaderCells.map((h, i) => `<tr>
        <td>${esc(h || `Colonne ${i + 1}`)}</td>
        <td><select data-col="${i}">${fields.map((f) => `<option value="${f.v}" ${f.v === 'phone' && i === 0 ? 'selected' : ''}>${f.l}</option>`).join('')}</select></td>
      </tr>`).join('');
      $('csvHeader').classList.remove('hidden');
    } catch (e) {
      $('importError').textContent = 'Impossible de lire le fichier : ' + e.message;
    }
  };
  reader.onerror = () => { $('importError').textContent = 'Erreur de lecture du fichier.'; };
  reader.readAsText(file, 'utf-8');
}

$('btnImportBook').addEventListener('click', () => {
  $('csvFile').value = '';
  $('importError').textContent = '';
  $('importResult').textContent = '';
  $('csvHeader').classList.add('hidden');
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
  $('importError').textContent = '';
  const map = { firstName: '', lastName: '', entity: '', phone: '' };
  document.querySelectorAll('#mappingBody select').forEach((s) => {
    const val = s.value;
    if (val) map[val] = s.dataset.col;
  });
  if (map.phone === '') {
    $('importError').textContent = 'Mappez une colonne sur « Téléphone » avant d\'importer.';
    return;
  }
  try {
    const res = await api(`/admin/api/address-books/${viewBookId}/import`, {
      method: 'POST',
      body: JSON.stringify({
        map,
        rows: csvRows,
        overwrite: $('overwriteBook').checked
      })
    });
    $('csvHeader').classList.add('hidden');
    loadContacts();
    loadBooks();
    loadComposer();
    showImportResult(res);
  } catch (e) {
    $('importError').textContent = e.message;
  }
});

function showImportResult(res) {
  const created = Number(res.created || 0);
  const replaced = Number(res.replaced || 0);
  const duplicates = Number(res.duplicates || 0);
  const invalid = Array.isArray(res.invalid) ? res.invalid : [];
  const lines = [];
  if (created === 0 && replaced === 0 && invalid.length === 0) {
    lines.push('<p class="muted">Aucun changement : tous les numéros étaient déjà présents ou le fichier était vide.</p>');
  } else {
    lines.push('<p style="margin-top:12px">');
    if (created > 0) lines.push(`<span class="badge ok">${created} numéro(s) importé(s)</span> `);
    if (replaced > 0) lines.push(`<span class="badge pending">${replaced} contact(s) mis à jour</span> `);
    if (duplicates > 0) lines.push(`<span class="badge off">${duplicates} doublon(s) ignoré(s)</span> `);
    if (invalid.length > 0) lines.push(`<span class="badge failed">${invalid.length} ligne(s) invalide(s)</span> `);
    lines.push('</p>');
  }
  if (invalid.length > 0) {
    lines.push('<p class="error" style="margin:12px 0 4px">Lignes invalides (non importées) :</p><ul class="import-invalid-list">');
    invalid.slice(0, 20).forEach((i) => {
      lines.push(`<li>Ligne ${i.row ?? '—'} : ${esc(i.phone || '(vide)')} — ${esc(i.error || 'invalide')}</li>`);
    });
    if (invalid.length > 20) lines.push(`<li>… et ${invalid.length - 20} autre(s)</li>`);
    lines.push('</ul>');
  }
  $('importResultTitle').textContent = (created + replaced) > 0 ? 'Import réussi' : 'Import terminé';
  $('importResultBody').innerHTML = lines.join('');
  $('importResultModal').classList.remove('hidden');
}

$('btnCloseImportResult').addEventListener('click', () => $('importResultModal').classList.add('hidden'));

// ---------- Rafraîchissement automatique ----------
loadSession().then(() => showTab('composer'));
refreshOnlineBadge();
setInterval(() => {
  refreshOnlineBadge();
  if (currentTab === 'messages') loadMessages();
  if (currentTab === 'composer') loadComposer();
}, 10000);
