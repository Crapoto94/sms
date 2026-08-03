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
 *  - GET  /v1/messages?deviceId=<id>            -> { "messages": [ { "id", "recipient", "body" } ] }
 *  - POST /v1/messages/{messageId}/status        -> body { "deviceId", "messageId", "status", "error", "reportedAt" }
 *        status ∈ { SENT, DELIVERED, FAILED }
 */
class ApiClient(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(Config.REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(Config.REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .writeTimeout(Config.REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    /** Lève une [ApiException] en cas d'échec réseau ou HTTP. */
    fun fetchPendingMessages(): List<OutgoingMessage> {
        val url = "${Config.getBaseUrl(context)}/v1/messages?deviceId=${Config.getDeviceId(context)}"
        val request = Request.Builder().url(url).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw ApiException("HTTP ${response.code}")
            val body = response.body?.string().orEmpty()
            val array = try {
                JSONObject(body).getJSONArray("messages")
            } catch (_: Exception) {
                JSONArray(body)
            }
            val messages = mutableListOf<OutgoingMessage>()
            for (i in 0 until array.length()) {
                messages.add(OutgoingMessage.fromJson(array.getJSONObject(i)))
            }
            return messages
        }
    }

    /** Renvoie true si le statut a bien été enregistré par l'API. */
    fun reportStatus(messageId: String, status: String, error: String?): Boolean {
        return try {
            val url = "${Config.getBaseUrl(context)}/v1/messages/$messageId/status"
            val payload = JSONObject().apply {
                put("deviceId", Config.getDeviceId(context))
                put("messageId", messageId)
                put("status", status)
                error?.let { put("error", it) }
                put("reportedAt", System.currentTimeMillis())
            }
            val body = payload.toString().toRequestBody(JSON_MEDIA_TYPE)
            val request = Request.Builder().url(url).post(body).build()
            client.newCall(request).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}

class ApiException(message: String) : Exception(message)
