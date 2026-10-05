package net.rslvd.client.shell

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import java.io.File

/**
 * Owns the single PTY-backed /system/bin/sh session for the app. The session outlives
 * the Shell tab's composition so switching tabs does not kill running programs;
 * a [TerminalView] attaches/detaches as the UI comes and goes.
 */
class TerminalHost private constructor(private val app: Context) : TerminalSessionClient {

    private val main = Handler(Looper.getMainLooper())

    /** The view currently displaying the session, if any. */
    var view: TerminalView? = null
        set(value) {
            field = value
            value?.attachSession(session)
        }

    var onFinished: ((exitStatus: Int) -> Unit)? = null

    var session: TerminalSession = create()
        private set

    fun restart() {
        session.finishIfRunning()
        session = create()
        view?.attachSession(session)
        view?.onScreenUpdated()
    }

    private fun create(): TerminalSession {
        val shell = "/system/bin/sh"
        val cwd = app.filesDir.absolutePath
        val env = sandboxEnvironment()
        File(cwd).mkdirs()
        env["COLORTERM"] = "truecolor"
        env["RSLVD_BANNER"] = BANNER
        val envArray = env.map { (k, v) -> "$k=$v" }.toTypedArray()
        // Print the banner, then become the interactive shell (keeps the PTY as pid's stdio).
        val args = arrayOf(shell, "-c", "printf '%s' \"\$RSLVD_BANNER\"; unset RSLVD_BANNER; exec \"$shell\"")
        return TerminalSession(shell, cwd, args, envArray, TRANSCRIPT_ROWS, this)
    }

    private fun sandboxEnvironment(): MutableMap<String, String> {
        val home = app.filesDir.absolutePath
        val env = mutableMapOf(
            "HOME" to home,
            "TMPDIR" to app.cacheDir.absolutePath,
            "PATH" to "/system/bin:/system/xbin",
            "TERM" to "xterm-256color",
            "LANG" to "en_US.UTF-8",
        )
        for (k in PASSTHROUGH) System.getenv(k)?.let { env[k] = it }
        return env
    }

    // ---- TerminalSessionClient ----

    override fun onTextChanged(changedSession: TerminalSession) {
        view?.onScreenUpdated()
    }

    override fun onTitleChanged(changedSession: TerminalSession) {}

    override fun onSessionFinished(finishedSession: TerminalSession) {
        val status = finishedSession.exitStatus
        main.post { onFinished?.invoke(status) }
    }

    override fun onCopyTextToClipboard(session: TerminalSession, text: String?) {
        if (text.isNullOrEmpty()) return
        val cm = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("rslvd shell", text))
    }

    override fun onPasteTextFromClipboard(session: TerminalSession?) {
        val cm = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = cm.primaryClip?.getItemAt(0)?.coerceToText(app)?.toString() ?: return
        session?.emulator?.paste(text)
    }

    override fun onBell(session: TerminalSession) {}

    override fun onColorsChanged(session: TerminalSession) {
        view?.onScreenUpdated()
    }

    override fun onTerminalCursorStateChange(state: Boolean) {
        view?.setTerminalCursorBlinkerState(state, true)
    }

    override fun setTerminalShellPid(session: TerminalSession, pid: Int) {}

    override fun getTerminalCursorStyle(): Int = TerminalEmulator.DEFAULT_TERMINAL_CURSOR_STYLE

    override fun logError(tag: String?, message: String?) { Log.e(tag ?: TAG, message ?: "") }
    override fun logWarn(tag: String?, message: String?) { Log.w(tag ?: TAG, message ?: "") }
    override fun logInfo(tag: String?, message: String?) { Log.i(tag ?: TAG, message ?: "") }
    override fun logDebug(tag: String?, message: String?) { Log.d(tag ?: TAG, message ?: "") }
    override fun logVerbose(tag: String?, message: String?) { Log.v(tag ?: TAG, message ?: "") }
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {
        Log.e(tag ?: TAG, message ?: "", e)
    }
    override fun logStackTrace(tag: String?, e: Exception?) { Log.e(tag ?: TAG, "", e) }

    companion object {
        private const val TAG = "TerminalHost"
        private const val TRANSCRIPT_ROWS = 4000
        private const val BANNER = "rslvd shell \u2014 /system/bin/sh (app sandbox)\n" +
            "Try: ping -c 4 rslvd.net \u00b7 ip addr \u00b7 netstat \u00b7 getprop\n" +
            "Want bash, pkg/apt, nmap, nano\u2026? Get rslvd Terminal: https://rslvd.net/rslvd-terminal.apk\n\n"

        private val PASSTHROUGH = listOf(
            "ANDROID_DATA", "ANDROID_ROOT", "ANDROID_ART_ROOT", "ANDROID_I18N_ROOT",
            "ANDROID_RUNTIME_ROOT", "ANDROID_TZDATA_ROOT", "BOOTCLASSPATH",
            "DEX2OATBOOTCLASSPATH", "EXTERNAL_STORAGE",
        )

        @Volatile
        private var instance: TerminalHost? = null

        fun get(context: Context): TerminalHost =
            instance ?: synchronized(this) {
                instance ?: TerminalHost(context.applicationContext).also { instance = it }
            }
    }
}
