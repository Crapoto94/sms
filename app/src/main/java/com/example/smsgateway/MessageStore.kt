package com.example.smsgateway

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.Telephony

/**
 * Écriture dans le fournisseur SMS du téléphone pour les envois "normaux"
 * (onglet Messages, hors passerelle). Contrairement à la réception (déjà
 * gérée par [SmsDeliveredReceiver], obligatoire pour le rôle app SMS par
 * défaut), Android n'écrit JAMAIS automatiquement les messages envoyés par
 * l'app par défaut : c'est à elle de journaliser son propre envoi dans
 * content://sms (dossier "Envoyés"), sans quoi l'historique de conversation
 * ne contiendrait que les messages reçus.
 */
object MessageStore {

    /** Identifiant de conversation pour un numéro, créé si besoin. */
    fun threadIdFor(context: Context, address: String): Long =
        Telephony.Threads.getOrCreateThreadId(context, address)

    /**
     * Insère le message sortant (immédiatement marqué comme envoyé : cette
     * appli ne distingue pas "en cours d'envoi" de "envoyé" dans la liste,
     * [markSendResult] corrige en "échec" si besoin une fois la confirmation
     * radio reçue). Renvoie l'identifiant de ligne (utilisé comme id de
     * message pour suivre le résultat de l'envoi), ou null si l'écriture a
     * échoué.
     */
    fun insertOutgoing(context: Context, address: String, body: String, threadId: Long): String? {
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS, address)
            put(Telephony.Sms.BODY, body)
            put(Telephony.Sms.DATE, System.currentTimeMillis())
            put(Telephony.Sms.READ, 1)
            put(Telephony.Sms.SEEN, 1)
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT)
            put(Telephony.Sms.THREAD_ID, threadId)
        }
        val uri: Uri = try {
            context.contentResolver.insert(Telephony.Sms.CONTENT_URI, values) ?: return null
        } catch (_: Exception) {
            return null
        }
        return uri.lastPathSegment
    }

    /** Corrige le type du message en échec si l'envoi radio a finalement échoué. */
    fun markSendResult(context: Context, rowId: String, success: Boolean) {
        if (success) return
        val id = rowId.toLongOrNull() ?: return
        val values = ContentValues().apply {
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_FAILED)
        }
        try {
            context.contentResolver.update(Telephony.Sms.CONTENT_URI, values, "_id = ?", arrayOf(id.toString()))
        } catch (_: Exception) {
            // pas bloquant : le message reste visible, juste sans statut d'échec
        }
    }

    /**
     * Envoie un SMS "normal" : écrit d'abord la ligne "Envoyés", puis lance
     * l'envoi radio (SmsSender gère déjà multipart et sélection de SIM). La
     * confirmation d'échec est appliquée plus tard par [SmsResultReceiver]
     * via [markSendResult].
     */
    fun sendMessage(context: Context, address: String, body: String): Long {
        val threadId = threadIdFor(context, address)
        val rowId = insertOutgoing(context, address, body, threadId) ?: return threadId
        SmsSender.send(context, OutgoingMessage(Config.LOCAL_PROFILE_ID, rowId, address, body))
        return threadId
    }
}
