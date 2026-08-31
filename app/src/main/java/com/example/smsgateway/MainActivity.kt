package com.example.smsgateway

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.example.smsgateway.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var defaultSmsPromptDone = false

    private val apiRows = mutableMapOf<String, View>()
    private var updatingToggle = false
    @Volatile private var statusGeneration = 0

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

        binding.textVersion.text = getString(R.string.version_format, BuildConfig.VERSION_NAME)

        binding.btnOpenSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        binding.btnClearLogs.setOnClickListener {
            SmsLog.clear(this)
            refresh()
        }
    }

    override fun onResume() {
        super.onResume()
        SmsLog.load(this)
        refresh()
        refreshApis()
        binding.textLastSync.text = if (Config.getLastSyncAt(this) > 0) {
            getString(
                R.string.last_sync_label,
                java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                    .format(java.util.Date(Config.getLastSyncAt(this)))
            )
        } else {
            getString(R.string.last_sync_never)
        }
        val incoming = Config.getLastIncomingSms(this)
        binding.textLastIncoming.text = if (incoming != null) {
            getString(
                R.string.last_incoming_label,
                incoming.sender,
                java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                    .format(java.util.Date(incoming.timestamp)),
                incoming.body
            )
        } else {
            getString(R.string.last_incoming_never)
        }
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
            Manifest.permission.READ_PHONE_STATE
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

    /**
     * Affiche une carte par API configurée : nom, URL, état (joignable ou non)
     * et un toggle pour l'activer / la désactiver dans la passerelle.
     */
    private fun refreshApis() {
        val profiles = Config.getApiProfiles(this)
        binding.apiContainer.removeAllViews()
        apiRows.clear()
        if (profiles.isEmpty()) {
            binding.apiContainer.visibility = View.GONE
            return
        }
        binding.apiContainer.visibility = View.VISIBLE
        for (profile in profiles) {
            val row = LayoutInflater.from(this).inflate(R.layout.item_api, binding.apiContainer, false)
            row.findViewById<TextView>(R.id.apiLabel).text = profile.label
            row.findViewById<TextView>(R.id.apiUrl).text = profile.url
            val status = row.findViewById<TextView>(R.id.apiStatus).apply {
                text = getString(R.string.api_status_checking)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.api_status_checking))
            }
            val toggle = row.findViewById<android.widget.CompoundButton>(R.id.apiToggle)
            updatingToggle = true
            toggle.isChecked = profile.enabled
            updatingToggle = false
            toggle.setOnCheckedChangeListener { _, checked ->
                if (updatingToggle) return@setOnCheckedChangeListener
                setProfileEnabled(profile.id, checked)
                row.findViewById<TextView>(R.id.apiStatus).setTextColor(
                    ContextCompat.getColor(this@MainActivity, R.color.api_status_checking)
                )
            }
            binding.apiContainer.addView(row)
            apiRows[profile.id] = row
        }
        refreshApiStatuses()
    }

    private fun setProfileEnabled(profileId: String, enabled: Boolean) {
        val profiles = Config.getApiProfiles(this).map {
            if (it.id == profileId) it.copy(enabled = enabled) else it
        }
        Config.setApiProfiles(this, profiles)
        SmsGatewayService.requestFlush(this)
    }

    /** Interroge /health de chaque API en arrière-plan et affiche l'état. */
    private fun refreshApiStatuses() {
        val profiles = Config.getApiProfiles(this)
        if (profiles.isEmpty()) return
        val generation = ++statusGeneration
        Thread {
            val api = ApiClient(this)
            for (profile in profiles) {
                val ok = try { api.checkHealth(profile) } catch (_: Exception) { false }
                if (generation != statusGeneration) return@Thread
                runOnUiThread {
                    apiRows[profile.id]?.findViewById<TextView>(R.id.apiStatus)?.let { status ->
                        status.text = getString(
                            if (ok) R.string.api_status_ok else R.string.api_status_down
                        )
                        status.setTextColor(
                            ContextCompat.getColor(
                                this@MainActivity,
                                if (ok) R.color.api_status_ok else R.color.api_status_down
                            )
                        )
                    }
                }
            }
        }.start()
    }

    private fun refresh() {
        val entries = SmsLog.all()
        binding.textEmpty.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
        binding.listLogs.adapter = LogAdapter(entries)
    }

    private inner class LogAdapter(private val entries: List<SmsLog.Entry>) : BaseAdapter() {

        override fun getCount(): Int = entries.size
        override fun getItem(position: Int): SmsLog.Entry = entries[position]
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(this@MainActivity)
                .inflate(R.layout.item_log, parent, false)
            val entry = entries[position]
            val statusText = entry.status?.let { " [$it]" } ?: ""
            view.findViewById<TextView>(R.id.logTitle).text =
                "${SmsLog.formatTime(entry.timestamp)} • ${entry.type}$statusText"
            view.findViewById<TextView>(R.id.logSubtitle).text =
                "${entry.recipient} — id ${entry.messageId}"
            view.findViewById<TextView>(R.id.logDetail).text = entry.detail ?: entry.body
            return view
        }
    }
}
