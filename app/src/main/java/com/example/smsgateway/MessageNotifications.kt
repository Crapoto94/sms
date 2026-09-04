package com.example.smsgateway

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Notification "nouveau message" pour l'onglet Messages (SMS normaux), sur un
 * canal distinct et audible, séparé du canal silencieux du service passerelle
 * (SmsGatewayService.NOTIFICATION_CHANNEL_ID, IMPORTANCE_MIN).
 */
object MessageNotifications {

    private const val CHANNEL_ID = "sms_messages"
    private var channelCreated = false

    private fun ensureChannel(context: Context) {
        if (channelCreated) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.messages_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = context.getString(R.string.messages_channel_description)
        }
        manager.createNotificationChannel(channel)
        channelCreated = true
    }

    fun notifyIncoming(context: Context, threadId: Long, sender: String, body: String) {
        ensureChannel(context)
        if (ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.POST_NOTIFICATIONS
            ) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ) {
            return
        }
        val displayName = ContactLookup.displayNameFor(context, sender) ?: sender
        val openIntent = Intent(context, ConversationActivity::class.java)
            .putExtra(ConversationActivity.EXTRA_THREAD_ID, threadId)
            .putExtra(ConversationActivity.EXTRA_ADDRESS, sender)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingIntent = PendingIntent.getActivity(
            context, threadId.toInt(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sms)
            .setContentTitle(displayName)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(threadId.toInt(), notification)
        } catch (_: SecurityException) {
            // permission refusée entre-temps : pas de notification, pas de crash
        }
    }
}
