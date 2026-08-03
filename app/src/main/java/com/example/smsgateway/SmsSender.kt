package com.example.smsgateway

import android.app.PendingIntent
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SmsManager
import java.util.concurrent.atomic.AtomicInteger

object SmsSender {

    private const val REQUEST_CODE_SEED = 4242
    private val requestCounter = AtomicInteger(0)

    fun isDefaultSmsApp(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return context.getSystemService(RoleManager::class.java)
                .isRoleHeld(RoleManager.ROLE_SMS)
        }
        return Telephony.Sms.getDefaultSmsPackage(context) == context.packageName
    }

    /** Ouvre la page Paramètres > Applications par défaut, fiable sur toutes les marques. */
    fun manualDefaultSmsIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)

    /**
     * Envoie le SMS sans confirmation : le téléphone notifie ensuite via
     * [Config.SMS_SENT_ACTION] et [Config.SMS_DELIVERED_ACTION].
     * Au-delà de 160 caractères, le message est découpé en plusieurs segments
     * (multipart) ; les confirmations sont agrégées par [MultipartTracker].
     */
    fun send(context: Context, message: OutgoingMessage) {
        val smsManager = SmsManager.getDefault()
        val parts = smsManager.divideMessage(message.body)
        if (parts.size <= 1) {
            smsManager.sendTextMessage(
                message.recipient,
                null,
                message.body,
                createPendingIntent(context, message, Config.SMS_SENT_ACTION, 0, 1),
                createPendingIntent(context, message, Config.SMS_DELIVERED_ACTION, 0, 1)
            )
        } else {
            val sentIntents = ArrayList(parts.mapIndexed { i, _ ->
                createPendingIntent(context, message, Config.SMS_SENT_ACTION, i, parts.size)
            })
            val deliveredIntents = ArrayList(parts.mapIndexed { i, _ ->
                createPendingIntent(context, message, Config.SMS_DELIVERED_ACTION, i, parts.size)
            })
            smsManager.sendMultipartTextMessage(
                message.recipient,
                null,
                parts,
                sentIntents,
                deliveredIntents
            )
        }
    }

    private fun createPendingIntent(
        context: Context,
        message: OutgoingMessage,
        action: String,
        partIndex: Int,
        partTotal: Int
    ): PendingIntent {
        val intent = Intent(context, SmsResultReceiver::class.java).apply {
            setAction(action)
            putExtra(Config.EXTRA_MESSAGE_ID, message.id)
            putExtra(Config.EXTRA_RECIPIENT, message.recipient)
            putExtra(Config.EXTRA_PART_INDEX, partIndex)
            putExtra(Config.EXTRA_PART_TOTAL, partTotal)
        }
        val requestCode = REQUEST_CODE_SEED + requestCounter.incrementAndGet() + partIndex
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }
}
