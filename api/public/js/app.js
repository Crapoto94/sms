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
    if (currentTab === 'keys') loadKeys();
    if (currentTab === 'gateways') loadGateways();
    if (currentTab === 'messages') loadMessages();
  });
});

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
        <td class="muted">${esc(m.error || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Aucun message.</td></tr>';
}

$('statusFilter').addEventListener('change', loadMessages);

// ---------- Rafraîchissement automatique ----------
loadKeys();
setInterval(() => {
  if (currentTab === 'gateways') loadGateways();
  if (currentTab === 'messages') loadMessages();
}, 10000);
