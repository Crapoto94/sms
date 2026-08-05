package com.example.smsgateway

import org.json.JSONObject

data class OutgoingMessage(
    val profileId: String,
    val id: String,
    val recipient: String,
    val body: String
) {
    companion object {
        fun fromJson(json: JSONObject): OutgoingMessage = OutgoingMessage(
            id = json.optString("id"),
            profileId = json.optString("profileId"),
            recipient = json.optString("recipient"),
            body = json.optString("body")
        )
    }
}
