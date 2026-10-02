package net.rslvd.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import net.rslvd.client.data.LoginResult

@Composable
fun AuthScreen(vm: AppViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("rslvd_ui", android.content.Context.MODE_PRIVATE) }
    var showIntro by remember { mutableStateOf(!prefs.getBoolean("intro_seen", false)) }

    if (showIntro) {
        IntroScreen(onContinue = {
            prefs.edit().putBoolean("intro_seen", true).apply()
            showIntro = false
        })
        return
    }

    var isRegister by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var needTotp by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("rslvd", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text(
                if (isRegister) "Create your account" else "Sign in to manage your DNS",
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(28.dp))

            OutlinedTextField(
                value = email,
                onValueChange = { email = it; error = null },
                label = { Text("Email") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = password,
                onValueChange = { password = it; error = null },
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            if (needTotp) {
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = totp,
                    onValueChange = { totp = it.filter { c -> c.isDigit() }.take(6) },
                    label = { Text("Authenticator code") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            error?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            info?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, color = MaterialTheme.colorScheme.primary)
            }

            Spacer(Modifier.height(20.dp))
            Button(
                onClick = {
                    error = null; info = null; loading = true
                    val cb: (LoginResult) -> Unit = { result ->
                        loading = false
                        when (result) {
                            is LoginResult.Success -> {}
                            is LoginResult.RequiresTotp -> { needTotp = true; info = "Enter your 2FA code" }
                            is LoginResult.Error -> error = result.message
                        }
                    }
                    if (isRegister) vm.register(email, password, cb)
                    else vm.login(email, password, totp.ifBlank { null }, cb)
                },
                enabled = !loading && email.isNotBlank() && password.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (loading) CircularProgressIndicator(Modifier.height(20.dp), strokeWidth = 2.dp)
                else Text(if (isRegister) "Create account" else "Sign in")
            }

            Spacer(Modifier.height(8.dp))
            TextButton(onClick = {
                isRegister = !isRegister; error = null; info = null; needTotp = false
            }) {
                Text(if (isRegister) "Already have an account? Sign in" else "Need an account? Register")
            }

            if (isRegister) {
                Text(
                    "By creating an account you agree to the rslvd.net Terms of Service and Privacy Policy.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.6f),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun IntroScreen(onContinue: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("rslvd", fontSize = 44.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text(
                "Your home network, reachable from anywhere",
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(28.dp))
            IntroPoint(
                "\uD83C\uDF10  A permanent address",
                "Get your own yourname.rslvd.net hostname that always points at your home server, NAS or router — even when your internet IP changes.",
            )
            IntroPoint(
                "\uD83D\uDD04  Automatic DDNS updates",
                "This app keeps your hostname up to date in the background whenever your public IP changes.",
            )
            IntroPoint(
                "\uD83D\uDE87  Tunnels through CGNAT",
                "Behind a carrier NAT with no public IP? Tunnels expose your local services through rslvd.net with automatic HTTPS — connect right from this app.",
            )
            Spacer(Modifier.height(28.dp))
            Button(onClick = onContinue, modifier = Modifier.fillMaxWidth()) { Text("Get started") }
        }
    }
}

@Composable
private fun IntroPoint(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(title, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(Modifier.height(4.dp))
        Text(body, fontSize = 13.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f))
    }
}
