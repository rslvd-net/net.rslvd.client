package net.rslvd.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import net.rslvd.client.data.Tunnel
import net.rslvd.client.tunnel.TunnelService

@Composable
fun TunnelsScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val state by vm.tunnels.collectAsState()
    val tunnelStates by TunnelService.states.collectAsState()
    var showAdd by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<Tunnel?>(null) }

    val requestNotifications = rememberNotificationPermissionRequest()

    LaunchedEffect(Unit) { vm.loadTunnels() }

    Scaffold(
        modifier = modifier,
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showAdd = true },
                icon = { Icon(Icons.Filled.Add, contentDescription = "Add tunnel") },
                text = { Text("Add tunnel") },
            )
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                state.loading && state.items.isEmpty() ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                state.items.isEmpty() ->
                    EmptyState(
                        title = "No tunnels yet",
                        subtitle = state.error ?: "Create a tunnel to expose a local port through an @rslvd.net subdomain.",
                    )
                else -> LazyColumn(
                    Modifier.fillMaxSize().padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.items, key = { it.id }) { t ->
                        val status = tunnelStates[t.id]
                        TunnelCard(
                            tunnel = t,
                            status = status,
                            onCopyToken = {
                                val proto = t.protocol ?: "tcp"
                                val flag = when (proto) { "udp" -> "-udp "; "dns2tcp" -> "-dns "; else -> "" }
                                val cmd = "rslvd-tunnel $flag${t.token} ${t.targetPort ?: ""}".trim()
                                val url = t.fqdn?.let { f -> "${if (t.forceHttps) "https" else "http"}://$f" } ?: ""
                                vm.copyText("token + URL", listOf(url, cmd).filter { it.isNotBlank() }.joinToString("\n"), sensitive = true)
                            },
                            onConnect = { requestNotifications(); vm.connectTunnel(t) },
                            onDisconnect = { vm.disconnectTunnel(t) },
                            onDelete = { confirmDelete = t },
                        )
                    }
                }
            }
        }
    }

    if (showAdd) {
        AddTunnelDialog(
            onDismiss = { showAdd = false },
            onConfirm = { name, port, host, proto, https ->
                vm.createTunnel(name, port, host, proto, https) { ok -> if (ok) showAdd = false }
            },
        )
    }

    confirmDelete?.let { t ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete tunnel") },
            text = { Text("Delete ${t.name}? This removes its DNS record.") },
            confirmButton = { TextButton(onClick = { vm.deleteTunnel(t); confirmDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun TunnelCard(
    tunnel: Tunnel,
    status: String?,
    onCopyToken: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onDelete: () -> Unit,
) {
    val runningLocally = status != null
    val agentAttached = status == "connected" || tunnel.connected == true
    val statusLabel = status ?: if (tunnel.connected == true) "connected" else "waiting for agent"
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(tunnel.fqdn ?: tunnel.name, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, "Delete", tint = MaterialTheme.colorScheme.error) }
            }
            Text(
                "${tunnel.protocol?.uppercase() ?: "TCP"} → ${tunnel.targetHost ?: "localhost"}:${tunnel.targetPort ?: "?"}  ·  $statusLabel",
                fontSize = 13.sp,
                color = if (agentAttached) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!tunnel.token.isNullOrBlank()) {
                    if (runningLocally) {
                        OutlinedButton(onClick = onDisconnect) { Text("Disconnect") }
                    } else {
                        OutlinedButton(onClick = onConnect) {
                            Icon(Icons.Filled.PlayArrow, null, Modifier.height(16.dp)); Text(" Connect")
                        }
                    }
                    OutlinedButton(onClick = onCopyToken) {
                        Icon(Icons.Filled.ContentCopy, null, Modifier.height(16.dp)); Text(" Copy token + URL")
                    }
                }
            }
        }
    }
}

@Composable
private fun AddTunnelDialog(
    onDismiss: () -> Unit,
    onConfirm: (String, Int, String, String, Boolean) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("localhost") }
    var proto by remember { mutableStateOf("tcp") }
    var https by remember { mutableStateOf(true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add tunnel") },
        text = {
            Column {
                LabeledField(name, { name = it.lowercase().filter { c -> c.isLetterOrDigit() || c == '-' } }, "subdomain")
                Spacer(Modifier.height(8.dp))
                LabeledField(host, { host = it }, "target host")
                Spacer(Modifier.height(8.dp))
                LabeledField(port, { port = it.filter { c -> c.isDigit() }.take(5) }, "target port")
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("tcp", "udp", "dns2tcp").forEach { p ->
                        FilterChip(selected = proto == p, onClick = { proto = p }, label = { Text(p) })
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Force HTTPS", modifier = Modifier.weight(1f))
                    Switch(checked = https, onCheckedChange = { https = it })
                }
            }
        },
        confirmButton = {
            val portNum = port.toIntOrNull()
            TextButton(
                enabled = name.isNotBlank() && portNum != null && portNum in 1..65535,
                onClick = { onConfirm(name, portNum!!, host, proto, https) },
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
