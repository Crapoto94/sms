package com.example.smsgateway

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * Point d'entrée "ComposeSms" requis par Android pour être éligible comme
 * application SMS par défaut (rôle android.app.role.SMS) — ouverte par
 * exemple depuis la fiche d'un contact ("Message") ou un lien sms:/smsto:.
 * Transmet le destinataire (URI smsto:<numéro>) et le texte pré-rempli
 * (EXTRA_TEXT) à l'écran principal, qui ouvre directement la conversation.
 */
class ComposeSmsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val address = intent?.data?.schemeSpecificPart?.trim().orEmpty()
        val prefillBody = intent?.getStringExtra(Intent.EXTRA_TEXT)
        val target = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (address.isNotEmpty()) {
            target.putExtra(ConversationActivity.EXTRA_ADDRESS, address)
            if (!prefillBody.isNullOrEmpty()) {
                target.putExtra(ConversationActivity.EXTRA_PREFILL_BODY, prefillBody)
            }
        }
        startActivity(target)
        finish()
    }
}
