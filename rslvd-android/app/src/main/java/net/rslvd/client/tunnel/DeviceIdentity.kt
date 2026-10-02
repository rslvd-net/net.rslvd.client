package net.rslvd.client.tunnel

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.security.MessageDigest

/**
 * Stable device fingerprint used by the server's optional device-lock feature.
 * Hashes ANDROID_ID so the raw identifier never leaves the device.
 */
object DeviceIdentity {

    fun id(context: Context): String {
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
        val seed = "rslvd-device|$androidId|${Build.MODEL}"
        val digest = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray())
        return digest.take(16).joinToString("") { "%02x".format(it) }
    }

    fun name(): String {
        val raw = "${Build.MANUFACTURER}-${Build.MODEL}"
        val cleaned = raw.replace(Regex("[^A-Za-z0-9._-]"), "-")
        return cleaned.take(40).ifEmpty { "android" }
    }
}
