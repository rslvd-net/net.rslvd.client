package net.rslvd.client.tunnel

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * Kotlin port of the rslvd-tunnel Go client. Establishes a reverse tunnel to
 * rslvd.net so a service reachable from this device (targetHost:targetPort)
 * is exposed on the tunnel's public subdomain.
 */
class TunnelClient(
    private val token: String,
    private val targetHost: String,
    private val targetPort: Int,
    private val protocol: String,
    private val deviceId: String,
    private val deviceName: String,
    private val onStatus: (String) -> Unit,
) {
    companion object {
        private const val SERVER_HOST = "rslvd.net"
        private const val TCP_CONTROL_PORT = 7000
        private const val TCP_DATA_PORT = 7001
        private const val UDP_CONTROL_PORT = 7100
        private const val UDP_DATA_PORT = 7101
        private const val RECONNECT_WAIT_MS = 5000L

        /** Remote-access protocols (premium): a real public port carries the tunnel. */
        fun isRemoteProtocol(protocol: String?): Boolean =
            protocol?.lowercase() in setOf("ssh", "adb")
    }

    /** Public port reported by the server for SSH/ADB tunnels ("OK <port>"). */
    private var publicPort: String? = null

    suspend fun run(scope: CoroutineScope) = withContext(Dispatchers.IO) {
        var attempt = 0
        while (scope.isActive) {
            attempt++
            if (attempt > 1) {
                onStatus("reconnecting")
                delay(RECONNECT_WAIT_MS)
            }
            try {
                when (protocol.lowercase()) {
                    "udp" -> runUdp(scope)
                    // ssh/adb ride the same TCP transport as plain tunnels, but the
                    // server binds a real public port and reports it back.
                    else -> runTcp(scope)
                }
            } catch (e: Exception) {
                ensureActive()
                onStatus("disconnected: ${e.message?.take(60)}")
            }
        }
    }

    private fun readLine(socket: Socket, timeoutMs: Int): String {
        socket.soTimeout = timeoutMs
        val sb = StringBuilder()
        val input = socket.getInputStream()
        while (true) {
            val b = input.read()
            if (b == -1) throw IOException("server closed connection")
            if (b == '\n'.code) break
            sb.append(b.toInt().toChar())
        }
        return sb.toString().trimEnd('\r')
    }

    private fun Socket.writeLine(line: String) {
        getOutputStream().apply {
            write((line + "\n").toByteArray())
            flush()
        }
    }

    // ── TCP ──────────────────────────────────────────────────────────────────
    private fun runTcp(scope: CoroutineScope) {
        onStatus("connecting")
        val control = Socket()
        control.connect(InetSocketAddress(SERVER_HOST, TCP_CONTROL_PORT), 10_000)
        control.use { conn ->
            conn.writeLine("HELLO $token $deviceId $deviceName")
            val resp = readLine(conn, 10_000)
            if (resp.startsWith("ERR ")) throw IOException(resp.removePrefix("ERR "))
            if (!resp.trim().startsWith("OK")) throw IOException("unexpected response: $resp")

            publicPort = resp.trim().split(" ").getOrNull(1)
            onStatus(
                if (isRemoteProtocol(protocol) && publicPort != null)
                    "connected · $SERVER_HOST${':' + publicPort}"
                else "connected"
            )
            while (scope.isActive) {
                val line = try {
                    readLine(conn, 60_000)
                } catch (e: SocketTimeoutException) {
                    conn.writeLine("PING")
                    continue
                }
                when {
                    line == "CONNECT" -> scope.launch(Dispatchers.IO) { handleTcpData() }
                    line == "PONG" -> {}
                    line.startsWith("ERR ") -> throw IOException(line.removePrefix("ERR "))
                }
            }
        }
    }

    private fun handleTcpData() {
        val server = Socket()
        try {
            server.connect(InetSocketAddress(SERVER_HOST, TCP_DATA_PORT), 10_000)
            server.writeLine("DATA $token")
            val ack = readLine(server, 5_000)
            if (ack.trim() != "GO") {
                server.close()
                return
            }
            server.soTimeout = 0

            val local = Socket()
            try {
                local.connect(InetSocketAddress(targetHost, targetPort), 5_000)
            } catch (e: Exception) {
                onStatus("cannot reach $targetHost:$targetPort")
                server.close()
                return
            }

            val pump = { src: Socket, dst: Socket ->
                Thread {
                    try {
                        src.getInputStream().copyTo(dst.getOutputStream(), 16 * 1024)
                    } catch (_: Exception) {
                    } finally {
                        runCatching { src.close() }
                        runCatching { dst.close() }
                    }
                }.apply { isDaemon = true; start() }
            }
            pump(server, local)
            pump(local, server)
        } catch (_: Exception) {
            runCatching { server.close() }
        }
    }

    // ── UDP ──────────────────────────────────────────────────────────────────
    private suspend fun runUdp(scope: CoroutineScope) {
        onStatus("connecting")
        val serverAddr = InetAddress.getByName(SERVER_HOST)

        val control = DatagramSocket()
        val data = DatagramSocket()
        try {
            control.connect(serverAddr, UDP_CONTROL_PORT)
            control.sendText("HELLO $token $deviceId $deviceName")
            val reg = control.receiveText(5_000)
            if (!reg.startsWith("OK")) throw IOException("registration failed: $reg")

            data.connect(serverAddr, UDP_DATA_PORT)
            data.sendText("DATA $token")
            val go = data.receiveText(5_000)
            if (go != "GO") throw IOException("data port auth failed: $go")
            data.soTimeout = 0

            onStatus("connected")
            val localAddr = InetAddress.getByName(targetHost)

            // Relay: server -> local -> server. Frames: [6B sender header][payload]
            scope.launch(Dispatchers.IO) {
                val buf = ByteArray(65535)
                while (isActive) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        data.receive(pkt)
                    } catch (_: Exception) {
                        return@launch
                    }
                    if (pkt.length < 7) continue
                    val header = buf.copyOfRange(0, 6)
                    val payload = buf.copyOfRange(6, pkt.length)

                    launch(Dispatchers.IO) {
                        try {
                            DatagramSocket().use { local ->
                                local.connect(localAddr, targetPort)
                                local.send(DatagramPacket(payload, payload.size))
                                local.soTimeout = 3_000
                                val respBuf = ByteArray(65535)
                                val resp = DatagramPacket(respBuf, respBuf.size)
                                local.receive(resp)
                                val framed = header + respBuf.copyOfRange(0, resp.length)
                                data.send(DatagramPacket(framed, framed.size))
                            }
                        } catch (_: Exception) {
                        }
                    }
                }
            }

            // Keepalive
            while (scope.isActive) {
                delay(30_000)
                control.sendText("PING")
            }
        } finally {
            runCatching { control.close() }
            runCatching { data.close() }
        }
    }

    private fun DatagramSocket.sendText(text: String) {
        val bytes = "$text\n".toByteArray()
        send(DatagramPacket(bytes, bytes.size))
    }

    private fun DatagramSocket.receiveText(timeoutMs: Int): String {
        soTimeout = timeoutMs
        val buf = ByteArray(1024)
        val pkt = DatagramPacket(buf, buf.size)
        receive(pkt)
        return String(buf, 0, pkt.length).trim()
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    /** Public port for remote-access tunnels (ssh/adb), when known. */
    fun publicPortOrNull(): String? = publicPort
}
