# API Frizbi V2.3 - Guide complet pour développeurs IA

Ce document regroupe les informations nécessaires à l'intégration de l'API Frizbi V2.

## Base URL
- Préproduction : https://apiv2.frizbi.evolnet.fr
- Swagger : https://apiv2.frizbi.evolnet.fr/api/doc/sms

## Authentification
### POST /api/auth/login
```json
{
  "login": "API_KEY",
  "password": "API_SECRET"
}
```
Réponse :
```json
{
  "token": "JWT"
}
```
Header requis pour tous les autres endpoints :
```http
Authorization: Bearer <token>
```
Token valide 5 minutes.

## POST /api/sms/send
Envoi SMS unitaire ou campagne.

### Champs
- customerSmsId (obligatoire, unique)
- message (obligatoire)
- smsContacts[] (obligatoire)
- date (optionnel)
- customerSenderId (optionnel)
- sendDoc (true/false)

### Contact
```json
{
  "customerSmsContactId":"id-contact",
  "mobile":"0660000000",
  "firstName":"John",
  "lastName":"Doe",
  "variables":[
    {
      "variableKey":"code",
      "variableValue":"1234"
    }
  ]
}
```

Variables utilisables dans le message : `$firstname$`, `$lastname$` et toute variable personnalisée.

### Réponse succès
```json
{
  "status":"success",
  "frizbi_send_id":1149,
  "customer_sms_id":"sms-id"
}
```

### Réponse erreur
```json
{
  "status":"error",
  "details":"Erreur",
  "code":"ERROR_CODE"
}
```

## GET /api/sms/status/{customerSmsId}
Historique complet d'un envoi.

### Statuts
- status_pending_0 = En attente d'envoi
- status_pending = En cours d'envoi
- status_sent = Délivré
- status_error = Erreur
- status_sent_not_delivered = Non délivré
- status_canceled = Annulé

### Codes observés dans l'historique
- waiting
- pending
- sent

## POST /api/sms/delete/{customerSmsId}
Suppression d'un envoi différé.
Condition : plus de 2 minutes avant émission.

## Notifications temps réel
Paramétrage Admin > API.

Exemple :
```text
https://mon-app/callback?customerSmsContactId=id
```

## Gestion documentaire
### sendDoc=true
Ajoute un lien unique d'upload photo/document.

### Callback document
```text
customerSmsContactId=<id>&type=document&docReqId=<documentId>
```

### GET /api/sms/document/get-doc/{id}
```json
{
  "file":"data:image/JPG;base64,..."
}
```

### GET /api/sms/document/last-documentIds
Retourne les documents non consultés.

```json
[
 {
   "id":5,
   "integrationDate":"2020-11-17T21:26:50+01:00",
   "image":"file.png",
   "customerSmsContactId":"456"
 }
]
```

### Documents Base64
Réponse contenant :
```json
{
  "id":5,
  "file":"data:image/png;base64,..."
}
```

## Contraintes SMS
- SMS simple : 160 caractères
- SMS concaténé : segments de 153 caractères
- Caractères doubles : € [ ] \\ ^ { | } ~

## Recommandations d'intégration
- Renouveler le JWT avant expiration.
- CustomerSmsId unique.
- CustomerSmsContactId unique.
- Conserver frizbi_send_id.
- Exploiter les callbacks plutôt que le polling.
