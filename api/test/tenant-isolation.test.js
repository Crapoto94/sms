'use strict';

// Tests d'isolation multi-tenant : démarre une vraie instance du serveur
// (base de données jetable, jamais celle de production) et vérifie par de
// vraies requêtes HTTP les garanties critiques introduites par la
// conversion multi-tenant, sur l'ensemble des fonctionnalités nommées dans
// la demande d'origine :
//   - le compte pivot (super-admin) garde le fonctionnement historique,
//   - l'inscription en libre-service isole totalement un nouveau tenant
//     (messages, jetons API/passerelles),
//   - un utilisateur ne voit jamais les données d'un autre groupe/tenant,
//   - les fonctionnalités payantes (mail2sms, pièce jointe + suivi de
//     lecture) sont bloquées tant qu'elles ne sont pas activées par le
//     super-admin, et fonctionnent une fois activées,
//   - envoi en masse (campagne) et vérification de flotte, sur un carnet
//     d'adresses, restent isolés par tenant comme l'envoi unitaire,
//   - régression du bug corrigé le 2026-09-03 : un admin de tenant ne peut
//     plus rattacher un groupId appartenant à un autre tenant.
//
// Lancer avec : npm test (depuis api/), ou node --test test/*.test.js
// (nécessite Node >= 22, pour node:test et fetch/FormData natifs)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_PORT = 13500;
const WEB_PORT = 13501;
const BASE = `http://localhost:${WEB_PORT}`;
const ADMIN_PASSWORD = 'test-password-only';

let serverProcess;
let dataDir;

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-gateway-test-'));
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT_API: String(API_PORT),
        PORT_WEB: String(WEB_PORT),
        ADMIN_PASSWORD
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let ready = false;
    const onData = (chunk) => {
      if (ready) return;
      if (chunk.toString().includes('interface sur le port')) {
        ready = true;
        resolve();
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', onData);
    serverProcess.on('error', reject);
    setTimeout(() => { if (!ready) reject(new Error('Serveur non démarré après 10s')); }, 10000);
  });
}

async function stopServer() {
  if (serverProcess) {
    const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
    serverProcess.kill();
    // Sur Windows, le fichier SQLite reste verrouillé tant que le process
    // n'a pas complètement rendu la main ; on attend sa sortie (avec un
    // filet de sécurité) avant de tenter de supprimer le dossier temporaire.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  if (dataDir) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}

// ---------- Petit client HTTP avec gestion de cookie de session ----------
function makeClient() {
  let cookie = null;
  async function request(path, options) {
    const res = await fetch(BASE + path, { ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  return {
    get: (path) => request(path, {}),
    post: (path, body) => request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    // Envoi multipart (upload de pièce jointe) : pas de Content-Type manuel,
    // fetch le calcule (avec la boundary) à partir du FormData.
    postForm: (path, formData) => request(path, { method: 'POST', body: formData })
  };
}

async function loginSuperAdmin() {
  const client = makeClient();
  const res = await client.post('/admin/login', { login: '', password: ADMIN_PASSWORD });
  assert.equal(res.status, 200, 'le super-admin doit pouvoir se connecter avec ADMIN_PASSWORD');
  assert.equal(res.data.role, 'super_admin');
  return client;
}

// Crée un tenant complet (signup + vérification) et renvoie un client
// connecté en tant qu'admin de ce tenant, en lisant le jeton dans les logs
// serveur (aucun SMTP configuré en test : le lien est journalisé). Ne
// regarde que la portion de log apparue APRÈS le signup, pour ne pas
// récupérer par erreur le jeton d'un tenant créé plus tôt dans la suite.
let logBuffer = '';
async function signupAndVerify({ organisation, login, email, password }) {
  const client = makeClient();
  const logOffset = logBuffer.length;
  const signupRes = await client.post('/admin/signup', { organisation, login, email, password });
  assert.equal(signupRes.status, 201, `signup de ${login} doit réussir`);

  // Le compte ne doit pas pouvoir se connecter avant vérification.
  const blockedLogin = await client.post('/admin/login', { login, password });
  assert.equal(blockedLogin.status, 403, 'la connexion doit être bloquée avant vérification de l’e-mail');

  const match = /verify-email\.html\?token=([A-Za-z0-9_-]+)/.exec(logBuffer.slice(logOffset));
  assert.ok(match, 'le lien de vérification doit apparaître dans les logs (pas de SMTP en test)');
  const verifyRes = await client.post('/admin/verify-email', { token: match[1] });
  assert.equal(verifyRes.status, 200);

  const loginRes = await client.post('/admin/login', { login, password });
  assert.equal(loginRes.status, 200, `connexion de ${login} doit réussir après vérification`);
  assert.equal(loginRes.data.role, 'admin');
  return { client, tenantId: loginRes.data.tenantId };
}

test('isolation multi-tenant', async (t) => {
  await startServer();
  serverProcess.stdout.on('data', (c) => { logBuffer += c.toString(); });
  serverProcess.stderr.on('data', (c) => { logBuffer += c.toString(); });
  t.after(stopServer);

  await t.test('le compte pivot (login vide) est super_admin, tenant historique intact', async () => {
    const admin = await loginSuperAdmin();
    const session = await admin.get('/admin/api/session');
    assert.equal(session.data.role, 'super_admin');
    assert.equal(session.data.tenantId, 1, 'le super-admin garde le tenant historique comme tenant courant');
    assert.equal(session.data.tenant.name, 'Organisation par défaut');
  });

  await t.test('deux tenants créés en libre-service sont totalement isolés', async () => {
    const acme = await signupAndVerify({ organisation: 'Acme Corp', login: 'acme-admin', email: 'a@acme.test', password: 'motdepasse123' });
    const beta = await signupAndVerify({ organisation: 'Beta LLC', login: 'beta-admin', email: 'b@beta.test', password: 'motdepasse123' });
    assert.notEqual(acme.tenantId, beta.tenantId);

    await acme.client.post('/admin/api/messages', { recipient: '0611110000', message: 'secret acme' });
    await beta.client.post('/admin/api/messages', { recipient: '0622220000', message: 'secret beta' });

    const acmeMessages = await acme.client.get('/admin/api/messages?pageSize=50');
    const betaMessages = await beta.client.get('/admin/api/messages?pageSize=50');
    const acmeBodies = acmeMessages.data.items.map((m) => m.body);
    const betaBodies = betaMessages.data.items.map((m) => m.body);
    assert.ok(acmeBodies.includes('secret acme'));
    assert.ok(!acmeBodies.includes('secret beta'), 'Acme ne doit jamais voir un message de Beta');
    assert.ok(betaBodies.includes('secret beta'));
    assert.ok(!betaBodies.includes('secret acme'), 'Beta ne doit jamais voir un message de Acme');

    // Jetons API/passerelles isolés eux aussi.
    await acme.client.post('/admin/api/keys', { label: 'acme-key', type: 'web' });
    const acmeKeys = await acme.client.get('/admin/api/keys');
    const betaKeys = await beta.client.get('/admin/api/keys');
    assert.equal(acmeKeys.data.length, 1);
    assert.equal(betaKeys.data.length, 0, 'Beta ne doit pas voir les jetons d’Acme');
  });

  await t.test('fonctionnalité payante bloquée tant qu’elle n’est pas activée', async () => {
    const org = await signupAndVerify({ organisation: 'Gamma Inc', login: 'gamma-admin', email: 'g@gamma.test', password: 'motdepasse123' });
    const res = await org.client.post('/admin/api/mail2sms', {
      name: 'boite', email: 'x@example.com', imapHost: 'imap.example.com',
      login: 'x', password: 'p', allowedSenders: '*@example.com'
    });
    assert.equal(res.status, 403, 'mail2sms doit être refusé par défaut pour un nouveau tenant');

    const admin = await loginSuperAdmin();
    const tenants = await admin.get('/admin/api/tenants');
    const gamma = tenants.data.find((t2) => t2.name === 'Gamma Inc');
    assert.ok(gamma, 'le tenant Gamma doit apparaître dans la liste du super-admin');
    const toggle = await admin.post(`/admin/api/tenants/${gamma.id}/features`, { feature: 'mail2sms', enabled: true });
    assert.equal(toggle.status, 200);

    const res2 = await org.client.post('/admin/api/mail2sms', {
      name: 'boite', email: 'x@example.com', imapHost: 'imap.example.com',
      login: 'x', password: 'p', allowedSenders: '*@example.com'
    });
    assert.equal(res2.status, 201, 'mail2sms doit fonctionner une fois activé par le super-admin');
  });

  await t.test('deux groupes du même tenant restent isolés l’un de l’autre', async () => {
    const admin = await loginSuperAdmin();
    const g1 = await admin.post('/admin/api/groups', { name: 'Commercial' });
    const g2 = await admin.post('/admin/api/groups', { name: 'Support' });
    await admin.post('/admin/api/accounts', { login: 'alice-user', password: 'motdepasse123', role: 'user', groupId: g1.data.id, email: 'alice@example.com' });
    await admin.post('/admin/api/accounts', { login: 'bob-user', password: 'motdepasse123', role: 'user', groupId: g2.data.id, email: 'bob@example.com' });

    const alice = makeClient();
    await alice.post('/admin/login', { login: 'alice-user', password: 'motdepasse123' });
    const bob = makeClient();
    await bob.post('/admin/login', { login: 'bob-user', password: 'motdepasse123' });

    await alice.post('/admin/api/messages', { recipient: '0633330000', message: 'secret alice' });
    await bob.post('/admin/api/messages', { recipient: '0644440000', message: 'secret bob' });

    const aliceView = await alice.get('/admin/api/messages?pageSize=50');
    const bobView = await bob.get('/admin/api/messages?pageSize=50');
    assert.ok(aliceView.data.items.every((m) => m.body !== 'secret bob'), 'Alice ne doit pas voir le message de Bob');
    assert.ok(bobView.data.items.every((m) => m.body !== 'secret alice'), 'Bob ne doit pas voir le message d’Alice');
  });

  await t.test('régression : un admin ne peut pas rattacher le groupId d’un autre tenant à un message', async () => {
    const victim = await signupAndVerify({ organisation: 'Victim Org', login: 'victim-admin', email: 'v@victim.test', password: 'motdepasse123' });
    const victimGroups = await victim.client.get('/admin/api/groups');
    const foreignGroupId = victimGroups.data[0].id;

    const admin = await loginSuperAdmin();
    const t1Admin = await admin.post('/admin/api/accounts', { login: 'attacker-admin', password: 'motdepasse123', role: 'admin', email: 'atk@example.com' });
    assert.equal(t1Admin.status, 201);
    const attacker = makeClient();
    const attackerLogin = await attacker.post('/admin/login', { login: 'attacker-admin', password: 'motdepasse123' });
    assert.equal(attackerLogin.status, 200);

    const attack = await attacker.post('/admin/api/messages', {
      recipient: '0699990000', message: 'attack', groupId: foreignGroupId
    });
    assert.equal(attack.status, 400, 'l’injection d’un groupId d’un autre tenant doit être rejetée');
    assert.match(attack.data.error, /introuvable/i);
  });

  await t.test('envoi en masse via une campagne (carnet d’adresses) reste isolé par tenant', async () => {
    const delta = await signupAndVerify({ organisation: 'Delta SAS', login: 'delta-admin', email: 'd@delta.test', password: 'motdepasse123' });
    const echo = await signupAndVerify({ organisation: 'Echo Ltd', login: 'echo-admin', email: 'e@echo.test', password: 'motdepasse123' });

    // Un carnet d'adresses doit être rattaché à un groupe : le compte admin
    // créé au signup n'en a pas par défaut, on en crée un.
    const deltaGroup = await delta.client.post('/admin/api/groups', { name: 'Ventes' });
    assert.equal(deltaGroup.status, 201);
    const book = await delta.client.post('/admin/api/address-books', { name: 'Clients', groupId: deltaGroup.data.id });
    assert.equal(book.status, 201);
    const c1 = await delta.client.post(`/admin/api/address-books/${book.data.id}/contacts`, { firstName: 'Jean', lastName: 'Dupont', phone: '0611110001' });
    const c2 = await delta.client.post(`/admin/api/address-books/${book.data.id}/contacts`, { firstName: 'Marie', lastName: 'Martin', phone: '0611110002' });
    assert.equal(c1.status, 201);
    assert.equal(c2.status, 201);

    const campaign = await delta.client.post('/admin/api/campaigns', {
      bookId: book.data.id, contactIds: [c1.data.id, c2.data.id], message: 'Campagne de test'
    });
    assert.equal(campaign.status, 201, 'la campagne doit être créée avec ses 2 destinataires');
    assert.equal(campaign.data.count, 2);

    const deltaMessages = await delta.client.get('/admin/api/messages?pageSize=50');
    const campaignBodies = deltaMessages.data.items.filter((m) => m.body === 'Campagne de test');
    assert.equal(campaignBodies.length, 2, 'les 2 messages de la campagne doivent apparaître chez Delta');

    // Echo ne doit rien voir de la campagne de Delta, et ne doit pas pouvoir
    // cibler le carnet d'adresses de Delta pour sa propre campagne.
    const echoMessages = await echo.client.get('/admin/api/messages?pageSize=50');
    assert.ok(echoMessages.data.items.every((m) => m.body !== 'Campagne de test'));

    const crossTenantCampaign = await echo.client.post('/admin/api/campaigns', {
      bookId: book.data.id, contactIds: [c1.data.id], message: 'tentative intrusion'
    });
    assert.equal(crossTenantCampaign.status, 404, 'Echo ne doit pas pouvoir utiliser le carnet d’adresses de Delta');
  });

  await t.test('pièce jointe + suivi de lecture : bloqué par défaut, isolé une fois activé', async () => {
    const foxtrot = await signupAndVerify({ organisation: 'Foxtrot SA', login: 'foxtrot-admin', email: 'f@foxtrot.test', password: 'motdepasse123' });

    const form1 = new FormData();
    form1.append('file', new Blob(['contenu de test'], { type: 'text/plain' }), 'note.txt');
    const blocked = await foxtrot.client.postForm('/admin/api/attachments', form1);
    assert.equal(blocked.status, 403, 'la pièce jointe doit être bloquée tant que la fonctionnalité n’est pas activée');

    const admin = await loginSuperAdmin();
    const tenants = await admin.get('/admin/api/tenants');
    const foxtrotTenant = tenants.data.find((t2) => t2.name === 'Foxtrot SA');
    assert.ok(foxtrotTenant, 'le tenant Foxtrot doit apparaître dans la liste du super-admin');
    const toggle = await admin.post(`/admin/api/tenants/${foxtrotTenant.id}/features`, { feature: 'attachment_read_receipt', enabled: true });
    assert.equal(toggle.status, 200);

    const form2 = new FormData();
    form2.append('file', new Blob(['contenu de test'], { type: 'text/plain' }), 'note.txt');
    const uploaded = await foxtrot.client.postForm('/admin/api/attachments', form2);
    assert.equal(uploaded.status, 201, 'l’upload doit réussir une fois la fonctionnalité activée');
    assert.ok(uploaded.data.url, 'une URL publique doit être renvoyée');

    // Le lien public déclenche bien un suivi de lecture (attachment_opens) :
    // c'est tout l'intérêt de la fonctionnalité payante.
    const opened = await fetch(uploaded.data.url);
    assert.equal(opened.status, 200);
    const opensView = await foxtrot.client.get(`/admin/api/attachments/${uploaded.data.id}/opens`);
    assert.equal(opensView.status, 200);
    assert.equal(opensView.data.openCount, 1, 'l’ouverture du lien doit être comptabilisée');

    // Un autre tenant ne doit jamais pouvoir consulter le suivi de lecture
    // d'une pièce jointe qui ne lui appartient pas.
    const golf = await signupAndVerify({ organisation: 'Golf Ltd', login: 'golf-admin', email: 'g@golf.test', password: 'motdepasse123' });
    const foreignOpens = await golf.client.get(`/admin/api/attachments/${uploaded.data.id}/opens`);
    assert.equal(foreignOpens.status, 404, 'un autre tenant ne doit pas accéder au suivi de lecture d’une pièce jointe étrangère');
  });

  await t.test('vérification de flotte : créée et isolée par tenant comme une campagne', async () => {
    const hotel = await signupAndVerify({ organisation: 'Hotel Corp', login: 'hotel-admin', email: 'h@hotel.test', password: 'motdepasse123' });
    const india = await signupAndVerify({ organisation: 'India Co', login: 'india-admin', email: 'i@india.test', password: 'motdepasse123' });

    const hotelGroup = await hotel.client.post('/admin/api/groups', { name: 'Flotte' });
    const book = await hotel.client.post('/admin/api/address-books', { name: 'Véhicules', groupId: hotelGroup.data.id });
    const c1 = await hotel.client.post(`/admin/api/address-books/${book.data.id}/contacts`, { firstName: 'Camion', lastName: '1', phone: '0611119001' });
    assert.equal(c1.status, 201);

    const check = await hotel.client.post('/admin/api/fleet-checks', {
      bookId: book.data.id, contactIds: [c1.data.id], message: 'Merci de répondre OK'
    });
    assert.equal(check.status, 201, 'la vérification de flotte doit être créée');
    assert.equal(check.data.count, 1);

    const hotelChecks = await hotel.client.get('/admin/api/fleet-checks');
    assert.equal(hotelChecks.status, 200);
    assert.ok(hotelChecks.data.some((f) => f.id === check.data.id));

    const indiaChecks = await india.client.get('/admin/api/fleet-checks');
    assert.ok(indiaChecks.data.every((f) => f.id !== check.data.id), 'India ne doit pas voir la vérification de flotte d’Hotel');

    const crossTenantCheck = await india.client.post('/admin/api/fleet-checks', {
      bookId: book.data.id, contactIds: [c1.data.id], message: 'intrusion'
    });
    assert.equal(crossTenantCheck.status, 404, 'India ne doit pas pouvoir utiliser le carnet d’adresses d’Hotel');
  });
});
