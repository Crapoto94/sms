'use strict';

// Client pour l'API SMS externe Frizbi (paramétrage repris de C:\dev\APM,
// endpoints confirmés par Frizbi_API_V2.3_Complet.md).
// Le JWT est valide 5 minutes : on le met en cache pour éviter un login à
// chaque appel (envoi, statut).

let tokenCache = null; // { key, token, expiresAt }

function cacheKey(settings) {
  return `${settings.api_url}|${settings.client_id}`;
}

async function frizbiLogin(settings) {
  const apiUrl = String(settings.api_url || '').replace(/\/+$/, '');
  if (!apiUrl || !settings.client_id || !settings.client_secret) {
    throw new Error('Paramètres Frizbi incomplets (URL, Client ID ou Client Secret manquant)');
  }
  const key = cacheKey(settings);
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }
  let res;
  try {
    res = await fetch(`${apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: settings.client_id, password: settings.client_secret })
    });
  } catch (err) {
    throw new Error(`Frizbi injoignable : ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(`Échec de l'authentification Frizbi : ${data.details || data.message || `HTTP ${res.status}`}`);
  }
  // Token annoncé valide 5 min : on le garde 4 min pour rester dans les clous.
  tokenCache = { key, token: data.token, expiresAt: Date.now() + 4 * 60 * 1000 };
  return data.token;
}

/**
 * Envoie un lot de SMS (même corps de message) à plusieurs destinataires en
 * un seul appel Frizbi (customerSmsId unique pour tout le lot).
 * contacts: [{ id, mobile, firstName, lastName }]
 */
async function frizbiSend(settings, { title, message, contacts, customerSmsId }) {
  const token = await frizbiLogin(settings);
  const apiUrl = String(settings.api_url || '').replace(/\/+$/, '');
  const payload = {
    customerSmsId: customerSmsId || `sms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: title || 'Notification',
    message,
    customerSenderId: settings.sender_id || 'IVRY',
    smsContacts: contacts.map((c, i) => ({
      customerSmsContactId: c.id != null ? String(c.id) : `contact_${Date.now()}_${i}`,
      mobile: c.mobile,
      firstName: c.firstName || '',
      lastName: c.lastName || ''
    }))
  };
  let res;
  try {
    res = await fetch(`${apiUrl}/api/sms/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new Error(`Frizbi injoignable : ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== 'success') {
    throw new Error(`Échec de l'envoi Frizbi : ${data.details || data.message || `HTTP ${res.status}`}`);
  }
  return {
    customerSmsId: data.customer_sms_id || payload.customerSmsId,
    frizbiSendId: data.frizbi_send_id != null ? String(data.frizbi_send_id) : null,
    raw: data
  };
}

/**
 * Historique/statut d'un envoi. Réponse non documentée précisément par
 * Frizbi (pas d'exemple JSON dans la doc V2.3) : on renvoie le JSON brut,
 * à interpréter au niveau appelant en fonction de ce qui est observé en
 * conditions réelles.
 * Statuts documentés : status_pending_0, status_pending, status_sent
 * (= délivré), status_error, status_sent_not_delivered, status_canceled.
 */
async function frizbiStatus(settings, customerSmsId) {
  const token = await frizbiLogin(settings);
  const apiUrl = String(settings.api_url || '').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${apiUrl}/api/sms/status/${encodeURIComponent(customerSmsId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    throw new Error(`Frizbi injoignable : ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Échec de la lecture du statut Frizbi : ${data.details || data.message || `HTTP ${res.status}`}`);
  }
  return data;
}

module.exports = { frizbiLogin, frizbiSend, frizbiStatus };
