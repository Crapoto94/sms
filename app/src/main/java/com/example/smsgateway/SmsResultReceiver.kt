package com.example.smsgateway

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Reçoit les confirmations de l'envoi (SMS_SENT) et de la remise (SMS_DELIVERED)
 * puis renvoie le statut à l'API. Si l'envoi du statut échoue, il est mis en
 * file et le service le retransmettra au prochain cycle.
 */
class SmsResultReceiver : BroadcastReceiver() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onReceive(context: Context, intent: Intent) {
        val messageId = intent.getStringExtra(Config.EXTRA_MESSAGE_ID) ?: return

        val status: String
        val error: String?
        when (intent.action) {
            Config.SMS_SENT_ACTION -> {
                when (resultCode) {
                    Activity.RESULT_OK -> { status = "SENT"; error = null }
                    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> { status = "FAILED"; error = "Erreur générique" }
                    SmsManager.RESULT_ERROR_NO_SERVICE -> { status = "FAILED"; error = "Pas de service réseau" }
                    SmsManager.RESULT_ERROR_NULL_PDU -> { status = "FAILED"; error = "PDU nul" }
                    SmsManager.RESULT_ERROR_RADIO_OFF -> { status = "FAILED"; error = "Radio éteinte" }
                    else -> { status = "FAILED"; error = "Erreur $resultCode" }
                }
            }
            Config.SMS_DELIVERED_ACTION -> {
                if (resultCode != Activity.RESULT_OK) return
                status = "DELIVERED"
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
        scope.launch {
            val ok = ApiClient(context).reportStatus(messageId, status, error)
            if (!ok) {
                ReportQueue.add(StatusReport(messageId, status, error, System.currentTimeMillis()))
                SmsGatewayService.requestFlush(context)
            }
        }
    }
}
