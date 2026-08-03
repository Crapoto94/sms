package com.example.smsgateway

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

object Config {

    const val DEFAULT_BASE_URL = "https://api.exemple.com"
    const val DEFAULT_POLLING_INTERVAL_MS = 60_000L
    const val MIN_POLLING_INTERVAL_MS = 5_000L
    const val REQUEST_TIMEOUT_MS = 30_000L
    const val RESULT_TIMEOUT_MS = 300_000L

    const val SMS_SENT_ACTION = "com.example.smsgateway.SMS_SENT"
    const val SMS_DELIVERED_ACTION = "com.example.smsgateway.SMS_DELIVERED"

    const val EXTRA_MESSAGE_ID = "message_id"
    const val EXTRA_RECIPIENT = "recipient"

    fun getDeviceId(context: Context): String {
        val prefs = prefs(context)
        prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, id).apply()
        return id
    }

    fun getBaseUrl(context: Context): String =
        prefs(context).getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

    fun setBaseUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_BASE_URL, url.trimEnd('/')).apply()
    }

    fun getGatewayApiKey(context: Context): String =
        prefs(context).getString(KEY_API_KEY, "") ?: ""

    fun setGatewayApiKey(context: Context, key: String) {
        prefs(context).edit().putString(KEY_API_KEY, key.trim()).apply()
    }

    fun getPollingIntervalMs(context: Context): Long =
        prefs(context).getLong(KEY_POLLING_INTERVAL_MS, DEFAULT_POLLING_INTERVAL_MS)

    fun setPollingIntervalMs(context: Context, ms: Long) {
        prefs(context).edit()
            .putLong(KEY_POLLING_INTERVAL_MS, ms.coerceAtLeast(MIN_POLLING_INTERVAL_MS))
            .apply()
    }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences("sms_gateway", Context.MODE_PRIVATE)

    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_API_KEY = "api_key"
    private const val KEY_POLLING_INTERVAL_MS = "polling_interval_ms"
}
