package com.example.smsgateway

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Telephony
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class ConversationSummary(
    val threadId: Long,
    val address: String,
    val snippet: String,
    val date: Long,
    val displayName: String?
)

/**
 * Onglet "Messages" : liste des conversations SMS normales du téléphone (pas
 * les envois de la passerelle). Nécessite que l'appli soit l'app SMS par
 * défaut pour lire/écrire le fournisseur SMS — sinon la liste reste vide
 * (aucun crash : chaque accès au fournisseur est protégé).
 */
class MessagesFragment : Fragment(R.layout.fragment_messages) {

    private lateinit var recycler: RecyclerView
    private lateinit var emptyView: TextView

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        recycler = view.findViewById(R.id.listConversations)
        emptyView = view.findViewById(R.id.textConversationsEmpty)
        recycler.layoutManager = LinearLayoutManager(requireContext())
        view.findViewById<View>(R.id.btnNewConversation).setOnClickListener { promptNewConversation() }
    }

    override fun onResume() {
        super.onResume()
        loadConversations()
    }

    private fun loadConversations() {
        val context = requireContext().applicationContext
        Thread {
            val conversations = readConversations(context)
            activity?.runOnUiThread {
                if (!isAdded) return@runOnUiThread
                emptyView.visibility = if (conversations.isEmpty()) View.VISIBLE else View.GONE
                recycler.adapter = ConversationAdapter(conversations) { conv -> openConversation(conv) }
            }
        }.start()
    }

    /**
     * Un seul passage sur content://sms (trié par date décroissante) : on
     * garde la première ligne rencontrée pour chaque thread_id, donc la plus
     * récente — évite de dépendre de la table virtuelle "conversations" du
     * fournisseur, moins bien documentée.
     */
    private fun readConversations(context: Context): List<ConversationSummary> {
        val seenThreads = HashSet<Long>()
        val results = mutableListOf<ConversationSummary>()
        try {
            context.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
                null, null,
                "${Telephony.Sms.DATE} DESC"
            )?.use { cursor ->
                val threadIdx = cursor.getColumnIndex(Telephony.Sms.THREAD_ID)
                val addressIdx = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                val bodyIdx = cursor.getColumnIndex(Telephony.Sms.BODY)
                val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)
                if (threadIdx < 0 || addressIdx < 0) return@use
                while (cursor.moveToNext() && results.size < 200) {
                    val threadId = cursor.getLong(threadIdx)
                    if (!seenThreads.add(threadId)) continue
                    val address = cursor.getString(addressIdx) ?: continue
                    if (address.isBlank()) continue
                    val body = if (bodyIdx >= 0) cursor.getString(bodyIdx).orEmpty() else ""
                    val date = if (dateIdx >= 0) cursor.getLong(dateIdx) else 0L
                    results.add(ConversationSummary(threadId, address, body, date, ContactLookup.displayNameFor(context, address)))
                }
            }
        } catch (_: Exception) {
            return emptyList()
        }
        return results
    }

    private fun openConversation(conv: ConversationSummary) {
        startActivity(
            Intent(requireContext(), ConversationActivity::class.java)
                .putExtra(ConversationActivity.EXTRA_THREAD_ID, conv.threadId)
                .putExtra(ConversationActivity.EXTRA_ADDRESS, conv.address)
        )
    }

    private fun promptNewConversation() {
        val input = EditText(requireContext()).apply {
            inputType = InputType.TYPE_CLASS_PHONE
            hint = getString(R.string.messages_new_recipient_hint)
        }
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.messages_new)
            .setView(input)
            .setPositiveButton(R.string.conversation_send) { _, _ ->
                val address = input.text.toString().trim()
                if (address.isNotEmpty()) {
                    startActivity(
                        Intent(requireContext(), ConversationActivity::class.java)
                            .putExtra(ConversationActivity.EXTRA_ADDRESS, address)
                    )
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }
}

private class ConversationAdapter(
    private val items: List<ConversationSummary>,
    private val onClick: (ConversationSummary) -> Unit
) : RecyclerView.Adapter<ConversationAdapter.ViewHolder>() {

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val name: TextView = view.findViewById(R.id.convName)
        val snippet: TextView = view.findViewById(R.id.convSnippet)
        val date: TextView = view.findViewById(R.id.convDate)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_conversation, parent, false)
        return ViewHolder(view)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val item = items[position]
        holder.name.text = item.displayName ?: item.address
        holder.snippet.text = item.snippet
        holder.date.text = if (item.date > 0) {
            SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()).format(Date(item.date))
        } else ""
        holder.itemView.setOnClickListener { onClick(item) }
    }
}
