package com.example.smsgateway

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Client HTTP vers l'API de la passerelle.
 *
 * Contrat REST :
 *  - POST /api/v1/gateway/sync   -> body { deviceId, reports: [ { id, status, error } ] }
 *        réponse : { messages: [ { id, recipient, body } ], intervalSec, ... }
 *  - Les messages renvoyés sont marqués "en cours d'envoi" côté serveur : une autre
 *    passerelle ne les recevra pas (sauf réclamation après timeout serveur).
 */
class ApiClient(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(Config.REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(Config.REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .writeTimeout(Config.REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    private val healthClient = OkHttpClient.Builder()
        .connectTimeout(10_000L, TimeUnit.MILLISECONDS)
        .readTimeout(10_000L, TimeUnit.MILLISECONDS)
        .build()

    /**
     * Vérifie que l'API est joignable (GET /health -> { ok: true }).
     * @return true si le serveur répond correctement.
     */
    fun checkHealth(profile: ApiProfile): Boolean {
        val request = Request.Builder()
            .url("${profile.url}/health")
            .get()
            .build()
        healthClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return false
            val body = response.body?.string().orEmpty()
            return try {
                JSONObject(body).optBoolean("ok", false)
            } catch (_: Exception) {
                false
            }
        }
    }

    /**
     * Synchronisation passerelle ↔ API.
     * 1. remonte les statuts (sent / delivered / failed) en attente,
     * 2. récupère les messages à envoyer.
     * @throws ApiException en cas d'échec réseau ou HTTP.
     */
    fun sync(profile: ApiProfile, reports: List<StatusReport>): SyncResult {
        val url = "${profile.url}/api/v1/gateway/sync"
        val reportsJson = JSONArray()
        for (r in reports) {
            reportsJson.put(JSONObject().apply {
                put("id", r.messageId)
                put("status", r.status)
                r.error?.let { put("error", it) }
                r.simSlot?.let { put("simSlot", it) }
                r.simNumber?.let { put("simNumber", it) }
            })
        }
        val payload = JSONObject().apply {
            put("deviceId", Config.getDeviceId(context))
            put("appVersion", BuildConfig.VERSION_NAME)
            put("simCount", SmsSender.activeSimCount(context))
            put("reports", reportsJson)
        }
        val body = payload.toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${profile.key}")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val detail = response.body?.string()?.take(200).orEmpty()
                throw ApiException("HTTP ${response.code}: $detail")
            }
            val json = JSONObject(response.body?.string().orEmpty())
            val messages = mutableListOf<OutgoingMessage>()
            val array = json.optJSONArray("messages") ?: JSONArray()
            for (i in 0 until array.length()) {
                messages.add(OutgoingMessage.fromJson(array.getJSONObject(i)).copy(profileId = profile.id))
            }
            val intervalSec = json.optLong("intervalSec", 60L)
            return SyncResult(
                messages = messages,
                intervalMs = (intervalSec * 1000).coerceAtLeast(Config.MIN_POLLING_INTERVAL_MS)
            )
        }
    }

    /**
     * Remonte les SMS reçus (lus dans la boîte de réception du téléphone).
     * @return true si le serveur a accepté la requête.
     */
    fun sendIncoming(profile: ApiProfile, messages: List<IncomingSms>): Boolean {
        val url = "${profile.url}/api/v1/gateway/incoming"
        val arr = JSONArray()
        for (m in messages) {
            arr.put(JSONObject().apply {
                put("providerId", m.id)
                put("sender", m.sender)
                put("body", m.body)
                put("receivedAt", m.date)
            })
        }
        val payload = JSONObject().apply {
            put("deviceId", Config.getDeviceId(context))
            put("messages", arr)
        }
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${profile.key}")
            .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val detail = response.body?.string()?.take(200).orEmpty()
                throw ApiException("HTTP ${response.code}: $detail")
            }
            return true
        }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}

data class SyncResult(
    val messages: List<OutgoingMessage>,
    val intervalMs: Long
)

data class IncomingSms(
    val id: Long,
    val sender: String,
    val body: String,
    val date: Long
)

class ApiException(message: String) : Exception(message)
