package net.rslvd.client.ui

import android.content.Intent
import android.net.Uri
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AccountScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val user by vm.user.collectAsState()
    val context = LocalContext.current
    var showDelete by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.refreshUser() }

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(user?.email ?: vm.accountEmail ?: "Signed in", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Spacer(Modifier.height(8.dp))
                InfoRow("Plan", user?.plan?.replaceFirstChar { it.uppercase() } ?: "—")
                InfoRow("Status", user?.status ?: "—")
                InfoRow("Host limit", user?.maxHosts?.let { if (it >= 999999) "Unlimited" else it.toString() } ?: "—")
                InfoRow("Tunnel limit", user?.maxTunnels?.let { if (it >= 999999) "Unlimited" else it.toString() } ?: "—")
                InfoRow("Email verified", if (user?.emailVerified == true) "Yes" else "No")
                if (user?.totpEnabled == true) InfoRow("2FA", "Enabled")
            }
        }

        OutlinedButton(
            onClick = {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://rslvd.net/dashboard")))
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Open rslvd.net dashboard") }

        OutlinedButton(onClick = { vm.refreshUser() }, modifier = Modifier.fillMaxWidth()) {
            Text("Refresh account")
        }

        Spacer(Modifier.height(8.dp))
        Button(
            onClick = { vm.logout() },
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Sign out") }

        if (user?.isSiteOwner != true) {
            OutlinedButton(
                onClick = { showDelete = true },
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Delete account…") }
        }
    }

    if (showDelete) {
        DeleteAccountDialog(
            email = user?.email ?: vm.accountEmail ?: "this account",
            onDismiss = { showDelete = false },
            onConfirm = { password, done -> vm.deleteAccount(password) { ok -> if (ok) showDelete = false else done() } },
        )
    }
}

@Composable
private fun DeleteAccountDialog(email: String, onDismiss: () -> Unit, onConfirm: (String, () -> Unit) -> Unit) {
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Delete account") },
        text = {
            Column {
                Text(
                    "Permanently delete $email? All hosts, tunnels, DNS records and DDNS targets " +
                        "will be removed, any stored payment card is disabled, and this cannot be undone.",
                    fontSize = 14.sp,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Confirm your password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = password.isNotBlank() && !busy,
                onClick = { busy = true; onConfirm(password) { busy = false } },
            ) { Text(if (busy) "Deleting…" else "Delete forever", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Text(value, fontWeight = FontWeight.Medium)
    }
}
