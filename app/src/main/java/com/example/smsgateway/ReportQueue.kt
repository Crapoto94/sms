package com.example.smsgateway

import java.util.concurrent.ConcurrentHashMap

data class StatusReport(
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
        reports[report.messageId] = report
    }

    fun all(): List<StatusReport> = reports.values.toList()

    fun remove(messageId: String) {
        reports.remove(messageId)
    }
}
