package com.example.smsgateway

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Service "HeadlessSmsSend" requis par Android pour être éligible comme
 * application SMS par défaut (rôle android.app.role.SMS). Reçoit les
 * réponses rapides (ex : depuis une notification système "répondre") sans
 * ouvrir d'écran : le destinataire est dans l'URI (smsto:<numéro>) et le
 * texte dans EXTRA_TEXT. Si l'un des deux manque, on retombe sur
 * l'ouverture de l'écran principal (cas générique).
 */
class HeadlessSmsSendService : Service() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val address = intent?.data?.schemeSpecificPart?.trim().orEmpty()
        val body = intent?.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        runCatching {
            if (address.isNotEmpty() && body.isNotEmpty()) {
                MessageStore.sendMessage(this, address, body)
            } else {
                startActivity(
                    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
