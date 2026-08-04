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
import android.os.PowerManager
import android.net.Uri
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
 * 1. synchronise avec l'API (rapports de statut + récupération des messages à envoyer),
 * 2. envoie les SMS demandés.
 */
class SmsGatewayService : Service() {

    private lateinit var worker: HandlerThread
    private lateinit var handler: Handler
    private val api by lazy { ApiClient(this) }
    private lateinit var wakeLock: PowerManager.WakeLock

    @Volatile private var lastPollTime: Long? = null
    @Volatile private var lastError: String? = null
    @Volatile private var sentCount = 0

    private val sendQueue = java.util.ArrayDeque<OutgoingMessage>()
    private var batchIntervalMs = BATCH_INTERVAL_SLOW_MS
    private var pollIntervalMs = Config.DEFAULT_POLLING_INTERVAL_MS

    private val cycleRunnable = object : Runnable {
        override fun run() {
            try {
                tick()
            } catch (t: Throwable) {
                // Une exception ne doit JAMAIS arrêter la boucle : on la journalise
                // et on replanifie le cycle suivant, sinon la passerelle se
                // déconnecte silencieusement jusqu'à un redémarrage manuel.
                Log.w(TAG, "cycle error", t)
                handler.postDelayed(this, pollIntervalMs)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createNotificationChannel()
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SmsGateway:cpu")
        wakeLock.setReferenceCounted(false)
        wakeLock.acquire()
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
                handler.removeCallbacks(cycleRunnable)
                handler.post(cycleRunnable)
            }
            else -> {
                handler.removeCallbacks(cycleRunnable)
                handler.post(cycleRunnable)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        handler.removeCallbacksAndMessages(null)
        worker.quitSafely()
        if (this::wakeLock.isInitialized && wakeLock.isHeld) {
            wakeLock.release()
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun tick() {
        val next = sendQueue.pollFirst()
        if (next != null) {
            sendMessage(next)
            updateNotification()
            handler.postDelayed(cycleRunnable, batchIntervalMs)
            return
        }

        val messages = syncAndFetchMessages()
        if (messages == null) {
            updateNotification()
            handler.postDelayed(cycleRunnable, pollIntervalMs)
            return
        }

        if (messages.isEmpty()) {
            updateNotification()
            handler.postDelayed(cycleRunnable, pollIntervalMs)
            return
        }

        if (!isDefaultSmsApp(this)) {
            lastError = "App SMS par défaut requise"
            failAll(messages, "App SMS par défaut requise")
            updateNotification()
            handler.postDelayed(cycleRunnable, pollIntervalMs)
            return
        }

        batchIntervalMs =
            if (messages.size < BATCH_SLOW_THRESHOLD) BATCH_INTERVAL_SLOW_MS else BATCH_INTERVAL_FAST_MS
        sendQueue.addAll(messages)
        handler.post(cycleRunnable)
    }

    private fun syncAndFetchMessages(): List<OutgoingMessage>? {
        sweepTimeouts()

        val apiKey = Config.getGatewayApiKey(this)
        if (apiKey.isBlank()) {
            lastError = "Clé API non configurée"
            SmsLog.add(this, SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, "", "", "", null, "Clé API non configurée"))
            return null
        }

        val smsGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) ==
            PackageManager.PERMISSION_GRANTED
        if (!smsGranted) {
            lastError = "Permission SMS non accordée"
            SmsLog.add(this, SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, "", "", "", null, "Permission SMS non accordée"))
            return null
        }

        val reports = ReportQueue.all()
        val result = try {
            api.sync(reports)
        } catch (e: Exception) {
            lastError = "API injoignable : ${e.message}"
            SmsLog.add(this, SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, "", "", "", null, "API injoignable : ${e.message}"))
            return null
        }

        if (reports.isNotEmpty()) {
            ReportQueue.clearAll(reports)
            for (r in reports) noteReported(r.messageId)
        }

        lastPollTime = System.currentTimeMillis()
        lastError = null
        Config.setLastSyncAt(this, lastPollTime)
        pollIntervalMs = result.intervalMs

        reportIncomingMessages()

        return result.messages
    }

    /**
     * Lit les SMS reçus depuis le dernier traitement et les remonte à l'API.
     * L'index lu n'est avancé qu'après acceptation par le serveur (dédoublonnage
     * côté serveur via device_id + provider_id).
     */
    private fun reportIncomingMessages() {
        val messages = collectIncomingMessages()
        if (messages.isEmpty()) return
        try {
            if (api.sendIncoming(messages)) {
                Config.setLastIncomingSmsId(this, messages.maxOf { it.id })
                SmsLog.add(
                    this,
                    SmsLog.Entry(now(), SmsLog.TYPE_STATUT, "", "", "", null, "${messages.size} SMS reçus remontés à l'API")
                )
            }
        } catch (e: Exception) {
            SmsLog.add(
                this,
                SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, "", "", "", null, "Remontée des SMS reçus impossible : ${e.message}")
            )
        }
    }

    private fun collectIncomingMessages(): List<IncomingSms> {
        val out = mutableListOf<IncomingSms>()
        try {
            val lastId = Config.getLastIncomingSmsId(this)
            val uri = Uri.parse("content://sms/inbox")
            contentResolver.query(
                uri, null, "_id > ?", arrayOf(lastId.toString()), "_id ASC"
            )?.use { c ->
                val idCol = c.getColumnIndex("_id")
                val addrCol = c.getColumnIndex("address")
                val bodyCol = c.getColumnIndex("body")
                val dateCol = c.getColumnIndex("date")
                while (c.moveToNext()) {
                    val id = if (idCol >= 0) c.getLong(idCol) else 0L
                    val sender = if (addrCol >= 0) c.getString(addrCol) ?: "" else ""
                    val body = if (bodyCol >= 0) c.getString(bodyCol) ?: "" else ""
                    val date = if (dateCol >= 0) c.getLong(dateCol) else System.currentTimeMillis()
                    if (id > 0 && body.isNotBlank()) {
                        out.add(IncomingSms(id, sender.trim(), body, date))
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "lecture des SMS reçus impossible", e)
        }
        return out
    }

    private fun sendMessage(message: OutgoingMessage) {
        try {
            SmsSender.send(this, message)
            noteSent(message.id)
            sentCount++
            SmsLog.add(
                this,
                SmsLog.Entry(now(), SmsLog.TYPE_ENVOI, message.id, message.recipient, message.body, null, null)
            )
        } catch (e: Exception) {
            ReportQueue.add(StatusReport(message.id, "failed", e.message, System.currentTimeMillis()))
            SmsLog.add(
                this,
                SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, message.id, message.recipient, message.body, "failed", e.message)
            )
        }
    }

    private fun failAll(messages: List<OutgoingMessage>, reason: String) {
        for (message in messages) {
            ReportQueue.add(StatusReport(message.id, "failed", reason, System.currentTimeMillis()))
            SmsLog.add(
                this,
                SmsLog.Entry(now(), SmsLog.TYPE_ERREUR, message.id, message.recipient, message.body, "failed", reason)
            )
        }
    }

    private fun sweepTimeouts() {
        val now = System.currentTimeMillis()
        val expired = sentAt.filterValues { now - it > Config.RESULT_TIMEOUT_MS }.keys
        for (messageId in expired) {
            sentAt.remove(messageId)
            ReportQueue.add(StatusReport(messageId, "failed", "Aucune confirmation (timeout)", now))
            SmsLog.add(
                this,
                SmsLog.Entry(now, SmsLog.TYPE_ERREUR, messageId, "", "", "failed", "Aucune confirmation (timeout)")
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
        val lastSync = Config.getLastSyncAt(this)
        val lastInfo = when {
            lastError != null -> "Erreur : $lastError"
            lastSync > 0 -> {
                val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(lastSync))
                "Dernière connexion API $time • $sentCount SMS envoyés"
            }
            else -> "En attente de la première connexion…"
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

        const val BATCH_INTERVAL_FAST_MS = 5_000L
        const val BATCH_INTERVAL_SLOW_MS = 10_000L
        const val BATCH_SLOW_THRESHOLD = 10

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
