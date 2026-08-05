package com.example.smsgateway

import java.util.concurrent.ConcurrentHashMap

data class StatusReport(
    val profileId: String,
    val messageId: String,
    val status: String,
    val error: String?,
    val reportedAt: Long
)

/**
 * Rapports de statut en attente d'envoi à l'API.
 * Le service les retransmet à chaque cycle jusqu'à succès.
 */
object ReportQueue {

    private val reports = ConcurrentHashMap<String, StatusReport>()

    fun add(report: StatusReport) {
        reports["${report.profileId}:${report.messageId}"] = report
    }

    fun all(): List<StatusReport> = reports.values.toList()

    /** Retire de la file tous les rapports de la liste (après acceptation par l'API). */
    fun clearAll(sent: List<StatusReport>) {
        for (r in sent) reports.remove("${r.profileId}:${r.messageId}")
    }

    fun remove(profileId: String, messageId: String) {
        reports.remove("$profileId:$messageId")
    }
}
