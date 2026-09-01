package com.example.smsgateway

import android.Manifest
import android.app.PendingIntent
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicInteger

object SmsSender {

    private const val REQUEST_CODE_SEED = 4242
    private val requestCounter = AtomicInteger(0)

    // Alternance 50/50 entre SIM sur un téléphone multi-SIM (compteur en
    // mémoire : repart à zéro après un redémarrage de l'appli, sans
    // conséquence puisque seule l'alternance relative compte).
    private val simRoundRobin = AtomicInteger(0)

    /** SIM choisie pour un envoi : gestionnaire à utiliser, emplacement (slot,
     * pour distinguer les lignes d'un même téléphone) et numéro si lisible. */
    data class ChosenSim(val manager: SmsManager, val slot: Int, val number: String?)

    fun isDefaultSmsApp(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return context.getSystemService(RoleManager::class.java)
                .isRoleHeld(RoleManager.ROLE_SMS)
        }
        return Telephony.Sms.getDefaultSmsPackage(context) == context.packageName
    }

    /** Ouvre la page Paramètres > Applications par défaut, fiable sur toutes les marques. */
    fun manualDefaultSmsIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)

    /** Liste des SIM actives, ou null si indisponible (permission refusée, mono-SIM non lisible, etc.). */
    private fun activeSubscriptions(context: Context): List<android.telephony.SubscriptionInfo>? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return null
        }
        return try {
            SubscriptionManager.from(context)?.activeSubscriptionInfoList
        } catch (_: SecurityException) {
            null
        }
    }

    /**
     * Nombre de lignes actives sur ce téléphone (1 si mono-SIM, permission
     * refusée, ou lecture impossible). Remonté au serveur à chaque sondage
     * pour qu'il puisse estimer la répartition des envois par ligne.
     */
    fun activeSimCount(context: Context): Int = activeSubscriptions(context)?.size?.coerceAtLeast(1) ?: 1

    /**
     * Numéro d'une SIM, si l'opérateur et Android le laissent lire (beaucoup
     * de cartes ne remontent rien du tout, même avec la permission accordée :
     * c'est une limite fréquente, pas un bug). Tente l'API moderne
     * (Android 13+) puis l'ancienne propriété en repli.
     */
    @Suppress("DEPRECATION")
    private fun subscriptionNumber(context: Context, sub: android.telephony.SubscriptionInfo): String? {
        val number = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                SubscriptionManager.from(context)?.getPhoneNumber(sub.subscriptionId)
            } else {
                sub.number
            }
        } catch (_: Exception) {
            null
        }
        return number?.takeIf { it.isNotBlank() }
    }

    /**
     * SIM utilisée pour le prochain envoi. Sur un téléphone mono-SIM (ou si
     * la permission READ_PHONE_STATE n'est pas accordée), c'est simplement la
     * SIM par défaut du téléphone. Sur un téléphone multi-SIM, on alterne
     * 50/50 entre les SIM actives : chacune garde ainsi son propre quota
     * opérateur (ex. 200 destinataires distincts/mois chez SFR) au lieu de
     * saturer une seule ligne.
     */
    @Suppress("DEPRECATION")
    private fun pickSim(context: Context): ChosenSim {
        val subs = activeSubscriptions(context)
        if (subs.isNullOrEmpty()) {
            return ChosenSim(SmsManager.getDefault(), 0, null)
        }
        if (subs.size < 2) {
            val sub = subs[0]
            return ChosenSim(SmsManager.getDefault(), sub.simSlotIndex, subscriptionNumber(context, sub))
        }
        val index = simRoundRobin.getAndIncrement().mod(subs.size)
        val sub = subs[index]
        return ChosenSim(
            SmsManager.getSmsManagerForSubscriptionId(sub.subscriptionId),
            sub.simSlotIndex,
            subscriptionNumber(context, sub)
        )
    }

    /**
     * Envoie le SMS sans confirmation : le téléphone notifie ensuite via
     * [Config.SMS_SENT_ACTION] et [Config.SMS_DELIVERED_ACTION].
     * Au-delà de 160 caractères, le message est découpé en plusieurs segments
     * (multipart) ; les confirmations sont agrégées par [MultipartTracker].
     */
    fun send(context: Context, message: OutgoingMessage) {
        val sim = pickSim(context)
        val parts = sim.manager.divideMessage(message.body)
        if (parts.size <= 1) {
            sim.manager.sendTextMessage(
                message.recipient,
                null,
                message.body,
                createPendingIntent(context, message, Config.SMS_SENT_ACTION, 0, 1, sim),
                createPendingIntent(context, message, Config.SMS_DELIVERED_ACTION, 0, 1, sim)
            )
        } else {
            val sentIntents = ArrayList(parts.mapIndexed { i, _ ->
                createPendingIntent(context, message, Config.SMS_SENT_ACTION, i, parts.size, sim)
            })
            val deliveredIntents = ArrayList(parts.mapIndexed { i, _ ->
                createPendingIntent(context, message, Config.SMS_DELIVERED_ACTION, i, parts.size, sim)
            })
            sim.manager.sendMultipartTextMessage(
                message.recipient,
                null,
                parts,
                sentIntents,
                deliveredIntents
            )
        }
    }

    private fun createPendingIntent(
        context: Context,
        message: OutgoingMessage,
        action: String,
        partIndex: Int,
        partTotal: Int,
        sim: ChosenSim
    ): PendingIntent {
        val intent = Intent(context, SmsResultReceiver::class.java).apply {
            setAction(action)
            putExtra(Config.EXTRA_MESSAGE_ID, message.id)
            putExtra(Config.EXTRA_PROFILE_ID, message.profileId)
            putExtra(Config.EXTRA_RECIPIENT, message.recipient)
            putExtra(Config.EXTRA_PART_INDEX, partIndex)
            putExtra(Config.EXTRA_PART_TOTAL, partTotal)
            putExtra(Config.EXTRA_SIM_SLOT, sim.slot)
            sim.number?.let { putExtra(Config.EXTRA_SIM_NUMBER, it) }
        }
        val requestCode = REQUEST_CODE_SEED + requestCounter.incrementAndGet() + partIndex
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }
}
