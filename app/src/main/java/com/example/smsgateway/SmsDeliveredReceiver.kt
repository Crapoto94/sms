package com.example.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Déclaré pour être éligible comme application SMS par défaut (Android 4.4+).
 * L'application n'affiche pas les SMS reçus, elle ne fait que les recevoir.
 */
class SmsDeliveredReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Unit
}
