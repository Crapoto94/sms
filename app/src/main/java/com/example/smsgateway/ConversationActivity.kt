package com.example.smsgateway

import android.content.ContentValues
import android.content.Context
import android.os.Bundle
import android.provider.Telephony
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class SmsMessage(val id: Long, val body: String, val date: Long, val incoming: Boolean)

/**
 * Fil de conversation SMS "normal" (onglet Messages). Ouverte depuis la
 * liste des conversations, une notification de SMS reçu, ou un lien
 * smsto:/EXTRA_TEXT (ComposeSmsActivity) avec un destinataire déjà connu.
 */
class ConversationActivity : AppCompatActivity() {

    private lateinit var recycler: RecyclerView
    private lateinit var inputBody: android.widget.EditText
    private var threadId: Long = -1L
    private lateinit var address: String

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_conversation)

        address = intent.getStringExtra(EXTRA_ADDRESS)?.trim().orEmpty()
        if (address.isEmpty()) {
            finish()
            return
        }
        threadId = intent.getLongExtra(EXTRA_THREAD_ID, -1L)
        if (threadId <= 0L) {
            threadId = MessageStore.threadIdFor(this, address)
        }

        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<TextView>(R.id.conversationTitle).text = ContactLookup.displayNameFor(this, address) ?: address

        recycler = findViewById(R.id.listMessages)
        recycler.layoutManager = LinearLayoutManager(this).apply { stackFromEnd = true }
        inputBody = findViewById(R.id.inputBody)
        intent.getStringExtra(EXTRA_PREFILL_BODY)?.let { inputBody.setText(it) }

        findViewById<View>(R.id.btnSend).setOnClickListener { sendCurrentInput() }
    }

    override fun onResume() {
        super.onResume()
        loadMessages()
        markThreadRead()
    }

    private fun sendCurrentInput() {
        val body = inputBody.text.toString().trim()
        if (body.isEmpty()) return
        inputBody.setText("")
        MessageStore.sendMessage(this, address, body)
        loadMessages()
    }

    private fun loadMessages() {
        val context = applicationContext
        val id = threadId
        Thread {
            val messages = readMessages(context, id)
            runOnUiThread {
                recycler.adapter = MessageAdapter(messages)
                if (messages.isNotEmpty()) recycler.scrollToPosition(messages.size - 1)
            }
        }.start()
    }

    private fun readMessages(context: Context, threadId: Long): List<SmsMessage> {
        val results = mutableListOf<SmsMessage>()
        try {
            context.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms._ID, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
                "${Telephony.Sms.THREAD_ID} = ?",
                arrayOf(threadId.toString()),
                "${Telephony.Sms.DATE} ASC"
            )?.use { cursor ->
                val idIdx = cursor.getColumnIndex(Telephony.Sms._ID)
                val bodyIdx = cursor.getColumnIndex(Telephony.Sms.BODY)
                val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)
                val typeIdx = cursor.getColumnIndex(Telephony.Sms.TYPE)
                while (cursor.moveToNext()) {
                    val type = if (typeIdx >= 0) cursor.getInt(typeIdx) else Telephony.Sms.MESSAGE_TYPE_INBOX
                    results.add(
                        SmsMessage(
                            id = if (idIdx >= 0) cursor.getLong(idIdx) else 0L,
                            body = if (bodyIdx >= 0) cursor.getString(bodyIdx).orEmpty() else "",
                            date = if (dateIdx >= 0) cursor.getLong(dateIdx) else 0L,
                            incoming = type == Telephony.Sms.MESSAGE_TYPE_INBOX
                        )
                    )
                }
            }
        } catch (_: Exception) {
            return emptyList()
        }
        return results
    }

    /** Marque les messages reçus de ce fil comme lus (efface le badge/notification). */
    private fun markThreadRead() {
        val context = applicationContext
        val id = threadId
        Thread {
            try {
                val values = ContentValues().apply { put(Telephony.Sms.READ, 1) }
                context.contentResolver.update(
                    Telephony.Sms.CONTENT_URI, values,
                    "${Telephony.Sms.THREAD_ID} = ? AND ${Telephony.Sms.READ} = 0",
                    arrayOf(id.toString())
                )
            } catch (_: Exception) {
                // pas bloquant
            }
        }.start()
    }

    companion object {
        const val EXTRA_THREAD_ID = "thread_id"
        const val EXTRA_ADDRESS = "address"
        const val EXTRA_PREFILL_BODY = "prefill_body"
    }
}

private class MessageAdapter(private val items: List<SmsMessage>) :
    RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private class BubbleHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.bubbleText)
    }

    override fun getItemViewType(position: Int): Int = if (items[position].incoming) VIEW_IN else VIEW_OUT

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val layout = if (viewType == VIEW_IN) R.layout.item_message_in else R.layout.item_message_out
        return BubbleHolder(LayoutInflater.from(parent.context).inflate(layout, parent, false))
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val item = items[position]
        val time = if (item.date > 0) {
            SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()).format(Date(item.date))
        } else ""
        (holder as BubbleHolder).text.text = if (time.isNotEmpty()) "${item.body}\n\n$time" else item.body
    }

    companion object {
        private const val VIEW_IN = 0
        private const val VIEW_OUT = 1
    }
}
