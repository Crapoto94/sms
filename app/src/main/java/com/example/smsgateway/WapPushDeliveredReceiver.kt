package com.example.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Déclaré pour être éligible comme application SMS par défaut (Android 4.4+).
 */
class WapPushDeliveredReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Unit
}
