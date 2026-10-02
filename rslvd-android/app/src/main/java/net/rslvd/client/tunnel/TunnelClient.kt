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
        private const val DNS2TCP_PORT = 7200
        private const val RECONNECT_WAIT_MS = 5000L

        private const val DNS_NOOP = 0x00
        private const val DNS_DATA = 0x01
        private const val DNS_CONNECT = 0x02
        private const val DNS_CLOSE = 0x03
    }

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
                    "dns2tcp" -> runDns2Tcp(scope)
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

            onStatus("connected")
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

    // ── DNS2TCP ──────────────────────────────────────────────────────────────
    private val base32Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUV" // base32hex, no padding

    private fun encodeBase32Hex(data: ByteArray): String {
        val sb = StringBuilder()
        var buffer = 0L
        var bits = 0
        for (b in data) {
            buffer = (buffer shl 8) or (b.toLong() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                sb.append(base32Alphabet[((buffer shr bits) and 0x1f).toInt()])
            }
        }
        if (bits > 0) sb.append(base32Alphabet[((buffer shl (5 - bits)) and 0x1f).toInt()])
        return sb.toString()
    }

    private fun buildDnsQuery(txId: Int, data: ByteArray?): ByteArray {
        val qname = if (data != null && data.isNotEmpty()) {
            val encoded = encodeBase32Hex(data)
            val labels = encoded.chunked(63)
            labels.joinToString(".") + ".$token.tunnel.$SERVER_HOST"
        } else {
            "$token.tunnel.$SERVER_HOST"
        }

        val buf = ByteArray(512)
        buf[0] = (txId shr 8).toByte()
        buf[1] = (txId and 0xff).toByte()
        buf[2] = 0x01 // standard query
        buf[3] = 0x00
        buf[4] = 0x00
        buf[5] = 0x01 // 1 question
        var offset = 12
        for (label in qname.split('.')) {
            val l = if (label.length > 63) label.substring(0, 63) else label
            buf[offset++] = l.length.toByte()
            l.toByteArray().copyInto(buf, offset)
            offset += l.length
        }
        buf[offset++] = 0x00
        buf[offset++] = 0x00; buf[offset++] = 0x10 // QTYPE TXT
        buf[offset++] = 0x00; buf[offset++] = 0x01 // QCLASS IN
        return buf.copyOfRange(0, offset)
    }

    private fun runDns2Tcp(scope: CoroutineScope) {
        onStatus("connecting")
        val serverAddr = InetAddress.getByName(SERVER_HOST)
        val dns = DatagramSocket()
        dns.connect(serverAddr, DNS2TCP_PORT)

        val localConns = java.util.concurrent.ConcurrentHashMap<Int, Socket>()
        val sendQueue = java.util.concurrent.LinkedBlockingQueue<ByteArray>(64)
        var txCounter = 0

        try {
            val regQuery = buildDnsQuery(txCounter++, null)
            dns.send(DatagramPacket(regQuery, regQuery.size))
            dns.soTimeout = 5_000
            val regBuf = ByteArray(1024)
            val regPkt = DatagramPacket(regBuf, regBuf.size)
            dns.receive(regPkt)
            if (regPkt.length < 3) throw IOException("invalid registration response")
            onStatus("connected")

            // Response reader
            scope.launch(Dispatchers.IO) {
                val buf = ByteArray(65535)
                while (isActive) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        dns.soTimeout = 5_000
                        dns.receive(pkt)
                    } catch (e: SocketTimeoutException) {
                        continue
                    } catch (_: Exception) {
                        return@launch
                    }
                    if (pkt.length < 3) continue
                    val msgType = buf[2].toInt() and 0xff
                    val payload = buf.copyOfRange(3, pkt.length)
                    when (msgType) {
                        DNS_NOOP -> {}
                        DNS_CONNECT -> {
                            if (payload.size < 2) continue
                            val connId = ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)
                            val local = Socket()
                            try {
                                local.connect(InetSocketAddress(targetHost, targetPort), 5_000)
                            } catch (_: Exception) {
                                continue
                            }
                            localConns[connId] = local
                            launch(Dispatchers.IO) {
                                val readBuf = ByteArray(200) // small chunks for DNS
                                try {
                                    while (true) {
                                        val n = local.getInputStream().read(readBuf)
                                        if (n <= 0) break
                                        val msg = ByteArray(2 + n)
                                        msg[0] = (connId shr 8).toByte()
                                        msg[1] = (connId and 0xff).toByte()
                                        readBuf.copyInto(msg, 2, 0, n)
                                        sendQueue.put(msg)
                                    }
                                } catch (_: Exception) {
                                } finally {
                                    localConns.remove(connId)
                                    runCatching { local.close() }
                                }
                            }
                        }
                        DNS_DATA -> {
                            if (payload.size < 3) continue
                            val connId = ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)
                            localConns[connId]?.let {
                                runCatching { it.getOutputStream().write(payload, 2, payload.size - 2) }
                            }
                        }
                        DNS_CLOSE -> {
                            if (payload.size < 2) continue
                            val connId = ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)
                            localConns.remove(connId)?.let { runCatching { it.close() } }
                        }
                    }
                }
            }

            // Poll loop: send queued data or empty polls every 250ms
            while (scope.isActive) {
                val data = sendQueue.poll(250, java.util.concurrent.TimeUnit.MILLISECONDS)
                val query = buildDnsQuery(txCounter++ and 0xffff, data)
                dns.send(DatagramPacket(query, query.size))
            }
        } finally {
            localConns.values.forEach { runCatching { it.close() } }
            runCatching { dns.close() }
        }
    }
}
