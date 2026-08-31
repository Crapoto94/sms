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

    private fun read(context: Context, profileId: String, id: String): State =
        prefs(context).getString("msg:$profileId:$id", null)?.let {
            try {
                State.fromJson(it)
            } catch (_: Exception) {
                State()
            }
        } ?: State()

    private fun write(context: Context, profileId: String, id: String, s: State) {
        val editor = prefs(context).edit()
        if (s.sentDone && (s.sentFail > 0 || s.deliveredDone)) {
            editor.remove("msg:$profileId:$id")
        } else {
            editor.putString("msg:$profileId:$id", s.toJson())
        }
        editor.apply()
    }

    /**
     * Confirmation d'envoi d'un segment. Renvoie le rapport final (sent / failed)
     * lorsque tous les segments ont répondu, sinon null.
     */
    fun onSent(
        context: Context,
        profileId: String,
        id: String,
        partIndex: Int,
        partTotal: Int,
        ok: Boolean,
        error: String?
    ): StatusReport? {
        val s = read(context, profileId, id)
        if (s.sentTotal == 0) s.sentTotal = partTotal
        if (ok) {
            s.sentOk++
        } else {
            s.sentFail++
            if (s.firstError == null) s.firstError = error
        }
        if (s.sentOk + s.sentFail < s.sentTotal) {
            write(context, profileId, id, s)
            return null
        }
        s.sentDone = true
        val report = if (s.sentFail > 0) {
            StatusReport(profileId, id, "failed", s.firstError, System.currentTimeMillis())
        } else {
            StatusReport(profileId, id, "sent", null, System.currentTimeMillis())
        }
        write(context, profileId, id, s)
        return report
    }

    /**
     * Confirmation de remise d'un segment. Un seul segment livré suffit à
     * considérer le SMS entier comme "remis" : de nombreux opérateurs ne
     * renvoient qu'un seul accusé de remise pour tout un message concaténé
     * (pas un par segment), donc exiger la remise de TOUS les segments
     * laissait des messages réellement livrés bloqués indéfiniment sur
     * "envoyé". Les accusés suivants pour les autres segments du même
     * message sont ignorés (déjà remonté).
     */
    fun onDelivered(context: Context, profileId: String, id: String, partIndex: Int, partTotal: Int): StatusReport? {
        val s = read(context, profileId, id)
        if (s.sentTotal == 0 || s.sentFail > 0 || s.deliveredDone) return null
        s.deliveredOk++
        s.deliveredDone = true
        val report = StatusReport(profileId, id, "delivered", null, System.currentTimeMillis())
        write(context, profileId, id, s)
        return report
    }
}
