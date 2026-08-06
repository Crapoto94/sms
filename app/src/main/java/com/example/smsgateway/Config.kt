package com.example.smsgateway

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

object Config {

    const val DEFAULT_BASE_URL = "https://api.exemple.com"
    const val DEFAULT_POLLING_INTERVAL_MS = 60_000L
    const val MIN_POLLING_INTERVAL_MS = 5_000L
    const val REQUEST_TIMEOUT_MS = 30_000L
    const val RESULT_TIMEOUT_MS = 300_000L

    const val SMS_SENT_ACTION = "com.example.smsgateway.SMS_SENT"
    const val SMS_DELIVERED_ACTION = "com.example.smsgateway.SMS_DELIVERED"

    const val EXTRA_MESSAGE_ID = "message_id"
    const val EXTRA_PROFILE_ID = "profile_id"
    const val EXTRA_RECIPIENT = "recipient"
    const val EXTRA_PART_INDEX = "part_index"
    const val EXTRA_PART_TOTAL = "part_total"

    fun getDeviceId(context: Context): String {
        val prefs = prefs(context)
        prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, id).apply()
        return id
    }

    fun getBaseUrl(context: Context): String = getApiProfiles(context).firstOrNull()?.url ?: DEFAULT_BASE_URL

    fun setBaseUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_BASE_URL, url.trimEnd('/')).apply()
    }

    fun getGatewayApiKey(context: Context): String =
        prefs(context).getString(KEY_API_KEY, "") ?: ""

    fun setGatewayApiKey(context: Context, key: String) {
        prefs(context).edit().putString(KEY_API_KEY, key.trim()).apply()
    }

    fun getApiProfiles(context: Context): List<ApiProfile> {
        val raw = prefs(context).getString(KEY_API_PROFILES, null)
        if (!raw.isNullOrBlank()) {
            return try {
                val array = JSONArray(raw)
                (0 until array.length()).mapNotNull { i ->
                    val item = array.optJSONObject(i) ?: return@mapNotNull null
                    ApiProfile(
                        item.optString("id").ifBlank { UUID.randomUUID().toString() },
                        item.optString("label").ifBlank { "API ${i + 1}" },
                        item.optString("url").trimEnd('/'),
                        item.optString("key").trim(),
                        item.optBoolean("enabled", true)
                    )
                }.filter { it.url.isNotBlank() && it.key.isNotBlank() }
            } catch (_: Exception) { emptyList() }
        }
        val url = prefs(context).getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
        val key = prefs(context).getString(KEY_API_KEY, "") ?: ""
        return if (url.isNotBlank() && key.isNotBlank()) listOf(ApiProfile("default", "API principale", url, key)) else emptyList()
    }

    fun setApiProfiles(context: Context, profiles: List<ApiProfile>) {
        val array = JSONArray()
        profiles.forEach { profile ->
            array.put(JSONObject().apply {
                put("id", profile.id)
                put("label", profile.label)
                put("url", profile.url.trimEnd('/'))
                put("key", profile.key.trim())
                put("enabled", profile.enabled)
            })
        }
        prefs(context).edit()
            .putString(KEY_API_PROFILES, array.toString())
            .putString(KEY_BASE_URL, profiles.firstOrNull()?.url ?: "")
            .putString(KEY_API_KEY, profiles.firstOrNull()?.key ?: "")
            .apply()
    }

    fun getPollingIntervalMs(context: Context): Long =
        prefs(context).getLong(KEY_POLLING_INTERVAL_MS, DEFAULT_POLLING_INTERVAL_MS)

    fun setPollingIntervalMs(context: Context, ms: Long) {
        prefs(context).edit()
            .putLong(KEY_POLLING_INTERVAL_MS, ms.coerceAtLeast(MIN_POLLING_INTERVAL_MS))
            .apply()
    }

    /** Dernière synchronisation réussie avec l'API (epoch ms). */
    fun getLastSyncAt(context: Context): Long =
        prefs(context).getLong(KEY_LAST_SYNC_AT, 0L)

    fun setLastSyncAt(context: Context, ms: Long) {
        prefs(context).edit().putLong(KEY_LAST_SYNC_AT, ms).apply()
    }

    /** Dernier _id de SMS reçu traité (dédoublonnage de la remontée à l'API). */
    fun getLastIncomingSmsId(context: Context): Long =
        prefs(context).getLong(KEY_LAST_INCOMING_SMS_ID, 0L)

    fun setLastIncomingSmsId(context: Context, id: Long) {
        prefs(context).edit().putLong(KEY_LAST_INCOMING_SMS_ID, id).apply()
    }

    fun getLastIncomingSms(context: Context): IncomingSmsDisplay? {
        val timestamp = prefs(context).getLong(KEY_LAST_INCOMING_AT, 0L)
        if (timestamp <= 0L) return null
        return IncomingSmsDisplay(
            timestamp,
            prefs(context).getString(KEY_LAST_INCOMING_SENDER, "") ?: "",
            prefs(context).getString(KEY_LAST_INCOMING_BODY, "") ?: ""
        )
    }

    fun setLastIncomingSms(context: Context, sms: IncomingSms) {
        prefs(context).edit()
            .putLong(KEY_LAST_INCOMING_AT, sms.date)
            .putString(KEY_LAST_INCOMING_SENDER, sms.sender)
            .putString(KEY_LAST_INCOMING_BODY, sms.body)
            .apply()
    }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences("sms_gateway", Context.MODE_PRIVATE)

    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_API_KEY = "api_key"
    private const val KEY_API_PROFILES = "api_profiles"
    private const val KEY_POLLING_INTERVAL_MS = "polling_interval_ms"
    private const val KEY_LAST_SYNC_AT = "last_sync_at"
    private const val KEY_LAST_INCOMING_SMS_ID = "last_incoming_sms_id"
    private const val KEY_LAST_INCOMING_AT = "last_incoming_at"
    private const val KEY_LAST_INCOMING_SENDER = "last_incoming_sender"
    private const val KEY_LAST_INCOMING_BODY = "last_incoming_body"
}

data class ApiProfile(
    val id: String,
    val label: String,
    val url: String,
    val key: String,
    val enabled: Boolean = true
)

data class IncomingSmsDisplay(
    val timestamp: Long,
    val sender: String,
    val body: String
)
