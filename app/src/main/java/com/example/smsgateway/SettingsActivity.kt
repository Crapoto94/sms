package com.example.smsgateway

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.example.smsgateway.databinding.ActivitySettingsBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding
    private var pendingAction: (() -> Unit)? = null
    private var updatingSwitch = false

    private val stateHandler = Handler(Looper.getMainLooper())
    private val statePoller = object : Runnable {
        override fun run() {
            updateServiceStateUi()
            stateHandler.postDelayed(this, 300)
        }
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            if (results.values.all { it }) {
                pendingAction?.invoke()
            } else {
                Toast.makeText(this, R.string.permission_denied, Toast.LENGTH_LONG).show()
                setSwitchChecked(false)
            }
            pendingAction = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.textVersion.text = getString(R.string.version_format, BuildConfig.VERSION_NAME)
        binding.textDeviceId.text = "${getString(R.string.device_id_label)} : ${Config.getDeviceId(this)}"
        binding.editBaseUrl.setText(Config.getBaseUrl(this))
        binding.editApiKey.setText(Config.getGatewayApiKey(this))

        binding.btnBack.setOnClickListener { finish() }

        binding.btnSaveUrl.setOnClickListener {
            val url = binding.editBaseUrl.text.toString().trim()
            val key = binding.editApiKey.text.toString().trim()
            if (url.isNotEmpty()) {
                Config.setBaseUrl(this, url)
            }
            Config.setGatewayApiKey(this, key)
            Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()
        }

        binding.btnSetDefaultSms.setOnClickListener {
            startActivity(SmsSender.manualDefaultSmsIntent())
        }

        binding.switchService.setOnCheckedChangeListener { _, checked ->
            if (updatingSwitch) return@setOnCheckedChangeListener
            if (checked) {
                ensurePermissionsAndStart()
            } else {
                SmsGatewayService.stop(this)
                Toast.makeText(this, R.string.service_stopped, Toast.LENGTH_SHORT).show()
            }
        }
        binding.btnSendTestSms.setOnClickListener { sendTestSms() }
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
        stateHandler.post(statePoller)
    }

    override fun onPause() {
        super.onPause()
        stateHandler.removeCallbacks(statePoller)
    }

    private fun refreshUi() {
        val isDefault = SmsSender.isDefaultSmsApp(this)
        binding.btnSetDefaultSms.isEnabled = !isDefault
        binding.textDefaultSms.text = if (isDefault) {
            getString(R.string.status_default_sms_ok)
        } else {
            getString(R.string.status_default_sms_missing)
        }
        updateServiceStateUi()
    }

    /** Reflète l'état réel du service en temps réel (interrogé toutes les 300 ms). */
    private fun updateServiceStateUi() {
        val running = SmsGatewayService.isRunning
        binding.textServiceState.text = if (running) {
            getString(R.string.status_service_running)
        } else {
            getString(R.string.status_service_stopped)
        }
        if (binding.switchService.isChecked != running) {
            setSwitchChecked(running)
        }
        val lastSync = Config.getLastSyncAt(this)
        binding.textLastSync.text = if (lastSync > 0) {
            getString(
                R.string.last_sync_label,
                SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(lastSync))
            )
        } else {
            getString(R.string.last_sync_never)
        }
        val incoming = Config.getLastIncomingSms(this)
        binding.textLastIncoming.text = if (incoming != null) {
            getString(
                R.string.last_incoming_label,
                incoming.sender,
                SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(incoming.timestamp)),
                incoming.body
            )
        } else {
            getString(R.string.last_incoming_never)
        }
    }

    private fun setSwitchChecked(checked: Boolean) {
        updatingSwitch = true
        binding.switchService.isChecked = checked
        updatingSwitch = false
    }

    private fun ensurePermissionsAndStart() {
        val needed = mutableListOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.RECEIVE_WAP_PUSH
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            pendingAction = { startGateway() }
            permissionLauncher.launch(missing.toTypedArray())
            return
        }
        startGateway()
    }

    private fun sendTestSms() {
        val number = binding.editTestRecipient.text.toString().trim()
        if (number.isEmpty()) {
            Toast.makeText(this, R.string.test_sms_number_required, Toast.LENGTH_SHORT).show()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingAction = { sendTestSms() }
            permissionLauncher.launch(arrayOf(Manifest.permission.SEND_SMS))
            return
        }
        if (!SmsSender.isDefaultSmsApp(this)) {
            Toast.makeText(this, R.string.make_default_first, Toast.LENGTH_LONG).show()
            return
        }
        val message = OutgoingMessage(
            id = "test-${System.currentTimeMillis()}",
            recipient = number,
            body = "SMS de test depuis la passerelle"
        )
        try {
            SmsSender.send(this, message)
            Toast.makeText(this, getString(R.string.test_sms_sent, number), Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.test_sms_error, e.message), Toast.LENGTH_LONG).show()
        }
    }

    private fun startGateway() {
        if (!SmsSender.isDefaultSmsApp(this)) {
            Toast.makeText(this, R.string.make_default_first, Toast.LENGTH_LONG).show()
            setSwitchChecked(false)
            refreshUi()
            return
        }
        SmsGatewayService.start(this)
        Toast.makeText(this, R.string.service_started, Toast.LENGTH_SHORT).show()
    }
}
