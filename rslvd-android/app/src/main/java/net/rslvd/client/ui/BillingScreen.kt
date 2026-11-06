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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private const val DONATE_URL = "https://rslvd.net/dashboard"

/**
 * Support tab. rslvd.net is donation-funded — there are no subscriptions and no
 * plans to buy — so this screen only shows the donor window and links to the
 * web dashboard, where Square handles the one-time payment. No card data ever
 * touches the app.
 */
@Composable
fun BillingScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val user by vm.user.collectAsState()
    val billing by vm.billing.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(Unit) { vm.loadBilling() }

    val isDonor = user?.donor == true
    val donorUntil = user?.donorExpiresAt?.take(10)

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Your access", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (isDonor) "Supporter" else "Free",
                        fontWeight = FontWeight.Bold, fontSize = 22.sp,
                    )
                    Spacer(Modifier.weight(1f))
                    StatusBadge(isDonor)
                }
                if (isDonor) {
                    Spacer(Modifier.height(8.dp))
                    donorUntil?.let { InfoLine("Donor access until", it) }
                    InfoLine("Hostnames", user?.maxHosts?.let { if (it >= 999999) "Unlimited" else "$it" } ?: "Unlimited")
                    InfoLine("Tunnels", user?.maxTunnels?.let { if (it >= 999999) "Unlimited" else "$it" } ?: "Unlimited")
                    InfoLine("SSH / ADB remote access", "Included")
                    InfoLine("Nested subdomains", "Included")
                } else {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Free tier: up to ${user?.maxHosts ?: 2} hostnames and ${user?.maxTunnels ?: 2} tunnels, " +
                            "plus one SSH and one ADB tunnel. A donation unlocks unlimited hostnames and " +
                            "tunnels, unlimited SSH/ADB tunnels, and nested subdomains for 90 days.",
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f), fontSize = 14.sp,
                    )
                }
            }
        }

        if (billing.loading) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator(Modifier.padding(16.dp))
            }
        }

        billing.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }

        Spacer(Modifier.height(4.dp))
        Button(
            onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DONATE_URL))) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (user?.supporter == true) "Donate again on rslvd.net" else "Donate on rslvd.net") }
        Text(
            "rslvd.net is funded entirely by donations. Payments are processed securely by Square " +
                "on rslvd.net — card details never touch this app. No subscription, nothing to cancel.",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )

        OutlinedButton(onClick = { vm.loadBilling() }, modifier = Modifier.fillMaxWidth()) {
            Text("Refresh")
        }
    }
}

@Composable
private fun StatusBadge(isDonor: Boolean) {
    val label = if (isDonor) "Donor" else "Free"
    val color = if (isDonor) Color(0xFF34D399) else Color(0xFF9CA3AF)
    Text(label, color = color, fontWeight = FontWeight.Bold, fontSize = 14.sp)
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f), fontSize = 14.sp)
        Text(value, fontWeight = FontWeight.Medium, fontSize = 14.sp)
    }
}
