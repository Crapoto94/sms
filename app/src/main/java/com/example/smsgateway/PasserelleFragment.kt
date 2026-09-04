package com.example.smsgateway

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.example.smsgateway.databinding.FragmentPasserelleBinding

/**
 * Onglet "Passerelle" : reprend telle quelle l'ancienne interface principale
 * de l'appli (état des API configurées, journal d'envoi, accès aux
 * réglages) — comportement inchangé, seulement déplacé derrière la barre de
 * navigation du bas pour laisser la place à l'onglet Messages.
 */
class PasserelleFragment : Fragment() {

    private var _binding: FragmentPasserelleBinding? = null
    private val binding get() = _binding!!

    private val apiRows = mutableMapOf<String, View>()
    private var updatingToggle = false
    @Volatile private var statusGeneration = 0

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentPasserelleBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.textVersion.text = getString(R.string.version_format, BuildConfig.VERSION_NAME)
        binding.btnOpenSettings.setOnClickListener {
            startActivity(Intent(requireContext(), SettingsActivity::class.java))
        }
        binding.btnClearLogs.setOnClickListener {
            SmsLog.clear(requireContext())
            refresh()
        }
    }

    override fun onResume() {
        super.onResume()
        val context = requireContext()
        SmsLog.load(context)
        refresh()
        refreshApis()
        binding.textLastSync.text = if (Config.getLastSyncAt(context) > 0) {
            getString(
                R.string.last_sync_label,
                java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                    .format(java.util.Date(Config.getLastSyncAt(context)))
            )
        } else {
            getString(R.string.last_sync_never)
        }
        val incoming = Config.getLastIncomingSms(context)
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
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    /**
     * Affiche une carte par API configurée : nom, URL, état (joignable ou non)
     * et un toggle pour l'activer / la désactiver dans la passerelle.
     */
    private fun refreshApis() {
        val context = requireContext()
        val profiles = Config.getApiProfiles(context)
        binding.apiContainer.removeAllViews()
        apiRows.clear()
        if (profiles.isEmpty()) {
            binding.apiContainer.visibility = View.GONE
            return
        }
        binding.apiContainer.visibility = View.VISIBLE
        for (profile in profiles) {
            val row = LayoutInflater.from(context).inflate(R.layout.item_api, binding.apiContainer, false)
            row.findViewById<TextView>(R.id.apiLabel).text = profile.label
            row.findViewById<TextView>(R.id.apiUrl).text = profile.url
            row.findViewById<TextView>(R.id.apiStatus).apply {
                text = getString(R.string.api_status_checking)
                setTextColor(ContextCompat.getColor(context, R.color.api_status_checking))
            }
            val toggle = row.findViewById<android.widget.CompoundButton>(R.id.apiToggle)
            updatingToggle = true
            toggle.isChecked = profile.enabled
            updatingToggle = false
            toggle.setOnCheckedChangeListener { _, checked ->
                if (updatingToggle) return@setOnCheckedChangeListener
                setProfileEnabled(profile.id, checked)
                row.findViewById<TextView>(R.id.apiStatus).setTextColor(
                    ContextCompat.getColor(context, R.color.api_status_checking)
                )
            }
            binding.apiContainer.addView(row)
            apiRows[profile.id] = row
        }
        refreshApiStatuses()
    }

    private fun setProfileEnabled(profileId: String, enabled: Boolean) {
        val context = requireContext()
        val profiles = Config.getApiProfiles(context).map {
            if (it.id == profileId) it.copy(enabled = enabled) else it
        }
        Config.setApiProfiles(context, profiles)
        SmsGatewayService.requestFlush(context)
    }

    /** Interroge /health de chaque API en arrière-plan et affiche l'état. */
    private fun refreshApiStatuses() {
        val context = requireContext().applicationContext
        val profiles = Config.getApiProfiles(context)
        if (profiles.isEmpty()) return
        val generation = ++statusGeneration
        Thread {
            val api = ApiClient(context)
            for (profile in profiles) {
                val ok = try { api.checkHealth(profile) } catch (_: Exception) { false }
                if (generation != statusGeneration) return@Thread
                activity?.runOnUiThread {
                    if (_binding == null) return@runOnUiThread
                    apiRows[profile.id]?.findViewById<TextView>(R.id.apiStatus)?.let { status ->
                        status.text = getString(
                            if (ok) R.string.api_status_ok else R.string.api_status_down
                        )
                        status.setTextColor(
                            ContextCompat.getColor(
                                context,
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
            val view = convertView ?: LayoutInflater.from(requireContext())
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
