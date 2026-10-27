package net.rslvd.client.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector

private enum class Tab(val label: String, val icon: ImageVector) {
    Hosts("Hosts", Icons.Filled.Dns),
    Tunnels("Tunnels", Icons.Filled.SwapHoriz),
    Ddns("DDNS", Icons.Filled.Sync),
    Billing("Billing", Icons.Filled.CreditCard),
    Terminal("Shell", Icons.Filled.Terminal),
    Support("Support", Icons.Filled.SupportAgent),
    Account("Account", Icons.Filled.AccountCircle),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScaffold(vm: AppViewModel) {
    var tab by remember { mutableStateOf(Tab.Hosts) }
    val snackbarHostState = remember { SnackbarHostState() }
    val snackbar by vm.snackbar.collectAsState()

    LaunchedEffect(snackbar) {
        snackbar?.let {
            snackbarHostState.showSnackbar(it)
            vm.snackbarShown()
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("rslvd · ${tab.label}") }) },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        val mod = Modifier.padding(padding)
        when (tab) {
            Tab.Hosts -> HostsScreen(vm, mod)
            Tab.Tunnels -> TunnelsScreen(vm, mod, onUpgrade = { tab = Tab.Billing })
            Tab.Ddns -> DdnsScreen(vm, mod)
            Tab.Billing -> BillingScreen(vm, mod)
            Tab.Terminal -> TerminalScreen(mod)
            Tab.Support -> SupportScreen(vm, mod)
            Tab.Account -> AccountScreen(vm, mod)
        }
    }
}
