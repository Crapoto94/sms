package com.example.smsgateway

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager

/**
 * Reçoit les confirmations de l'envoi (SMS_SENT) et de la remise (SMS_DELIVERED).
 * Le statut est mis en file d'attente : le service le remontera à l'API au
 * prochain cycle de synchronisation.
 */
class SmsResultReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val messageId = intent.getStringExtra(Config.EXTRA_MESSAGE_ID) ?: return

        val status: String
        val error: String?
        when (intent.action) {
            Config.SMS_SENT_ACTION -> {
                when (resultCode) {
                    Activity.RESULT_OK -> { status = "sent"; error = null }
                    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> { status = "failed"; error = "Erreur générique" }
                    SmsManager.RESULT_ERROR_NO_SERVICE -> { status = "failed"; error = "Pas de service réseau" }
                    SmsManager.RESULT_ERROR_NULL_PDU -> { status = "failed"; error = "PDU nul" }
                    SmsManager.RESULT_ERROR_RADIO_OFF -> { status = "failed"; error = "Radio éteinte" }
                    else -> { status = "failed"; error = "Erreur $resultCode" }
                }
            }
            Config.SMS_DELIVERED_ACTION -> {
                if (resultCode != Activity.RESULT_OK) return
                status = "delivered"
                error = null
            }
            else -> return
        }

        SmsGatewayService.noteReported(messageId)
        SmsLog.add(
            context,
            SmsLog.Entry(
                System.currentTimeMillis(),
                SmsLog.TYPE_STATUT,
                messageId,
                intent.getStringExtra(Config.EXTRA_RECIPIENT).orEmpty(),
                "",
                status,
                error
            )
        )
        if (messageId.startsWith("test-")) return
        ReportQueue.add(StatusReport(messageId, status, error, System.currentTimeMillis()))
        SmsGatewayService.requestFlush(context)
    }
}
