'use strict';

const $ = (id) => document.getElementById(id);

let currentTab = 'keys';

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
    $('logs').classList.toggle('hidden', currentTab !== 'logs');
    $('accounts').classList.toggle('hidden', currentTab !== 'accounts');
    $('groups').classList.toggle('hidden', currentTab !== 'groups');
    if (currentTab === 'keys') loadKeys();
    if (currentTab === 'gateways') loadGateways();
    if (currentTab === 'messages') loadMessages();
    if (currentTab === 'logs') loadLogs();
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
async function loadGateways() {
  const [gateways, stats] = await Promise.all([
    api('/admin/api/gateways'),
    api('/admin/api/stats')
  ]);
  $('online').textContent = `${stats.gatewaysOnline} passerelle(s) en ligne`;
  $('gatewaysBody').innerHTML = gateways.length
    ? gateways.map((g) => {
        const online = g.last_seen_at && Date.now() - new Date(g.last_seen_at).getTime() < 3 * 60 * 1000;
        const state = online ? badge('En ligne', 'ok') : badge('Hors ligne', 'off');
        return `<tr>
          <td>${esc(g.label || '—')}</td>
          <td class="code">${esc(g.device_id || '—')}</td>
          <td>${fmtDate(g.last_seen_at)}</td>
          <td>${g.sending}</td>
          <td>${g.sent}</td>
          <td>${g.delivered}</td>
          <td>${g.failed}</td>
          <td>${state}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="8" class="muted">Aucune passerelle connectée.</td></tr>';
}

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
        <td>${esc(m.group_name || '—')}</td>
        <td class="muted">${esc(m.error || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="muted">Aucun message.</td></tr>';
}

$('statusFilter').addEventListener('change', loadMessages);

$('btnExport').addEventListener('click', () => {
  const status = $('statusFilter').value;
  const url = '/admin/api/messages/export' + (status ? `?status=${encodeURIComponent(status)}` : '');
  window.location.href = url;
});

// ---------- Envoi manuel ----------
$('btnNewMessage').addEventListener('click', () => {
  $('smsRecipient').value = '';
  $('smsBody').value = '';
  updateSmsCounter();
  $('messageError').textContent = '';
  $('messageModal').classList.remove('hidden');
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

$('btnSendMessage').addEventListener('click', async () => {
  $('messageError').textContent = '';
  try {
    await api('/admin/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        recipient: $('smsRecipient').value,
        message: $('smsBody').value
      })
    });
    $('messageModal').classList.add('hidden');
    loadMessages();
  } catch (e) {
    $('messageError').textContent = e.message;
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
          <td>${fmtDate(a.created_at)}</td>
          <td>${state}</td>
          <td>
            <button data-editacc="${a.id}" class="ghost">Éditer</button>
            <button data-pwd="${a.id}" class="ghost">Mot de passe</button>
            <button data-toggle="${a.id}" data-disabled="${a.disabled ? 1 : 0}" class="ghost">${toggleLabel}</button>
            <button data-delacc="${a.id}" class="danger">Supprimer</button>
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="7" class="muted">Aucun compte. Les comptes se connectent avec un identifiant et un mot de passe.</td></tr>';
  document.querySelectorAll('[data-pwd]').forEach((b) => {
    b.addEventListener('click', () => openAccountModal(Number(b.dataset.pwd)));
  });
  document.querySelectorAll('[data-editacc]').forEach((b) => {
    b.addEventListener('click', async () => {
      const a = accounts.find((x) => x.id === Number(b.dataset.editacc));
      if (a) openAccountModal(a.id, a);
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
}

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
    if (pendingAccountEdit) {
      await api(`/admin/api/accounts/${pendingAccountId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role, groupId })
      });
    } else if (pendingAccountId === null) {
      await api('/admin/api/accounts', {
        method: 'POST',
        body: JSON.stringify({
          login: $('accountLogin').value,
          password: $('accountPassword').value,
          role,
          groupId
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
        <td>${g.message_count}</td>
        <td>${fmtDate(g.created_at)}</td>
        <td>
          <button data-editgroup="${g.id}" data-name="${esc(g.name)}" class="ghost">Renommer</button>
          <button data-delgroup="${g.id}" class="danger">Supprimer</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="muted">Aucun groupe. Créez un groupe puis rattachez-y les comptes utilisateurs.</td></tr>';
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

// ---------- Rafraîchissement automatique ----------
loadKeys();
setInterval(() => {
  if (currentTab === 'gateways') loadGateways();
  if (currentTab === 'messages') loadMessages();
  if (currentTab === 'logs') loadLogs();
}, 10000);
