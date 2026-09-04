package com.example.smsgateway

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.example.smsgateway.databinding.ActivityMainBinding

/**
 * Point d'entrée unique de l'appli : héberge deux onglets via la barre de
 * navigation du bas — "Messages" (SMS normaux, affiché par défaut, pour
 * qu'un utilisateur voie une appli SMS classique) et "Passerelle" (l'ancien
 * écran principal, inchangé). L'utilisateur ne voit la passerelle que s'il
 * ouvre cet onglet explicitement.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var defaultSmsPromptDone = false

    private val smsPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            if (results.values.all { it }) {
                openDefaultSmsSettings()
            } else {
                Toast.makeText(this, R.string.permission_denied, Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.bottomNav.setOnItemSelectedListener { item ->
            val fragment: Fragment = when (item.itemId) {
                R.id.navPasserelle -> PasserelleFragment()
                else -> MessagesFragment()
            }
            supportFragmentManager.beginTransaction()
                .replace(R.id.fragmentContainer, fragment)
                .commit()
            true
        }

        if (savedInstanceState == null) {
            // Onglet par défaut : Messages, pour qu'au lancement l'appli se
            // comporte comme une appli SMS ordinaire, sans rien montrer de la
            // passerelle tant que l'utilisateur n'ouvre pas cet onglet.
            // (setSelectedItemId ne redéclenche pas le listener si l'item est
            // déjà sélectionné par défaut : on commit explicitement.)
            supportFragmentManager.beginTransaction()
                .replace(R.id.fragmentContainer, MessagesFragment())
                .commit()
        }

        // Un lien smsto:/EXTRA_TEXT (ComposeSmsActivity) ou une réponse rapide
        // (HeadlessSmsSendService) peuvent aussi cibler directement l'onglet
        // Messages avec un destinataire déjà connu.
        intent?.getStringExtra(ConversationActivity.EXTRA_ADDRESS)?.let { address ->
            startActivity(
                android.content.Intent(this, ConversationActivity::class.java)
                    .putExtra(ConversationActivity.EXTRA_ADDRESS, address)
                    .putExtra(ConversationActivity.EXTRA_PREFILL_BODY, intent.getStringExtra(ConversationActivity.EXTRA_PREFILL_BODY))
            )
        }
    }

    override fun onResume() {
        super.onResume()
        if (!defaultSmsPromptDone && !SmsSender.isDefaultSmsApp(this)) {
            defaultSmsPromptDone = true
            ensureSmsPermissionsAndOpen()
        }
    }

    private fun ensureSmsPermissionsAndOpen() {
        val needed = mutableListOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.RECEIVE_WAP_PUSH,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CONTACTS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            smsPermissionLauncher.launch(missing.toTypedArray())
        } else {
            openDefaultSmsSettings()
        }
    }

    private fun openDefaultSmsSettings() {
        startActivity(SmsSender.manualDefaultSmsIntent())
    }
}
