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
        val profileId = intent.getStringExtra(Config.EXTRA_PROFILE_ID).orEmpty()
        val partIndex = intent.getIntExtra(Config.EXTRA_PART_INDEX, 0)
        val partTotal = intent.getIntExtra(Config.EXTRA_PART_TOTAL, 1)
        val simSlot = if (intent.hasExtra(Config.EXTRA_SIM_SLOT)) intent.getIntExtra(Config.EXTRA_SIM_SLOT, 0) else null
        val simNumber = intent.getStringExtra(Config.EXTRA_SIM_NUMBER)

        val report: StatusReport? = when (intent.action) {
            Config.SMS_SENT_ACTION -> {
                val ok = resultCode == Activity.RESULT_OK
                val error = when (resultCode) {
                    Activity.RESULT_OK -> null
                    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Erreur générique"
                    SmsManager.RESULT_ERROR_NO_SERVICE -> "Pas de service réseau"
                    SmsManager.RESULT_ERROR_NULL_PDU -> "PDU nul"
                    SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio éteinte"
                    else -> "Erreur $resultCode"
                }
                MultipartTracker.onSent(context, profileId, messageId, partIndex, partTotal, ok, error, simSlot, simNumber)
            }
            Config.SMS_DELIVERED_ACTION -> {
                if (resultCode != Activity.RESULT_OK) return
                MultipartTracker.onDelivered(context, profileId, messageId, partIndex, partTotal)
            }
            else -> return
        }

        if (report == null) return

        SmsGatewayService.noteReported(report.profileId, report.messageId)
        // Envoi "normal" (onglet Messages) : l'historique vit dans le fournisseur
        // SMS du téléphone, pas dans le journal passerelle, et ne doit jamais
        // être remonté à l'API comme un envoi de la passerelle.
        if (report.profileId == Config.LOCAL_PROFILE_ID) {
            MessageStore.markSendResult(context, messageId, report.status == "delivered" || report.status == "sent")
            return
        }
        SmsLog.add(
            context,
            SmsLog.Entry(
                System.currentTimeMillis(),
                SmsLog.TYPE_STATUT,
                report.messageId,
                intent.getStringExtra(Config.EXTRA_RECIPIENT).orEmpty(),
                "",
                report.status,
                report.error
            )
        )
        if (report.messageId.startsWith("test-")) return
        ReportQueue.add(report)
        SmsGatewayService.requestFlush(context)
    }
}
