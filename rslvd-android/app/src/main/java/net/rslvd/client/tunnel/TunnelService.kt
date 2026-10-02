package net.rslvd.client.tunnel

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import net.rslvd.client.ui.MainActivity

/**
 * Foreground service hosting active tunnel connections. Each connected tunnel
 * runs a [TunnelClient] coroutine; the service stops itself when the last
 * tunnel disconnects.
 */
class TunnelService : Service() {

    companion object {
        private const val CHANNEL_ID = "tunnel_client"
        private const val NOTIF_ID = 4301

        const val ACTION_START = "net.rslvd.client.tunnel.START"
        const val ACTION_STOP = "net.rslvd.client.tunnel.STOP"
        const val EXTRA_ID = "id"
        const val EXTRA_NAME = "name"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_PROTOCOL = "protocol"
        const val EXTRA_TARGET_HOST = "target_host"
        const val EXTRA_TARGET_PORT = "target_port"

        private val _states = MutableStateFlow<Map<String, String>>(emptyMap())
        /** tunnelId -> status ("connecting", "connected", "reconnecting", ...) */
        val states: StateFlow<Map<String, String>> = _states.asStateFlow()

        fun start(context: Context, id: String, name: String, token: String, protocol: String, targetHost: String, targetPort: Int) {
            val intent = Intent(context, TunnelService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_NAME, name)
                .putExtra(EXTRA_TOKEN, token)
                .putExtra(EXTRA_PROTOCOL, protocol)
                .putExtra(EXTRA_TARGET_HOST, targetHost)
                .putExtra(EXTRA_TARGET_PORT, targetPort)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context, id: String) {
            val intent = Intent(context, TunnelService::class.java)
                .setAction(ACTION_STOP)
                .putExtra(EXTRA_ID, id)
            context.startService(intent)
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = mutableMapOf<String, Job>()
    private val names = mutableMapOf<String, String>()

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                val name = intent.getStringExtra(EXTRA_NAME) ?: id
                val token = intent.getStringExtra(EXTRA_TOKEN) ?: return START_NOT_STICKY
                val protocol = intent.getStringExtra(EXTRA_PROTOCOL) ?: "tcp"
                val targetHost = intent.getStringExtra(EXTRA_TARGET_HOST) ?: "localhost"
                val targetPort = intent.getIntExtra(EXTRA_TARGET_PORT, 0)
                if (targetPort !in 1..65535) return START_NOT_STICKY

                startForeground(NOTIF_ID, buildNotification())
                if (jobs[id]?.isActive != true) {
                    names[id] = name
                    setState(id, "connecting")
                    jobs[id] = scope.launch {
                        val client = TunnelClient(token, targetHost, targetPort, protocol, DeviceIdentity.id(this@TunnelService), DeviceIdentity.name()) { status ->
                            setState(id, status)
                            updateNotification()
                        }
                        try {
                            client.run(this)
                        } finally {
                            clearState(id)
                            stopIfIdle()
                        }
                    }
                }
                updateNotification()
            }
            ACTION_STOP -> {
                val id = intent.getStringExtra(EXTRA_ID)
                val ids = if (id != null) listOf(id) else jobs.keys.toList()
                for (tid in ids) {
                    jobs.remove(tid)?.cancel()
                    names.remove(tid)
                    clearState(tid)
                }
                stopIfIdle()
                updateNotification()
            }
        }
        return START_NOT_STICKY
    }

    private fun setState(id: String, status: String) {
        _states.value = _states.value + (id to status)
    }

    private fun clearState(id: String) {
        _states.value = _states.value - id
    }

    private fun stopIfIdle() {
        if (jobs.none { it.value.isActive }) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
            stopSelf()
        }
    }

    private fun buildNotification(): android.app.Notification {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Tunnel client", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "Active rslvd tunnel connections" }
            )
        }
        val active = _states.value
        val text = when {
            active.isEmpty() -> "No active tunnels"
            active.size == 1 -> {
                val (id, status) = active.entries.first()
                "${names[id] ?: "tunnel"}: $status"
            }
            else -> "${active.size} tunnels active"
        }
        val contentIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, TunnelService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("rslvd tunnel")
            .setContentText(text)
            .setContentIntent(contentIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                if (active.size > 1) "Stop all" else "Stop",
                stopIntent,
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun updateNotification() {
        if (jobs.none { it.value.isActive }) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID, buildNotification())
    }

    override fun onDestroy() {
        scope.cancel()
        _states.value = emptyMap()
        super.onDestroy()
    }
}
