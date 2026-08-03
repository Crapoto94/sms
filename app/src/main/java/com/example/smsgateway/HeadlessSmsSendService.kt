package com.example.smsgateway

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Service "HeadlessSmsSend" requis par Android pour être éligible comme
 * application SMS par défaut (rôle android.app.role.SMS). Redirige vers l'écran principal.
 */
class HeadlessSmsSendService : Service() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
