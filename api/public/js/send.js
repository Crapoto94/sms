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
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  $('composer').classList.toggle('hidden', tab !== 'composer');
  $('fleet').classList.toggle('hidden', tab !== 'fleet');
  $('messages').classList.toggle('hidden', tab !== 'messages');
  $('books').classList.toggle('hidden', tab !== 'books');
  if (tab === 'composer') loadComposer();
  if (tab === 'fleet') loadFleet();
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
}

function homeUrl() {
  return session && session.role === 'admin' ? '/' : '/send.html';
}

$('btnBackHome').addEventListener('click', () => { location.href = homeUrl(); });

// ---------- Composer ----------
let selectedContacts = new Set();
let loadedBookId = null;
let composerBookId = null;
let composerMode = 'single';
let singleRecipients = [];

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
  $('contactVariables').classList.toggle('hidden', !book);
  $('messagePreview').classList.toggle('hidden', !book || !contacts.length);
  updateComposerCount();
}

function insertVariable(target, variable) {
  const start = target.selectionStart;
  const end = target.selectionEnd;
  target.value = target.value.slice(0, start) + variable + target.value.slice(end);
  target.selectionStart = target.selectionEnd = start + variable.length;
  target.focus();
  target.dispatchEvent(new Event('input'));
}

document.querySelectorAll('[data-variable]').forEach((button) => {
  button.addEventListener('click', () => {
    const target = $(button.dataset.variableTarget || 'smsBody');
    insertVariable(target, button.dataset.variable);
  });
});

function normalizeRecipient(value) {
  return String(value || '').trim().replace(/[\s.\-()]/g, '');
}

function renderSingleRecipients() {
  $('singleRecipients').innerHTML = singleRecipients.map((phone) => `
    <span class="badge pending" style="display:inline-flex;align-items:center;gap:6px;margin:2px 4px 2px 0">
      ${esc(phone)} <button type="button" data-remove-recipient="${esc(phone)}" class="ghost" style="padding:0 4px">×</button>
    </span>`).join('');
  document.querySelectorAll('[data-remove-recipient]').forEach((button) => {
    button.addEventListener('click', () => {
      singleRecipients = singleRecipients.filter((phone) => phone !== button.dataset.removeRecipient);
      renderSingleRecipients();
      renderSingleBookContacts();
      updateComposerCount();
    });
  });
}

function addSingleRecipient() {
  const phone = normalizeRecipient($('smsRecipient').value);
  if (!/^\+?[0-9]{4,15}$/.test(phone)) {
    $('composerError').textContent = 'Numéro de téléphone invalide.';
    return false;
  }
  if (!singleRecipients.includes(phone)) singleRecipients.push(phone);
  $('smsRecipient').value = '';
  $('composerError').textContent = '';
  renderSingleRecipients();
  renderSingleBookContacts();
  updateComposerCount();
  return true;
}

$('btnAddRecipient').addEventListener('click', addSingleRecipient);
$('smsRecipient').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addSingleRecipient();
  }
});

// ---------- Choix des numéros depuis un carnet (mode unitaire) ----------
let singleBookContacts = [];

async function loadSingleBookContacts() {
  const bookId = Number($('singleBookSelect').value || 0);
  singleBookContacts = bookId ? await fetchAllBookContacts(bookId) : [];
  renderSingleBookContacts();
}

function singleContactText(c) {
  return [c.first_name, c.last_name, c.entity, c.phone].filter(Boolean).join(' ').toLowerCase();
}

function renderSingleBookContacts() {
  const q = $('singleBookSearch').value.trim().toLowerCase();
  const filtered = q
    ? singleBookContacts.filter((c) => singleContactText(c).includes(q))
    : singleBookContacts;
  $('singleBookContacts').innerHTML = filtered.length
    ? filtered.map((c) => {
        const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.entity || c.phone;
        const phone = normalizeRecipient(c.phone);
        const checked = singleRecipients.includes(phone) ? 'checked' : '';
        const disabled = c.blacklisted ? 'disabled' : '';
        return `<label class="contact-row"><input type="checkbox" data-book-phone="${esc(c.phone)}" ${checked} ${disabled}><span class="who"><b>${esc(name)}</b><br><span class="phone">${esc(c.phone)}</span>${c.blacklisted ? ' · <span class="badge failed">Blacklisté</span>' : ''}</span></label>`;
      }).join('')
    : `<div class="contact-list-empty muted">${singleBookContacts.length ? 'Aucun contact ne correspond à la recherche.' : 'Choisissez un carnet pour afficher les contacts.'}</div>`;
}

$('singleBookSelect').addEventListener('change', () => {
  $('singleBookSearch').value = '';
  loadSingleBookContacts();
});
$('singleBookSearch').addEventListener('input', renderSingleBookContacts);
$('singleBookContacts').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-book-phone]');
  if (!checkbox) return;
  const phone = normalizeRecipient(checkbox.dataset.bookPhone);
  if (checkbox.checked) {
    if (!singleRecipients.includes(phone)) singleRecipients.push(phone);
  } else {
    singleRecipients = singleRecipients.filter((p) => p !== phone);
  }
  renderSingleRecipients();
  updateComposerCount();
});

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
    .concat(books.map((b) => `<option value="${b.id}">${esc(b.name)}${b.group_id === null ? ' (Distant)' : ''}</option>`))
    .join('');
  if (books.some((b) => String(b.id) === prev)) {
    bookSelect.value = prev;
  } else {
    bookSelect.value = books.length ? String(books[0].id) : '';
  }
  fillExcludeBookSelect('excludeBookSelect', bookSelect.value);
  fillSingleBookSelect();
  await loadRecipients();
}

function fillSingleBookSelect() {
  const select = $('singleBookSelect');
  const prev = select.value;
  select.innerHTML = ['<option value="">—</option>']
    .concat(books.map((b) => `<option value="${b.id}">${esc(b.name)}${b.group_id === null ? ' (Distant)' : ''}</option>`))
    .join('');
  select.value = books.some((b) => String(b.id) === prev) ? prev : '';
  if (select.value) loadSingleBookContacts();
}

function fillExcludeBookSelect(selectId, primaryId) {
  const select = $(selectId);
  const previous = select.value;
  select.innerHTML = '<option value="">— Aucun numéro exclu —</option>' + books
    .filter((book) => String(book.id) !== String(primaryId))
    .map((book) => `<option value="${book.id}">${esc(book.name)}</option>`).join('');
  if (books.some((book) => String(book.id) === previous && String(book.id) !== String(primaryId))) select.value = previous;
}

async function excludedPhonesFor(selectId) {
  const bookId = Number($(selectId).value || 0);
  if (!bookId) return new Set();
  const rows = await fetchAllBookContacts(bookId);
  return new Set(rows.map((contact) => contact.phone));
}

async function loadRecipients() {
  const id = Number($('bookSelect').value || 0);
  composerBookId = id;
  const list = $('recipientList');
  const [bookContacts, excludedPhones] = id
    ? await Promise.all([fetchAllBookContacts(id), excludedPhonesFor('excludeBookSelect')])
    : [[], new Set()];
  contacts = bookContacts;
  const isExcluded = (contact) => excludedPhones.has(contact.phone);
  if (id !== loadedBookId) {
    loadedBookId = id;
    selectedContacts = new Set(contacts.filter((c) => !c.blacklisted && !isExcluded(c)).map((c) => c.id));
  } else {
    selectedContacts = new Set([...selectedContacts].filter((contactId) => {
      const contact = contacts.find((c) => c.id === contactId);
      return contact && !contact.blacklisted && !isExcluded(contact);
    }));
  }
  if (!contacts.length) {
    list.innerHTML = '<div class="contact-list-empty muted">' + (id ? 'Ce carnet ne contient aucun contact.' : 'Choisissez un carnet pour afficher les contacts.') + '</div>';
    $('messagePreview').classList.add('hidden');
    updateComposerCount();
    return;
  }
  list.innerHTML = contacts.map((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    const label = name || c.entity || c.phone;
    return `<label class="contact-row">
       <input type="checkbox" data-id="${c.id}" ${c.blacklisted || isExcluded(c) ? 'disabled' : ''} ${selectedContacts.has(c.id) ? 'checked' : ''}>
      <span class="who">
        <b>${esc(label)}</b><br>
         ${c.entity && name ? `<span class="muted">${esc(c.entity)}</span> · ` : ''}<span class="phone">${esc(c.phone)}</span>${c.blacklisted ? ' · <span class="badge failed">Blacklisté</span>' : isExcluded(c) ? ' · <span class="badge off">Exclu</span>' : ''}
      </span>
    </label>`;
  }).join('');
  const preview = $('previewContact');
  const previousPreview = preview.value;
  preview.innerHTML = contacts.map((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.entity || c.phone;
    return `<option value="${c.id}">${esc(name)} — ${esc(c.phone)}${c.blacklisted ? ' — blacklisté' : ''}</option>`;
  }).join('');
  preview.value = contacts.some((c) => String(c.id) === previousPreview) ? previousPreview : String(contacts[0].id);
  $('messagePreview').classList.remove('hidden');
  updateMessagePreview();
  updateComposerCount();
}

function renderPreviewMessage(template, contact) {
  const values = {
    '{prénom}': contact.first_name,
    '{nom}': contact.last_name,
    '{entité}': contact.entity,
    '{téléphone}': contact.phone,
    '{service}': contact.service,
    '{direction}': contact.direction,
    '{imei}': contact.imei,
    '{puk}': contact.puk
  };
  return Object.entries(values).reduce((message, [variable, value]) => message.replaceAll(variable, value || ''), template);
}

function updateMessagePreview() {
  const contact = contacts.find((c) => String(c.id) === $('previewContact').value);
  $('previewBody').textContent = contact ? renderPreviewMessage($('smsBody').value, contact) : '';
}

$('previewContact').addEventListener('change', updateMessagePreview);

$('bookSelect').addEventListener('change', async () => {
  fillExcludeBookSelect('excludeBookSelect', $('bookSelect').value);
  await loadRecipients();
});
$('excludeBookSelect').addEventListener('change', async () => {
  loadedBookId = null;
  await loadRecipients();
});

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
  const eligible = [...document.querySelectorAll('#recipientList input:not(:disabled)')].map((input) => Number(input.dataset.id));
  const allChecked = eligible.length > 0 && eligible.every((id) => selectedContacts.has(id));
  if (allChecked) selectedContacts.clear();
  else selectedContacts = new Set(contacts.filter((c) => !c.blacklisted).map((c) => c.id));
  document.querySelectorAll('#recipientList input[type=checkbox]').forEach((cb) => {
    cb.checked = selectedContacts.has(Number(cb.dataset.id));
  });
  updateComposerCount();
});

function updateComposerCount() {
  const s = $('smsBody').value;
  const segs = smsSegments(s.length, s);
  if (composerMode === 'single') {
    $('composerCount').textContent = `${singleRecipients.length} destinataire(s) · ${s.length}/1000 caractères · ${segs > 1 ? segs + ' segments' : '1 segment'}`;
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
  updateMessagePreview();
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
  const currentRecipient = normalizeRecipient($('smsRecipient').value);
  if (currentRecipient && !addSingleRecipient()) return;
  const recipients = [...singleRecipients];
  const body = $('smsBody').value.trim();
  const attachmentFile = $('smsAttachment').files[0] || null;
  const attachmentExpiry = $('smsAttachmentExpiry').value;
  if (!recipients.length) {
    $('composerError').textContent = 'Ajoutez au moins un numéro de téléphone.';
    return;
  }
  if (!body) {
    $('composerError').textContent = 'Le message est vide.';
    return;
  }
  askConfirm(`Confirmer l'envoi (${recipients.length} SMS)`, `
    <p><b>Destinataires :</b> <span class="code">${recipients.map(esc).join(', ')}</span></p>
    <p><b>Message :</b><br>${esc(body)}</p>
    ${attachmentFile ? `<p><b>Pièce jointe :</b> ${esc(attachmentFile.name)}</p>` : ''}
    <p class="muted">Envoi ${scheduleLabel()}.</p>
  `, async () => {
    for (const recipient of recipients) {
      const attachment = attachmentFile ? await uploadAttachment(attachmentFile, attachmentExpiry) : null;
      await api('/admin/api/messages', {
        method: 'POST',
        body: JSON.stringify({ recipient, message: body, scheduledAt: scheduledIso(), attachmentId: attachment ? attachment.id : null })
      });
    }
    $('composerSummary').classList.remove('hidden');
    $('composerSummary').textContent = `${recipients.length} message(s) pris en compte, envoi ${scheduleLabel()}.`;
    singleRecipients = [];
    renderSingleRecipients();
    renderSingleBookContacts();
    $('smsRecipient').value = '';
    $('smsBody').value = '';
    $('smsAttachment').value = '';
    updateComposerCount();
    location.href = homeUrl();
  });
});

$('btnSendToSelected').addEventListener('click', () => {
  $('composerError').textContent = '';
  const checks = Array.from(document.querySelectorAll('#recipientList input:checked'));
  const body = $('smsBody').value.trim();
  const attachmentFile = $('smsAttachment').files[0] || null;
  const attachmentExpiry = $('smsAttachmentExpiry').value;
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
    ${attachmentFile ? `<p><b>Pièce jointe :</b> ${esc(attachmentFile.name)}</p>` : ''}
    <p class="muted">Envoi ${scheduleLabel()}.</p>
  `, async () => {
    const attachment = attachmentFile ? await uploadAttachment(attachmentFile, attachmentExpiry) : null;
    const res = await api('/admin/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ bookId: composerBookId, excludeBookId: Number($('excludeBookSelect').value || 0) || null, contactIds, message: body, scheduledAt: scheduledIso(), attachmentId: attachment ? attachment.id : null })
    });
    $('composerSummary').classList.remove('hidden');
    $('composerSummary').textContent = res.status === 'scheduled'
      ? `${res.count} SMS programmés pour le carnet « ${res.bookName} » : pris en compte, envoi prévu ${scheduleLabel()}.`
      : `${res.count} SMS pris en compte pour le carnet « ${res.bookName} », envoi immédiat.`;
    checks.forEach((c) => { c.checked = false; });
    selectedContacts = new Set();
    updateComposerCount();
    $('smsAttachment').value = '';
    location.href = homeUrl();
  });
});

// ---------- Vérification de flotte ----------
let fleetContacts = [];
let fleetSelected = new Set();
let fleetCheckId = null;
let fleetBooks = [];

async function loadFleet() {
  const booksList = await api('/admin/api/address-books');
  fleetBooks = booksList;
  const select = $('fleetBookSelect');
  const previous = select.value;
  select.innerHTML = ['<option value="">—</option>']
    .concat(booksList.map((book) => `<option value="${book.id}">${esc(book.name)}</option>`)).join('');
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
// toujours affichée (always). Chaque colonne visible a un filtre dédié.
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

// ---------- Messages ----------
const CANCELABLE = ['scheduled', 'pending', 'sending', 'sent'];
const MESSAGE_HEADERS = '<tr><th>Date</th><th>Créateur</th><th>Destinataire</th><th>Statut</th><th>Pièce jointe</th><th>Passerelle</th><th>Erreur</th></tr>';

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

function repairFilename(name) {
  const value = String(name || '');
  if (!/[ÃÂâ]/.test(value)) return value;
  try {
    return decodeURIComponent(Array.from(value).map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  } catch (_) { return value; }
}

function attachmentDisplay(m) {
  if (!m.attachment_name) return '—';
  const count = Number(m.attachment_open_count || 0);
  const state = count
    ? `<button type="button" class="badge ok attachment-open-info" data-attachment-info="${m.attachment_id}">Ouverte (${count})</button>`
    : badge('Non ouverte', 'off');
  return `${state} <a href="/admin/api/attachments/${m.attachment_id}/preview" target="_blank" rel="noopener">${esc(repairFilename(m.attachment_name))}</a>`;
}

function messageRow(m) {
  return `<tr>
    <td>${m.id}</td>
    <td>${fmtDate(m.created_at)}</td>
    <td>${esc(m.creator_login || m.created_by_label || m.origin_label || '—')}</td>
    <td class="code">${esc(m.recipient)} ${recipientPastille(m.recipient)}</td>
    <td>${esc(m.body)}</td>
    <td>${stateOf(m.status)}</td>
    <td>${attachmentDisplay(m)}</td>
    <td>${esc(m.gateway_label || m.device_id || '—')}</td>
    <td class="muted">${esc(m.error || '')}</td>
    <td>${cancelButton(m)}</td>
  </tr>`;
}

function campaignDetailRow(m) {
  return `<tr>
    <td>${fmtDate(m.created_at)}</td>
    <td>${esc(m.creator_login || m.created_by_label || m.origin_label || '—')}</td>
    <td class="code">${esc(m.recipient)} ${recipientPastille(m.recipient)}</td>
    <td>${stateOf(m.status)}</td>
    <td>${attachmentDisplay(m)}</td>
    <td>${esc(m.gateway_label || m.device_id || '—')}</td>
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
       <td colspan="9">${summary}${campaignKpi(c, byStatus)}<span class="muted">${fmtDate(first.created_at)}${schedNote} · Envoyé par <b>${esc(sender)}</b> · ${esc(first.body)} · cliquer pour le détail</span></td>
      <td>${cancelable ? `<button data-cancelcamp="${c.id}" class="ghost">Annuler</button>` : ''}</td>
    </tr>
    <tr class="campaign-detail hidden" data-campaign="${c.id}">
       <td colspan="10">
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
    : '<tr><td colspan="10" class="muted">Aucun message dans votre groupe.</td></tr>';
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

// ---------- Carnets ----------
let viewBookId = null;

async function loadBooks() {
  books = await api('/admin/api/address-books');
  $('booksList').innerHTML = books.length
    ? books.map((b) => `<div class="book-card">
        <div>
          <strong>${esc(b.name)}${b.group_id === null ? ' <span class="sync-pastille">Distant</span>' : ''}</strong>
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

$('btnBackBooks').addEventListener('click', () => {
  $('bookContacts').classList.add('hidden');
  $('booksList').classList.remove('hidden');
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
        { v: 'entity', l: 'Entité' },
        { v: 'service', l: 'Service' },
        { v: 'direction', l: 'Direction' },
        { v: 'imei', l: 'IMEI' },
        { v: 'puk', l: 'PUK' }
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
  const map = { firstName: '', lastName: '', entity: '', service: '', direction: '', imei: '', puk: '', phone: '' };
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
  const blacklisted = Number(res.blacklisted || 0);
  const invalid = Array.isArray(res.invalid) ? res.invalid : [];
  const lines = [];
  if (created === 0 && replaced === 0 && invalid.length === 0 && blacklisted === 0) {
    lines.push('<p class="muted">Aucun changement : tous les numéros étaient déjà présents ou le fichier était vide.</p>');
  } else {
    lines.push('<p style="margin-top:12px">');
    if (created > 0) lines.push(`<span class="badge ok">${created} numéro(s) importé(s)</span> `);
    if (replaced > 0) lines.push(`<span class="badge pending">${replaced} contact(s) mis à jour</span> `);
    if (duplicates > 0) lines.push(`<span class="badge off">${duplicates} doublon(s) ignoré(s)</span> `);
    if (blacklisted > 0) lines.push(`<span class="badge failed">${blacklisted} numéro(s) blacklisté(s)</span> `);
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
