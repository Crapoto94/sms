# Passage au multi-tenant — notes de déploiement

Ce document résume la transformation de l'application (auparavant mono-organisation)
en SaaS multi-tenant, pour l'exploitant qui déploiera ce changement.

## Ce qui change pour l'organisation actuelle

Aucune action manuelle requise : au premier démarrage après mise à jour, `api/db.js`
migre automatiquement la base existante (`gateway.db`) :

- Une organisation **« Organisation par défaut »** (id 1) est créée et reçoit
  toutes les données existantes (messages, jetons API/passerelles, comptes,
  groupes, boîtes mail2sms, réglages Frizbi...).
- Le compte admin actuel (connexion avec identifiant vide + `ADMIN_PASSWORD`)
  devient le **super-admin** : il continue de fonctionner exactement comme
  avant pour cette organisation (les créations sans tenant explicite
  retombent sur elle), et voit en plus un nouvel onglet **Tenants** listant
  toutes les organisations de la plateforme.
- Les fonctionnalités payantes (Mail → SMS, pièce jointe avec suivi de
  lecture) sont **activées** pour cette organisation, puisqu'elle les
  utilisait déjà en production — aucune régression.
- La migration est rejouable sans risque (testée sur plusieurs démarrages
  consécutifs) : rien n'est dupliqué si le conteneur redémarre.

**Recommandé avant mise en production** : testez d'abord sur une copie du
fichier `gateway.db` réel (`cp api/data/gateway.db /tmp/test.db`, puis
`DATA_DIR=/tmp node api/server.js`), jamais directement sur les données de
prod tant que vous n'avez pas vérifié le résultat.

## Nouvelles variables d'environnement (SMTP)

La création de compte en libre-service (`/signup.html`) envoie un e-mail de
vérification. Sans configuration SMTP, le lien de vérification est
seulement journalisé dans les logs du conteneur (utile en test, à éviter en
production réelle). À ajouter dans `.env` / docker-compose :

| Variable | Rôle | Défaut |
|---|---|---|
| `PUBLIC_BASE_URL` | URL publique utilisée dans les liens (vérification, pièces jointes) | déduit de la requête |
| `SMTP_HOST` | Serveur SMTP transactionnel | — (pas d'envoi si vide) |
| `SMTP_PORT` | Port SMTP | `587` |
| `SMTP_SECURE` | `true`/`false` (TLS implicite) | `false` |
| `SMTP_USER` / `SMTP_PASSWORD` | Identifiants SMTP | — |
| `SMTP_FROM` | Adresse expéditrice | `SMTP_USER` |

Ces variables sont **indépendantes** des boîtes mail2sms (qui restent une
fonctionnalité métier configurée par tenant, à activer au cas par cas).

## Nouveau modèle de rôles

| Rôle | Portée | Équivalent avant |
|---|---|---|
| `super_admin` | Toutes les organisations (nouvel onglet Tenants) | le seul admin (connexion sans identifiant) |
| `admin` | Une organisation entière (jetons, passerelles, comptes, groupes...) | le rôle « admin » d'un compte |
| `user` | Un seul groupe au sein d'une organisation | inchangé |

## Fonctionnalités par tenant

Gratuites par défaut : envoi unitaire, envoi en masse, envoi par API.
À activer au cas par cas depuis l'onglet **Tenants** (super-admin) :
Mail → SMS, pièce jointe avec suivi de lecture.

Pistes documentées mais non câblées (pas de modèle de facturation défini à
ce stade) : intégration Frizbi, synchronisation LDAP/CSV externe, quotas
étendus, rétention/export prolongés, webhooks de statut, expéditeur
personnalisé, SSO.

## Vérifier après déploiement

```bash
cd api && npm test   # suite de régression : isolation tenants/groupes,
                      # activation des fonctionnalités, jeton de vérification
```

## Volet APK (app Android)

Le code de l'onglet « Messages » (SMS normal, en plus de la « Passerelle »
existante inchangée) est écrit mais **n'a pas pu être compilé dans
l'environnement d'agent** utilisé pour ce travail : `Selector.open()` de
Java y échoue systématiquement (restriction du bac à sable sur les sockets
loopback internes de la JVM, indépendante de ce projet — confirmé avec 3
JDK différents). Sur un poste de développement normal, `./gradlew
assembleDebug` devrait fonctionner sans particularité.
