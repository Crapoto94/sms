package com.example.smsgateway

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * Agrège les confirmations d'envoi / remise des messages multipart
 * (plusieurs segments). Un rapport n'est émis que lorsque TOUS les segments
 * ont répondu. L'état est persisté en SharedPreferences car chaque broadcast
 * arrive dans une instance distincte du récepteur.
 */
object MultipartTracker {

    private const val PREFS = "multipart_state"

    private class State {
        var sentOk: Int = 0
        var sentFail: Int = 0
        var sentTotal: Int = 0
        var deliveredOk: Int = 0
        var deliveredTotal: Int = 0
        var firstError: String? = null
        var sentDone: Boolean = false
        var deliveredDone: Boolean = false

        fun toJson(): String = JSONObject().apply {
            put("sentOk", sentOk)
            put("sentFail", sentFail)
            put("sentTotal", sentTotal)
            put("deliveredOk", deliveredOk)
            put("deliveredTotal", deliveredTotal)
            put("firstError", firstError)
            put("sentDone", sentDone)
            put("deliveredDone", deliveredDone)
        }.toString()

        companion object {
            fun fromJson(json: String): State {
                val o = JSONObject(json)
                return State().apply {
                    sentOk = o.optInt("sentOk")
                    sentFail = o.optInt("sentFail")
                    sentTotal = o.optInt("sentTotal")
                    deliveredOk = o.optInt("deliveredOk")
                    deliveredTotal = o.optInt("deliveredTotal")
                    firstError = o.optString("firstError").takeIf { it.isNotEmpty() }
                    sentDone = o.optBoolean("sentDone")
                    deliveredDone = o.optBoolean("deliveredDone")
                }
            }
        }
    }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun read(context: Context, id: String): State =
        prefs(context).getString("msg:$id", null)?.let {
            try {
                State.fromJson(it)
            } catch (_: Exception) {
                State()
            }
        } ?: State()

    private fun write(context: Context, id: String, s: State) {
        val editor = prefs(context).edit()
        if (s.sentDone && (s.sentFail > 0 || s.deliveredDone)) {
            editor.remove("msg:$id")
        } else {
            editor.putString("msg:$id", s.toJson())
        }
        editor.apply()
    }

    /**
     * Confirmation d'envoi d'un segment. Renvoie le rapport final (sent / failed)
     * lorsque tous les segments ont répondu, sinon null.
     */
    fun onSent(
        context: Context,
        id: String,
        partIndex: Int,
        partTotal: Int,
        ok: Boolean,
        error: String?
    ): StatusReport? {
        val s = read(context, id)
        if (s.sentTotal == 0) s.sentTotal = partTotal
        if (ok) {
            s.sentOk++
        } else {
            s.sentFail++
            if (s.firstError == null) s.firstError = error
        }
        if (s.sentOk + s.sentFail < s.sentTotal) {
            write(context, id, s)
            return null
        }
        s.sentDone = true
        val report = if (s.sentFail > 0) {
            StatusReport(id, "failed", s.firstError, System.currentTimeMillis())
        } else {
            StatusReport(id, "sent", null, System.currentTimeMillis())
        }
        write(context, id, s)
        return report
    }

    /**
     * Confirmation de remise d'un segment. Renvoie "delivered" lorsque tous les
     * segments sont remis, sinon null (ou null si l'envoi a déjà échoué).
     */
    fun onDelivered(context: Context, id: String, partIndex: Int, partTotal: Int): StatusReport? {
        val s = read(context, id)
        if (s.sentTotal == 0 || s.sentFail > 0) return null
        if (s.deliveredTotal == 0) s.deliveredTotal = partTotal
        s.deliveredOk++
        if (s.deliveredOk < s.deliveredTotal) {
            write(context, id, s)
            return null
        }
        s.deliveredDone = true
        val report = StatusReport(id, "delivered", null, System.currentTimeMillis())
        write(context, id, s)
        return report
    }
}
