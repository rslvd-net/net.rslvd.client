package net.rslvd.client.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import net.rslvd.client.ui.theme.RslvdTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            RslvdTheme {
                val vm: AppViewModel = viewModel()
                val authed by vm.authed.collectAsState()
                if (authed) {
                    MainScaffold(vm)
                } else {
                    AuthScreen(vm)
                }
            }
        }
    }
}
