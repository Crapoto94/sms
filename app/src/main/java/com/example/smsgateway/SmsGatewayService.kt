package com.example.smsgateway

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.example.smsgateway.SmsSender.isDefaultSmsApp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Service en avant-plan : toutes les [Config.getPollingIntervalMs],
 * 1. retransmet les statuts en attente,
 * 2. vérifie que les SMS envoyés ont bien été confirmés (timeout),
 * 3. interroge l'API pour les nouveaux SMS à envoyer et les envoie.
 */
class SmsGatewayService : Service() {

    private lateinit var worker: HandlerThread
    private lateinit var handler: Handler
    private val api by lazy { ApiClient(this) }

    @Volatile private var lastPollTime: Long? = null
    @Volatile private var lastError: String? = null
    @Volatile private var sentCount = 0

    private val pollRunnable = object : Runnable {
        override fun run() {
            runCatching { processCycle() }
                .onFailure { Log.w(TAG, "cycle error", it) }
            handler.postDelayed(this, Config.getPollingIntervalMs(this@SmsGatewayService))
        }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createNotificationChannel()
        worker = HandlerThread("SmsGatewayWorker").also { it.start() }
        handler = Handler(worker.looper)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_FLUSH -> {
                handler.removeCallbacks(pollRunnable)
                handler.post { runCatching { processCycle() } }
                handler.postDelayed(pollRunnable, Config.getPollingIntervalMs(this))
            }
            else -> {
                handler.removeCallbacks(pollRunnable)
                handler.post(pollRunnable)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        handler.removeCallbacksAndMessages(null)
        worker.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun processCycle() {
        flushReports()
        sweepTimeouts()

        val smsGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) ==
            PackageManager.PERMISSION_GRANTED
        if (!smsGranted) {
            lastError = "Permission SMS non accordée"
            SmsLog.add(this, SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, "", "", "", null, "Permission SMS non accordée"))
            updateNotification()
            return
        }

        val pending = try {
            api.fetchPendingMessages()
        } catch (e: Exception) {
            lastError = "API injoignable : ${e.message}"
            SmsLog.add(this, SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, "", "", "", null, "API injoignable : ${e.message}"))
            updateNotification()
            return
        }

        lastPollTime = System.currentTimeMillis()
        lastError = null

        if (!isDefaultSmsApp(this)) {
            lastError = "App SMS par défaut requise"
        }

        for (message in pending) {
            if (isDefaultSmsApp(this)) {
                try {
                    SmsSender.send(this, message)
                    noteSent(message.id)
                    sentCount++
                    SmsLog.add(
                        this,
                        SmsLog.Entry(now(), SmsLog.TYPE_ENVOI, message.id, message.recipient, message.body, null, null)
                    )
                } catch (e: Exception) {
                    ReportQueue.add(StatusReport(message.id, "FAILED", e.message, System.currentTimeMillis()))
                    SmsLog.add(
                        this,
                        SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, message.id, message.recipient, message.body, "FAILED", e.message)
                    )
                }
            } else {
                ReportQueue.add(StatusReport(message.id, "FAILED", "App SMS par défaut requise", System.currentTimeMillis()))
                SmsLog.add(
                    this,
                    SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, message.id, message.recipient, message.body, "FAILED", "App SMS par défaut requise")
                )
            }
        }
        updateNotification()
    }

    private fun flushReports() {
        for (report in ReportQueue.all()) {
            if (api.reportStatus(report.messageId, report.status, report.error)) {
                ReportQueue.remove(report.messageId)
                noteReported(report.messageId)
            }
        }
    }

    private fun sweepTimeouts() {
        val now = System.currentTimeMillis()
        val expired = sentAt.filterValues { now - it > Config.RESULT_TIMEOUT_MS }.keys
        for (messageId in expired) {
            sentAt.remove(messageId)
            ReportQueue.add(StatusReport(messageId, "FAILED", "Aucune confirmation (timeout)", now))
            SmsLog.add(
                this,
                SmsLog.Entry(now, SmsLog.TYPE_ERREUR, messageId, "", "", "FAILED", "Aucune confirmation (timeout)")
            )
        }
    }

    private fun now(): Long = System.currentTimeMillis()

    private fun startAsForeground() {
        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun updateNotification() {
        NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val lastInfo = when {
            lastError != null -> "Erreur : $lastError"
            lastPollTime != null -> {
                val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(lastPollTime!!))
                "Dernière vérification $time • $sentCount SMS envoyés"
            }
            else -> "En attente de la première vérification…"
        }
        val contentIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sms)
            .setContentTitle(getString(R.string.channel_name))
            .setContentText(lastInfo)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.deleteNotificationChannel(NOTIFICATION_CHANNEL_ID)
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            getString(R.string.channel_name),
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = getString(R.string.channel_description)
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "SmsGatewayService"
        const val ACTION_STOP = "com.example.smsgateway.ACTION_STOP"
        const val ACTION_FLUSH = "com.example.smsgateway.ACTION_FLUSH"
        const val NOTIFICATION_CHANNEL_ID = "sms_gateway_min"
        const val NOTIFICATION_ID = 1

        @Volatile
        var isRunning = false
            private set

        private val sentAt = ConcurrentHashMap<String, Long>()

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, SmsGatewayService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, SmsGatewayService::class.java).setAction(ACTION_STOP))
        }

        fun requestFlush(context: Context) {
            try {
                context.startService(Intent(context, SmsGatewayService::class.java).setAction(ACTION_FLUSH))
            } catch (_: Exception) {
            }
        }

        fun noteSent(messageId: String) {
            sentAt[messageId] = System.currentTimeMillis()
        }

        fun noteReported(messageId: String) {
            sentAt.remove(messageId)
        }
    }
}
