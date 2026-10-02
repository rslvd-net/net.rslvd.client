package net.rslvd.client.ui

import android.content.Context
import android.graphics.Typeface
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.rslvd.client.BuildConfig
import net.rslvd.client.shell.BootstrapInstaller
import net.rslvd.client.shell.TerminalHost

/**
 * A real terminal: the shell runs on a pseudo-terminal and its output is
 * rendered by a VT100/xterm emulator, so full-screen programs (nano, vim, top,
 * less), colours, readline editing and Ctrl/Alt chords all work.
 */
@Composable
fun TerminalScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current.applicationContext

    if (BuildConfig.BOOTSTRAP_ENABLED) {
        var installed by remember { mutableStateOf(BootstrapInstaller.isInstalled(context)) }
        if (!installed) {
            BootstrapInstallScreen(modifier, context) { installed = true }
            return
        }
    }

    val host = remember { TerminalHost.get(context) }
    val density = LocalDensity.current.density
    var exited by remember { mutableStateOf<Int?>(null) }
    var ctrl by remember { mutableStateOf(false) }
    var alt by remember { mutableStateOf(false) }
    var fontSize by remember { mutableStateOf((DEFAULT_FONT_SP * density).toInt()) }
    var termView by remember { mutableStateOf<TerminalView?>(null) }

    DisposableEffect(host) {
        host.onFinished = { exited = it }
        onDispose {
            host.onFinished = null
            host.view = null
        }
    }

    val client = remember {
        object : TerminalViewClient {
            override fun onScale(scale: Float): Float {
                if (scale < 0.9f || scale > 1.1f) {
                    val step = (2 * density).toInt().coerceAtLeast(1)
                    val size = (fontSize + if (scale > 1f) step else -step)
                        .coerceIn((MIN_FONT_SP * density).toInt(), (MAX_FONT_SP * density).toInt())
                    if (size != fontSize) {
                        fontSize = size
                        termView?.setTextSize(size)
                    }
                    return 1f
                }
                return scale
            }

            override fun onSingleTapUp(e: MotionEvent) {
                termView?.let { v ->
                    v.requestFocus()
                    val imm = v.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                    imm.showSoftInput(v, 0)
                }
            }

            override fun shouldBackButtonBeMappedToEscape() = false
            override fun shouldEnforceCharBasedInput() = true
            override fun shouldUseCtrlSpaceWorkaround() = false
            override fun isTerminalViewSelected() = true
            override fun copyModeChanged(copyMode: Boolean) {}
            override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean {
                if (keyCode == KeyEvent.KEYCODE_ENTER && !session.isRunning) {
                    host.restart()
                    exited = null
                    return true
                }
                return false
            }
            override fun onKeyUp(keyCode: Int, e: KeyEvent) = false
            override fun onLongPress(event: MotionEvent) = false

            // One-shot modifiers from the extra-keys row.
            override fun readControlKey(): Boolean = ctrl.also { if (it) ctrl = false }
            override fun readAltKey(): Boolean = alt.also { if (it) alt = false }
            override fun readShiftKey() = false
            override fun readFnKey() = false

            override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession) = false
            override fun onEmulatorSet() {}

            override fun logError(tag: String?, message: String?) {}
            override fun logWarn(tag: String?, message: String?) {}
            override fun logInfo(tag: String?, message: String?) {}
            override fun logDebug(tag: String?, message: String?) {}
            override fun logVerbose(tag: String?, message: String?) {}
            override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
            override fun logStackTrace(tag: String?, e: Exception?) {}
        }
    }

    fun sendKey(keyCode: Int) {
        val v = termView ?: return
        var mod = 0
        if (ctrl) { mod = mod or KeyHandler.KEYMOD_CTRL; ctrl = false }
        if (alt) { mod = mod or KeyHandler.KEYMOD_ALT; alt = false }
        v.handleKeyCode(keyCode, mod)
    }

    fun sendText(text: String) {
        val v = termView ?: return
        text.codePoints().forEach { cp ->
            v.inputCodePoint(TerminalView.KEY_EVENT_SOURCE_VIRTUAL_KEYBOARD, cp, false, false)
        }
    }

    Column(modifier.fillMaxSize().background(TERMINAL_BG)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                modifier = Modifier
                    .fillMaxSize()
                    .semantics { contentDescription = "Terminal" },
                factory = { ctx ->
                    TerminalView(ctx, null).apply {
                        setTerminalViewClient(client)
                        setTextSize(fontSize)
                        setTypeface(Typeface.MONOSPACE)
                        setBackgroundColor(TERMINAL_BG_INT)
                        keepScreenOn = true
                        isFocusable = true
                        isFocusableInTouchMode = true
                        termView = this
                        host.view = this
                    }
                },
                update = { v ->
                    if (host.view !== v) host.view = v
                },
            )
            exited?.let { code ->
                Column(
                    Modifier
                        .align(Alignment.Center)
                        .background(Color(0xCC000000))
                        .padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Shell exited (status $code)", color = Color.White)
                    Button(onClick = { host.restart(); exited = null }) { Text("Restart shell") }
                }
            }
        }
        ExtraKeysRow(
            ctrl = ctrl,
            alt = alt,
            onToggleCtrl = { ctrl = !ctrl },
            onToggleAlt = { alt = !alt },
            onKey = ::sendKey,
            onText = ::sendText,
        )
    }
}

@Composable
private fun ExtraKeysRow(
    ctrl: Boolean,
    alt: Boolean,
    onToggleCtrl: () -> Unit,
    onToggleAlt: () -> Unit,
    onKey: (Int) -> Unit,
    onText: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Color(0xFF15151C))
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 4.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Key("ESC", "Escape") { onKey(KeyEvent.KEYCODE_ESCAPE) }
        Key("TAB", "Tab") { onKey(KeyEvent.KEYCODE_TAB) }
        Key("CTRL", "Control", active = ctrl, onClick = onToggleCtrl)
        Key("ALT", "Alt", active = alt, onClick = onToggleAlt)
        Key("-", "Minus") { onText("-") }
        Key("/", "Slash") { onText("/") }
        Key("|", "Pipe") { onText("|") }
        Key("~", "Tilde") { onText("~") }
        Key("HOME", "Home") { onKey(KeyEvent.KEYCODE_MOVE_HOME) }
        Key("\u2190", "Left") { onKey(KeyEvent.KEYCODE_DPAD_LEFT) }
        Key("\u2191", "Up") { onKey(KeyEvent.KEYCODE_DPAD_UP) }
        Key("\u2193", "Down") { onKey(KeyEvent.KEYCODE_DPAD_DOWN) }
        Key("\u2192", "Right") { onKey(KeyEvent.KEYCODE_DPAD_RIGHT) }
        Key("END", "End") { onKey(KeyEvent.KEYCODE_MOVE_END) }
        Key("PGUP", "Page up") { onKey(KeyEvent.KEYCODE_PAGE_UP) }
        Key("PGDN", "Page down") { onKey(KeyEvent.KEYCODE_PAGE_DOWN) }
        Key("DEL", "Delete") { onKey(KeyEvent.KEYCODE_FORWARD_DEL) }
    }
}

@Composable
private fun Key(label: String, description: String, active: Boolean = false, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier
            .height(36.dp)
            .widthIn(min = 40.dp)
            .semantics { contentDescription = description },
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp),
    ) {
        Text(
            label,
            fontSize = 13.sp,
            color = if (active) MaterialTheme.colorScheme.primary else Color(0xFFD0D0DA),
        )
    }
}

private val TERMINAL_BG = Color(0xFF0A0A0F)
private const val TERMINAL_BG_INT = 0xFF0A0A0F.toInt()
private const val DEFAULT_FONT_SP = 13
private const val MIN_FONT_SP = 7
private const val MAX_FONT_SP = 36

@Composable
private fun BootstrapInstallScreen(
    modifier: Modifier,
    context: Context,
    onInstalled: () -> Unit,
) {
    var status by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(24.dp),
        ) {
            Text("Shell environment", style = MaterialTheme.typography.titleLarge)
            Text(
                "Install the rslvd shell environment — a full Linux userland with " +
                    "pkg/apt, dpkg, netcat, nmap, dig and more, served from repo.rslvd.net. " +
                    "One-time download (~65 MB) into the app's private storage.",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (busy) {
                CircularProgressIndicator()
                Text(status ?: "Working…", style = MaterialTheme.typography.bodySmall)
            } else {
                Button(onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) {
                                BootstrapInstaller.install(context) { status = it }
                            }
                            onInstalled()
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.message ?: "Install failed"
                        } finally {
                            busy = false
                        }
                    }
                }) { Text("Install environment") }
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
