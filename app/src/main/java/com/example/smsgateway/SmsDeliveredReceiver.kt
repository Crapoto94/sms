package com.example.smsgateway

import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * Déclaré pour être éligible comme application SMS par défaut (Android 4.4+).
 * Stocke les SMS reçus dans le provider SMS. Le service les lit ensuite pour
 * les remonter à l'API avec leur identifiant provider comme dédoublonnage.
 */
class SmsDeliveredReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isEmpty()) return

        val first = messages.first()
        val body = messages.joinToString(separator = "") { it.messageBody.orEmpty() }
        val incoming = IncomingSms(
            id = first.timestampMillis,
            sender = first.originatingAddress.orEmpty(),
            body = body,
            date = first.timestampMillis
        )
        SmsGatewayService.submitIncoming(context, listOf(incoming))
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS, first.originatingAddress.orEmpty())
            put(Telephony.Sms.BODY, body)
            put(Telephony.Sms.DATE, first.timestampMillis)
            put(Telephony.Sms.DATE_SENT, first.timestampMillis)
            put(Telephony.Sms.READ, 0)
            put(Telephony.Sms.SEEN, 0)
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
        }
        try {
            context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)
        } catch (e: Exception) {
            SmsLog.add(
                context,
                SmsLog.Entry(
                    System.currentTimeMillis(), SmsLog.TYPE_ERREUR, "", "", body,
                    null, "Enregistrement du SMS reçu impossible : ${e.message}"
                )
            )
        }
    }
}
