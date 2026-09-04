package com.example.smsgateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat

/**
 * Résolution nom de contact <-> numéro, pour afficher un nom plutôt qu'un
 * numéro brut dans la liste des conversations et les notifications.
 * READ_CONTACTS n'est demandée qu'à l'usage (onglet Messages) ; sans elle
 * (refusée), on retombe simplement sur l'affichage du numéro.
 */
object ContactLookup {

    private fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED

    /** Nom du contact associé à ce numéro, ou null si introuvable/permission refusée. */
    fun displayNameFor(context: Context, address: String): String? {
        if (address.isBlank() || !hasPermission(context)) return null
        val uri: Uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
            Uri.encode(address)
        )
        return try {
            context.contentResolver.query(
                uri,
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
                null, null, null
            )?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
    }
}
