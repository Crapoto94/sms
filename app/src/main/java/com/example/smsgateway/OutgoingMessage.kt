package com.example.smsgateway

import org.json.JSONObject

data class OutgoingMessage(
    val id: String,
    val recipient: String,
    val body: String
) {
    companion object {
        fun fromJson(json: JSONObject): OutgoingMessage = OutgoingMessage(
            id = json.optString("id"),
            recipient = json.optString("recipient"),
            body = json.optString("body")
        )
    }
}
