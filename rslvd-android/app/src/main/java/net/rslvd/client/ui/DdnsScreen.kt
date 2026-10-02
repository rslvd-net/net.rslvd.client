package net.rslvd.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import net.rslvd.client.ddns.DdnsTarget
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DdnsScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val state by vm.ddns.collectAsState()
    var showAddCustom by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<DdnsTarget?>(null) }
    val requestNotifications = rememberNotificationPermissionRequest()

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Background updates", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        Text(
                            "Keep your targets pointed at this device's public IP.",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                        )
                    }
                    Switch(checked = state.enabled, onCheckedChange = {
                        if (it) requestNotifications()
                        vm.setDdnsEnabled(it)
                    })
                }
                Spacer(Modifier.height(10.dp))
                Text("Check every", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(15L, 30L, 60L, 360L).forEach { m ->
                        FilterChip(
                            selected = state.intervalMinutes == m,
                            onClick = { vm.setDdnsInterval(m) },
                            label = { Text(if (m < 60) "${m}m" else "${m / 60}h") },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "Current IP: ${state.lastDetectedIp ?: "—"}",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                )
                state.lastRun.takeIf { it > 0 }?.let {
                    Text("Last run: ${formatTime(it)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
                }
                Spacer(Modifier.height(10.dp))
                Button(onClick = { vm.runDdnsNow() }, modifier = Modifier.fillMaxWidth()) { Text("Update now") }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Targets (${state.targets.size})", fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f))
            OutlinedButton(onClick = { showAddCustom = true }) { Text("Add custom") }
        }
        Text(
            "Add rslvd hosts from the Hosts tab, or add any DynDNS-compatible provider here. The updater defaults to rslvd.",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )

        if (state.targets.isEmpty()) {
            Text("No targets yet.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        } else {
            state.targets.forEach { target ->
                TargetCard(target) { confirmRemove = target }
            }
        }
    }

    confirmRemove?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("Remove DDNS target") },
            text = { Text("Stop updating ${target.label}? The host itself is not deleted — you can re-add it from the Hosts tab.") },
            confirmButton = { TextButton(onClick = { vm.removeTarget(target.id); confirmRemove = null }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text("Cancel") } },
        )
    }

    if (showAddCustom) {
        AddCustomTargetDialog(
            onDismiss = { showAddCustom = false },
            onConfirm = { label, url -> vm.addCustomTarget(label, url) { ok -> if (ok) showAddCustom = false } },
        )
    }
}

@Composable
private fun TargetCard(target: DdnsTarget, onRemove: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row {
                    Text(target.label, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    Text(
                        target.provider.uppercase(),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                target.lastStatus?.let {
                    Text("→ $it", fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                }
            }
            IconButton(onClick = onRemove) { Icon(Icons.Filled.Delete, "Remove", tint = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun AddCustomTargetDialog(onDismiss: () -> Unit, onConfirm: (String, String) -> Unit) {
    var label by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("https://") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add custom DDNS target") },
        text = {
            Column {
                LabeledField(label, { label = it }, "label (e.g. homelab)")
                Spacer(Modifier.height(8.dp))
                LabeledField(url, { url = it }, "update URL")
                Spacer(Modifier.height(6.dp))
                Text(
                    "Use ${DdnsTarget.IP_TOKEN} where the IP should go. " +
                        "Example: https://user:pass@domains.google.com/nic/update?hostname=me.example.com&myip=${DdnsTarget.IP_TOKEN}",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = label.isNotBlank() && url.contains(DdnsTarget.IP_TOKEN),
                onClick = { onConfirm(label, url) },
            ) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private fun formatTime(epoch: Long): String =
    SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(Date(epoch))
