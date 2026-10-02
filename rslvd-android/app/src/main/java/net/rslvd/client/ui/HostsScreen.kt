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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import net.rslvd.client.data.Host

@Composable
fun HostsScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val state by vm.hosts.collectAsState()
    val ddns by vm.ddns.collectAsState()
    var showAdd by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<Host?>(null) }
    var setIpHost by remember { mutableStateOf<Host?>(null) }

    LaunchedEffect(Unit) { vm.loadHosts(); vm.refreshDdns() }

    Scaffold(
        modifier = modifier,
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showAdd = true },
                icon = { Icon(Icons.Filled.Add, contentDescription = "Add host") },
                text = { Text("Add host") },
            )
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                state.loading && state.items.isEmpty() ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                state.items.isEmpty() ->
                    EmptyState(
                        title = "No hosts yet",
                        subtitle = state.error ?: "Add a hostname to point an @rslvd.net subdomain at your device.",
                    )
                else -> LazyColumn(
                    Modifier.fillMaxSize().padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.items, key = { it.id }) { host ->
                        HostCard(
                            host = host,
                            inDdns = ddns.targets.any { it.id == "host-${host.id}" },
                            onCopyKey = { host.updateKey?.let { vm.copyText("update key", it, sensitive = true) } },
                            onCopyFqdn = { vm.copyText("hostname", host.fqdn) },
                            onAddDdns = { vm.addRslvdTarget(host) },
                            onSetIp = { setIpHost = host },
                            onDelete = { confirmDelete = host },
                        )
                    }
                }
            }
        }
    }

    if (showAdd) {
        AddHostDialog(
            onDismiss = { showAdd = false },
            onConfirm = { name, https -> vm.createHost(name, https) { ok -> if (ok) showAdd = false } },
        )
    }

    confirmDelete?.let { host ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete host") },
            text = { Text("Delete ${host.fqdn}? This removes its DNS records and its DDNS target on this device.") },
            confirmButton = { TextButton(onClick = { vm.deleteHost(host); confirmDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }

    setIpHost?.let { host ->
        SetHostIpDialog(
            onDismiss = { setIpHost = null },
            onConfirm = { ip -> vm.setHostIp(host, ip) { ok -> if (ok) setIpHost = null } },
        )
    }
}

@Composable
private fun HostCard(
    host: Host,
    inDdns: Boolean,
    onCopyKey: () -> Unit,
    onCopyFqdn: () -> Unit,
    onAddDdns: () -> Unit,
    onSetIp: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(host.fqdn, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                IconButton(onClick = onCopyFqdn) { Icon(Icons.Filled.ContentCopy, "Copy hostname") }
                IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, "Delete", tint = MaterialTheme.colorScheme.error) }
            }
            Text(
                "IP: ${host.ipAddress ?: "—"}${if (host.forceHttps) "  ·  HTTPS" else "  ·  HTTP"}",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            host.lastUpdated?.let {
                Text("Updated: ${formatIsoTimestamp(it)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onAddDdns, enabled = !inDdns) { Text(if (inDdns) "In DDNS ✓" else "Add to DDNS") }
                if (!host.updateKey.isNullOrBlank()) {
                    OutlinedButton(onClick = onSetIp) { Text("Set IP") }
                }
                if (!host.updateKey.isNullOrBlank()) {
                    OutlinedButton(onClick = onCopyKey) {
                        Icon(Icons.Filled.ContentCopy, null, Modifier.height(16.dp)); Spacer(Modifier.height(0.dp)); Text("Key")
                    }
                }
            }
        }
    }
}

@Composable
private fun SetHostIpDialog(onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var ip by remember { mutableStateOf("") }
    val valid = ip.split('.').let { parts ->
        parts.size == 4 && parts.all { it.isNotEmpty() && it.toIntOrNull()?.let { octet -> octet in 0..255 } == true }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Set IP address") },
        text = {
            Column {
                OutlinedTextField(
                    value = ip,
                    onValueChange = { ip = it.filter { c -> c.isDigit() || c == '.' }.take(15) },
                    label = { Text("IPv4 address") },
                    placeholder = { Text("192.0.2.1") },
                    singleLine = true,
                )
                if (ip.isNotBlank() && !valid) {
                    Text("Enter four octets between 0 and 255", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                }
            }
        },
        confirmButton = { TextButton(enabled = valid, onClick = { onConfirm(ip.trim()) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun AddHostDialog(onDismiss: () -> Unit, onConfirm: (String, Boolean) -> Unit) {
    var name by remember { mutableStateOf("") }
    var https by remember { mutableStateOf(true) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add host") },
        text = {
            Column {
                LabeledField(name, { name = it.lowercase().filter { c -> c.isLetterOrDigit() || c == '-' } }, "subdomain")
                Text("→ $name.rslvd.net".takeIf { name.isNotBlank() } ?: "e.g. myhome.rslvd.net",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Force HTTPS", modifier = Modifier.weight(1f))
                    Switch(checked = https, onCheckedChange = { https = it })
                }
            }
        },
        confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { onConfirm(name, https) }) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
