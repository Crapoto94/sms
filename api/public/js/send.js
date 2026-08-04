'use strict';

const $ = (id) => document.getElementById(id);

let currentTab = 'composer';
let session = null;
let books = [];
let contacts = [];
let selectedBookId = null;

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
};

const badge = (label, cls) => `<span class="badge ${cls}">${label}</span>`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

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
async function loadComposer() {
  const { bookSelect } = { bookSelect: $('bookSelect') };
  const selected = bookSelect.value;
  books = await api('/admin/api/address-books');
  const html = ['<option value="">—</option>']
    .concat(books.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`))
    .join('');
  const changed = bookSelect.innerHTML !== html;
  bookSelect.innerHTML = html;
  if (changed && books.length && !books.some((b) => String(b.id) === selected)) {
    bookSelect.value = books[0].id;
  }
  bookSelect.value = selected;
  await loadRecipients();
}

async function loadRecipients() {
  const id = Number($('bookSelect').value || 0);
  selectedBookId = id;
  const list = $('recipientList');
  contacts = id ? await api(`/admin/api/address-books/${id}/contacts`) : [];
  if (!contacts.length) {
    list.innerHTML = '<div class="contact-list-empty muted">' + (id ? 'Ce carnet ne contient aucun contact.' : 'Choisissez un carnet pour afficher les contacts.') + '</div>';
    updateComposerCount();
    return;
  }
  list.innerHTML = contacts.map((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    const label = name || c.entity || c.phone;
    return `<label class="contact-row">
      <input type="checkbox" data-id="${c.id}">
      <span class="who">
        <b>${esc(label)}</b><br>
        ${c.entity && name ? `<span class="muted">${esc(c.entity)}</span> · ` : ''}<span class="phone">${esc(c.phone)}</span>
      </span>
    </label>`;
  }).join('');
  updateComposerCount();
}

$('bookSelect').addEventListener('change', loadRecipients);

$('recipientList').addEventListener('change', updateComposerCount);

function updateComposerCount() {
  const checked = document.querySelectorAll('#recipientList input:checked').length;
  const s = $('smsBody').value;
  const segs = smsSegments(s.length, s);
  $('composerCount').textContent = `${checked} destinataire(s) · ${s.length}/1000 caractères · ${segs > 1 ? segs + ' segments' : '1 segment'}`;
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

$('btnSendToSelected').addEventListener('click', async () => {
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
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const recipientIds = checks.map((c) => Number(c.dataset.id));
  const target = recipientIds
    .map((id) => contactsById.get(id))
    .filter(Boolean)
    .map((c) => c.phone);
  try {
    const created = [];
    for (const recipient of target) {
      const r = await api('/admin/api/messages', {
        method: 'POST',
        body: JSON.stringify({ recipient, message: body })
      });
      created.push(r);
    }
    $('composerSummary').classList.remove('hidden');
    $('composerSummary').textContent = `${created.length} SMS envoyé(s) pour ${target.length} destinataire(s).`;
    checks.forEach((c) => { c.checked = false; });
    updateComposerCount();
  } catch (e) {
    $('composerError').textContent = e.message;
  }
});

// ---------- Messages ----------
async function loadMessages() {
  const status = $('statusFilter').value;
  const messages = await api(`/admin/api/messages?limit=100&status=${encodeURIComponent(status)}`);
  const stateOf = (s) => badge({
    pending: 'En attente', sending: 'En cours', sent: 'Envoyé', delivered: 'Remis', failed: 'Échec'
  }[s] || s, s);
  $('messagesBody').innerHTML = messages.length
    ? messages.map((m) => `<tr>
        <td>${m.id}</td>
        <td>${fmtDate(m.created_at)}</td>
        <td class="code">${esc(m.recipient)}</td>
        <td>${esc(m.body)}</td>
        <td>${stateOf(m.status)}</td>
        <td>${esc(m.gateway_label || m.device_id || '—')}</td>
        <td class="muted">${esc(m.error || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Aucun message dans votre groupe.</td></tr>';
}

$('statusFilter').addEventListener('change', loadMessages);

// ---------- Carnets ----------
let currentBookId = null;

async function loadBooks() {
  books = await api('/admin/api/address-books');
  $('booksList').innerHTML = books.length
    ? books.map((b) => `<div class="row" style="border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:10px">
        <div>
          <strong>${esc(b.name)}</strong>
          <span class="muted"> · ${b.contact_count} contact(s)${b.group_name ? ` · ${esc(b.group_name)}` : ''}</span>
        </div>
        <button data-openbook="${b.id}" class="ghost">Ouvrir</button>
      </div>`).join('')
    : '<p class="muted">Aucun carnet d\'adresses. Créez-en un pour commencer.</p>';
  document.querySelectorAll('[data-openbook]').forEach((b) => {
    b.addEventListener('click', () => openBook(Number(b.dataset.openbook)));
  });
}

async function openBook(bookId) {
  currentBookId = bookId;
  const book = books.find((b) => b.id === bookId);
  $('bookContactsTitle').textContent = `Contacts — ${book ? book.name : ''}`;
  await loadContacts();
  $('booksList').classList.add('hidden');
  $('bookContacts').classList.remove('hidden');
}

async function loadContacts() {
  const rows = await api(`/admin/api/address-books/${currentBookId}/contacts`);
  $('contactsBody').innerHTML = rows.length
    ? rows.map((c) => `<tr>
        <td>${esc(c.first_name || '')}</td>
        <td>${esc(c.last_name || '')}</td>
        <td>${esc(c.entity || '')}</td>
        <td class="code">${esc(c.phone)}</td>
        <td><button data-delcontact="${c.id}" class="ghost">Supprimer</button></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">Aucun contact.</td></tr>';
  document.querySelectorAll('[data-delcontact]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce contact ?')) return;
      await api(`/admin/api/contacts/${b.dataset.delcontact}`, { method: 'DELETE' });
      loadContacts();
    });
  });
}

$('btnBackBooks').addEventListener('click', () => {
  $('bookContacts').classList.add('hidden');
  $('booksList').classList.remove('hidden');
  loadBooks();
});

$('btnNewBook').addEventListener('click', () => {
  $('bookName').value = '';
  $('bookModalError').textContent = '';
  $('bookModal').classList.remove('hidden');
  $('bookName').focus();
});
$('btnCancelBook').addEventListener('click', () => $('bookModal').classList.add('hidden'));

$('btnSaveBook').addEventListener('click', async () => {
  $('bookModalError').textContent = '';
  try {
    await api('/admin/api/address-books', {
      method: 'POST',
      body: JSON.stringify({ name: $('bookName').value })
    });
    $('bookModal').classList.add('hidden');
    loadBooks();
    loadComposer();
  } catch (e) {
    $('bookModalError').textContent = e.message;
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
    const res = await api(`/admin/api/address-books/${currentBookId}/import`, {
      method: 'POST',
      body: JSON.stringify({
        map,
        rows: csvRows,
        overwrite: $('overwriteBook').checked
      })
    });
    $('csvHeader').classList.add('hidden');
    const overwritten = res.replaced > 0 ? ` · ${res.replaced} contact(s) remplacé(s)` : '';
    $('importResult').textContent =
      `Import terminé : ${res.created} contact(s) ajouté(s)${overwritten} · ${res.duplicates} doublon(s) ignoré(s) · ${res.invalid.length} ligne(s) invalide(s).`;
    loadContacts();
    loadBooks();
    loadComposer();
  } catch (e) {
    $('importError').textContent = e.message;
  }
});

// ---------- Rafraîchissement automatique ----------
loadSession().then(() => showTab('composer'));
setInterval(() => {
  if (currentTab === 'messages') loadMessages();
  if (currentTab === 'composer') loadComposer();
}, 10000);
