package net.rslvd.client.shell

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * Installs the Termux-style rootfs bootstrap into <filesDir>/usr on first run.
 *
 * The bootstrap zip is produced by our termux-packages fork (prefix
 * /data/data/net.rslvd.debug/files/usr) and hosted at repo.rslvd.net together
 * with a SHA-256 checksum file. The zip contains the contents of usr/ plus a
 * SYMLINKS.txt manifest ("target←link" per line) since zip cannot carry
 * symlinks.
 */
object BootstrapInstaller {
    const val REPO_BASE = "https://repo.rslvd.net"

    fun prefixDir(context: Context): File = File(context.filesDir, "usr")
    fun homeDir(context: Context): File = File(context.filesDir, "home")

    fun isInstalled(context: Context): Boolean =
        File(prefixDir(context), ".bootstrap-installed").exists()

    private fun archName(): String {
        val abis = android.os.Build.SUPPORTED_ABIS
        return when {
            abis.contains("arm64-v8a") -> "aarch64"
            abis.contains("x86_64") -> "x86_64"
            abis.contains("armeabi-v7a") -> "arm"
            else -> abis.firstOrNull() ?: "unknown"
        }
    }

    fun bootstrapUrl(): String = "$REPO_BASE/bootstraps/bootstrap-${archName()}.zip"

    /**
     * Downloads, verifies and extracts the bootstrap. Reports progress via
     * [onStatus]. Throws on failure; a partial install is cleaned up so a
     * retry starts fresh.
     */
    fun install(context: Context, onStatus: (String) -> Unit) {
        val prefix = prefixDir(context)
        val staging = File(context.filesDir, "usr-staging")
        val zipFile = File(context.cacheDir, "bootstrap.zip")
        var step = "prepare"

        try {
            if (staging.exists()) staging.deleteRecursively()
            if (!staging.mkdirs() && !staging.isDirectory) {
                throw IllegalStateException("Cannot create ${staging.path}")
            }
            homeDir(context).mkdirs()

            val url = bootstrapUrl()
            step = "download"
            onStatus("Downloading bootstrap (${archName()})…")
            download(url, zipFile, onStatus)

            step = "verify"
            onStatus("Verifying checksum…")
            val expected = fetchText("$url.sha256").trim().split(Regex("\\s+")).first()
            val actual = sha256(zipFile)
            if (!expected.equals(actual, ignoreCase = true)) {
                throw IllegalStateException("Checksum mismatch — download corrupted")
            }

            step = "extract"
            onStatus("Extracting…")
            extract(zipFile, staging, onStatus)
            zipFile.delete()

            step = "finish"
            onStatus("Finishing install…")
            if (prefix.exists()) prefix.deleteRecursively()
            if (!staging.renameTo(prefix)) {
                throw IllegalStateException("Could not move bootstrap into place")
            }
            File(prefix, "tmp").mkdirs()
            writeSources(File(prefix, "etc/apt/sources.list"))

            step = "check"
            onStatus("Checking shell…")
            selfCheck(context)

            File(prefix, ".bootstrap-installed").writeText("ok")
            onStatus("Environment installed")
        } catch (e: Exception) {
            Log.e(TAG, "bootstrap install failed at $step", e)
            zipFile.delete()
            staging.deleteRecursively()
            if (step == "check") prefix.deleteRecursively()
            throw IllegalStateException("[$step] ${describe(e)}", e)
        }
    }

    private const val TAG = "BootstrapInstaller"

    private fun describe(e: Throwable): String {
        val sb = StringBuilder()
        var cur: Throwable? = e
        var first = true
        while (cur != null && sb.length < 600) {
            if (!first) sb.append(" ← ")
            sb.append(cur.javaClass.simpleName)
            cur.message?.let { sb.append(": ").append(it) }
            first = false
            cur = cur.cause?.takeIf { it !== cur }
        }
        return sb.toString()
    }

    /**
     * Point apt at our repo. Release files are GPG-signed; the public key ships
     * in rslvd-keyring (etc/apt/trusted.gpg.d/rslvd-repo.gpg) inside the bootstrap.
     */
    private fun writeSources(file: File) {
        file.parentFile?.mkdirs()
        file.writeText(
            "# rslvd package repository (binaries built for /data/data/net.rslvd.debug/files/usr)\n" +
                "deb $REPO_BASE/apt/rslvd-main stable main\n"
        )
    }

    /** Runs the installed shell once so exec problems surface at install time. */
    private fun selfCheck(context: Context) {
        val prefix = prefixDir(context)
        val sh = listOf("bin/bash", "bin/sh", "bin/dash").map { File(prefix, it) }.firstOrNull { it.exists() }
            ?: throw IllegalStateException("No shell found in ${prefix.path}/bin")
        val pb = ProcessBuilder(sh.absolutePath, "-c", "echo rslvd-ok").redirectErrorStream(true)
        pb.directory(homeDir(context))
        pb.environment().putAll(environment(context))
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText().trim()
        val code = p.waitFor()
        if (code != 0 || !out.contains("rslvd-ok")) {
            throw IllegalStateException("${sh.name} exited $code: ${out.take(300)}")
        }
    }

    private fun download(url: String, dest: File, onStatus: (String) -> Unit) {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        try {
            if (conn.responseCode != 200) {
                throw IllegalStateException("Download failed: HTTP ${conn.responseCode}")
            }
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            onStatus("Downloading… ${done * 100 / total}%")
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun fetchText(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            if (conn.responseCode != 200) {
                throw IllegalStateException("Fetch failed: HTTP ${conn.responseCode} for $url")
            }
            return conn.inputStream.bufferedReader().readText()
        } finally {
            conn.disconnect()
        }
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun extract(zipFile: File, destDir: File, onStatus: (String) -> Unit) {
        val destPath = destDir.canonicalPath + File.separator
        val symlinks = mutableListOf<Pair<String, String>>()
        var count = 0
        ZipInputStream(zipFile.inputStream().buffered()).use { zis ->
            while (true) {
                val entry = zis.nextEntry ?: break
                val name = entry.name.removePrefix("./")
                if (name.isEmpty()) continue
                if (name == "SYMLINKS.txt") {
                    String(zis.readBytes(), Charsets.UTF_8).lines().forEach { line ->
                        val idx = line.indexOf('←')
                        if (idx > 0 && idx < line.length - 1) {
                            symlinks.add(line.substring(0, idx) to line.substring(idx + 1))
                        }
                    }
                    continue
                }
                val out = File(destDir, name)
                if (!out.canonicalPath.startsWith(destPath)) {
                    throw SecurityException("Blocked zip path traversal: ${entry.name}")
                }
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zis.copyTo(it) }
                    // Zip loses unix permissions; make everything owner rwx so
                    // binaries, scripts and apt helpers are executable.
                    try {
                        Os.chmod(out.absolutePath, 448) // 0700
                    } catch (e: ErrnoException) {
                        Log.w(TAG, "chmod ${out.path}: ${e.message}")
                    }
                }
                if (++count % 500 == 0) onStatus("Extracting… $count files")
            }
        }
        onStatus("Creating ${symlinks.size} symlinks…")
        for ((target, link) in symlinks) {
            val linkFile = File(destDir, link.removePrefix("./"))
            val parent = linkFile.parentFile ?: continue
            if (!parent.canonicalPath.plus(File.separator).startsWith(destPath)) continue
            parent.mkdirs()
            if (linkFile.exists() || isSymlink(linkFile)) {
                if (linkFile.isDirectory && !isSymlink(linkFile)) linkFile.deleteRecursively() else linkFile.delete()
            }
            try {
                Os.symlink(target, linkFile.absolutePath)
            } catch (e: ErrnoException) {
                Log.w(TAG, "symlink $link -> $target: ${e.message}")
            }
        }
    }

    private fun isSymlink(f: File): Boolean = try {
        OsConstants.S_ISLNK(Os.lstat(f.absolutePath).st_mode)
    } catch (_: ErrnoException) {
        false
    }

    /** Environment for processes running inside the bootstrap. */
    fun environment(context: Context): Map<String, String> {
        val prefix = prefixDir(context).absolutePath
        val env = mutableMapOf(
            "PREFIX" to prefix,
            "HOME" to homeDir(context).absolutePath,
            "PATH" to "$prefix/bin:$prefix/bin/applets",
            "TMPDIR" to "$prefix/tmp",
            "LANG" to "en_US.UTF-8",
            "TERM" to "xterm-256color",
            "ANDROID_DATA" to (System.getenv("ANDROID_DATA") ?: "/data"),
            "ANDROID_ROOT" to (System.getenv("ANDROID_ROOT") ?: "/system"),
            "TERMUX_APP_PID" to android.os.Process.myPid().toString(),
        )
        listOf("lib/libtermux-exec-ld-preload.so", "lib/libtermux-exec.so")
            .map { File(prefix, it) }
            .firstOrNull { it.exists() }
            ?.let { env["LD_PRELOAD"] = it.absolutePath }
        return env
    }
}
