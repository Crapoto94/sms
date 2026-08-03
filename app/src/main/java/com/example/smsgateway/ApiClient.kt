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

    /**
     * Synchronisation passerelle ↔ API.
     * 1. remonte les statuts (sent / delivered / failed) en attente,
     * 2. récupère les messages à envoyer.
     * @throws ApiException en cas d'échec réseau ou HTTP.
     */
    fun sync(reports: List<StatusReport>): SyncResult {
        val url = "${Config.getBaseUrl(context)}/api/v1/gateway/sync"
        val reportsJson = JSONArray()
        for (r in reports) {
            reportsJson.put(JSONObject().apply {
                put("id", r.messageId)
                put("status", r.status)
                r.error?.let { put("error", it) }
            })
        }
        val payload = JSONObject().apply {
            put("deviceId", Config.getDeviceId(context))
            put("reports", reportsJson)
        }
        val body = payload.toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${Config.getGatewayApiKey(context)}")
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
                messages.add(OutgoingMessage.fromJson(array.getJSONObject(i)))
            }
            val intervalSec = json.optLong("intervalSec", 60L)
            return SyncResult(
                messages = messages,
                intervalMs = (intervalSec * 1000).coerceAtLeast(Config.MIN_POLLING_INTERVAL_MS)
            )
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

class ApiException(message: String) : Exception(message)
