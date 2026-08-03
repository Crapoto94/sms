package com.example.smsgateway

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Journal des SMS : conserve en mémoire et en mémoire persistante les
 * envois et leurs statuts pour affichage dans [MainActivity].
 */
object SmsLog {

    private const val MAX_ENTRIES = 200
    private const val PREFS_NAME = "sms_log"
    private const val KEY_ENTRIES = "entries"

    const val TYPE_ENVOI = "Envoi"
    const val TYPE_STATUT = "Statut"
    const val TYPE_ERREUR = "Erreur"
    const val TYPE_TEST = "Test"

    data class Entry(
        val timestamp: Long,
        val type: String,
        val messageId: String,
        val recipient: String,
        val body: String,
        val status: String?,
        val detail: String?
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("timestamp", timestamp)
            put("type", type)
            put("messageId", messageId)
            put("recipient", recipient)
            put("body", body)
            put("status", status)
            put("detail", detail)
        }

        companion object {
            fun fromJson(json: JSONObject): Entry = Entry(
                timestamp = json.optLong("timestamp"),
                type = json.optString("type"),
                messageId = json.optString("messageId"),
                recipient = json.optString("recipient"),
                body = json.optString("body"),
                status = json.optString("status").ifEmpty { null },
                detail = json.optString("detail").ifEmpty { null }
            )
        }
    }

    private val entries = ArrayDeque<Entry>()

    fun add(context: Context, entry: Entry) {
        synchronized(this) {
            entries.addFirst(entry)
            while (entries.size > MAX_ENTRIES) entries.removeLast()
            persistLocked(context)
        }
    }

    fun all(): List<Entry> = synchronized(this) { entries.toList() }

    fun clear(context: Context) {
        synchronized(this) {
            entries.clear()
            persistLocked(context)
        }
    }

    fun load(context: Context) {
        synchronized(this) {
            entries.clear()
            val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_ENTRIES, null) ?: return
            try {
                val array = JSONArray(raw)
                for (i in 0 until array.length()) {
                    entries.addLast(Entry.fromJson(array.getJSONObject(i)))
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun persistLocked(context: Context) {
        val array = JSONArray()
        for (e in entries) array.put(e.toJson())
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_ENTRIES, array.toString()).apply()
    }

    fun formatTime(timestamp: Long): String =
        SimpleDateFormat("dd/MM HH:mm:ss", Locale.getDefault()).format(Date(timestamp))
}
