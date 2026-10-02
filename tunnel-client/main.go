package main

import (
	"context"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	serverHost    = "rslvd.net"
	
	// TCP ports
	tcpControlPort   = "7000"
	tcpDataPort      = "7001"
	
	// UDP ports
	udpControlPort   = "7100"
	udpDataPort      = "7101"
	
	// DNS2TCP port
	dns2tcpPort      = "7200"
	
	reconnectWait = 5 * time.Second
	version       = "1.3.0"
)

var deviceNameRe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// deviceID returns a stable fingerprint for this machine, used by the server's
// optional device-lock feature. Derived from the OS machine id (when available)
// plus the hostname — never leaves raw identifiers, only a hash.
func deviceID() string {
	var seed string
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil {
			seed = strings.TrimSpace(string(b))
			break
		}
	}
	host, _ := os.Hostname()
	if seed == "" {
		seed = host + "|" + os.Getenv("USER") + os.Getenv("USERNAME")
	}
	sum := sha256.Sum256([]byte("rslvd-device|" + seed + "|" + host))
	return hex.EncodeToString(sum[:16])
}

func deviceName() string {
	host, _ := os.Hostname()
	name := deviceNameRe.ReplaceAllString(host, "-")
	if len(name) > 40 {
		name = name[:40]
	}
	if name == "" {
		name = "unknown"
	}
	return name
}

type TunnelMode string

const (
	ModeTCP     TunnelMode = "tcp"
	ModeUDP     TunnelMode = "udp"
	ModeDNS2TCP TunnelMode = "dns2tcp"
)

// resolveHost resolves a hostname using the system resolver, falling back to
// public DNS (8.8.8.8:53) if the system resolver fails.
func resolveHost(host string) (string, error) {
	addrs, err := net.DefaultResolver.LookupHost(context.Background(), host)
	if err == nil && len(addrs) > 0 {
		return addrs[0], nil
	}
	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			return net.DialTimeout("udp", "8.8.8.8:53", 3*time.Second)
		},
	}
	addrs, err2 := r.LookupHost(context.Background(), host)
	if err2 != nil {
		return "", fmt.Errorf("DNS lookup failed (system: %v; fallback: %v)", err, err2)
	}
	if len(addrs) == 0 {
		return "", fmt.Errorf("DNS lookup returned no addresses for %s", host)
	}
	return addrs[0], nil
}

// dialServer dials host:port using resolveHost.
func dialServer(host, port string, timeout time.Duration) (net.Conn, error) {
	ip, err := resolveHost(host)
	if err != nil {
		return nil, err
	}
	return net.DialTimeout("tcp", ip+":"+port, timeout)
}

func usage() {
	fmt.Fprintf(os.Stderr, "rslvd-tunnel v%s - Multi-protocol tunnel client\n\n", version)
	fmt.Fprintf(os.Stderr, "Usage:\n")
	fmt.Fprintf(os.Stderr, "  TCP:     rslvd-tunnel <token> <local_port>\n")
	fmt.Fprintf(os.Stderr, "  UDP:     rslvd-tunnel -udp <token> <local_port>\n")
	fmt.Fprintf(os.Stderr, "  DNS2TCP: rslvd-tunnel -dns <token> <local_port>\n\n")
	fmt.Fprintf(os.Stderr, "Examples:\n")
	fmt.Fprintf(os.Stderr, "  rslvd-tunnel abc123 8080          # TCP tunnel\n")
	fmt.Fprintf(os.Stderr, "  rslvd-tunnel -udp abc123 53       # UDP tunnel (DNS)\n")
	fmt.Fprintf(os.Stderr, "  rslvd-tunnel -dns abc123 22       # DNS2TCP tunnel (SSH over DNS)\n\n")
	fmt.Fprintf(os.Stderr, "Get your token from: https://rslvd.net/dashboard\n")
	os.Exit(1)
}

func log(format string, args ...interface{}) {
	ts := time.Now().Format("15:04:05")
	fmt.Printf("[%s] %s\n", ts, fmt.Sprintf(format, args...))
}

func readLine(conn net.Conn, timeout time.Duration) (string, error) {
	conn.SetReadDeadline(time.Now().Add(timeout))
	defer conn.SetReadDeadline(time.Time{})
	var line []byte
	buf := make([]byte, 1)
	for {
		_, err := conn.Read(buf)
		if err != nil {
			return "", err
		}
		if buf[0] == '\n' {
			break
		}
		line = append(line, buf[0])
	}
	return strings.TrimRight(string(line), "\r"), nil
}

// ==================== TCP TUNNEL ====================

func connectTCPControl(token string) (net.Conn, error) {
	conn, err := dialServer(serverHost, tcpControlPort, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s:%s — %w", serverHost, tcpControlPort, err)
	}

	fmt.Fprintf(conn, "HELLO %s %s %s\n", token, deviceID(), deviceName())

	line, err := readLine(conn, 10*time.Second)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("no response from server: %w", err)
	}

	if strings.HasPrefix(line, "ERR ") {
		conn.Close()
		return nil, fmt.Errorf("server error: %s", strings.TrimPrefix(line, "ERR "))
	}
	if !strings.HasPrefix(strings.TrimSpace(line), "OK") {
		conn.Close()
		return nil, fmt.Errorf("unexpected server response: %s", line)
	}

	return conn, nil
}

func handleTCPData(token, localPort string) {
	serverConn, err := dialServer(serverHost, tcpDataPort, 10*time.Second)
	if err != nil {
		log("Data connection failed: %v", err)
		return
	}

	fmt.Fprintf(serverConn, "DATA %s\n", token)

	ack, err := readLine(serverConn, 5*time.Second)
	if err != nil || strings.TrimSpace(ack) != "GO" {
		serverConn.Close()
		return
	}

	localConn, err := net.DialTimeout("tcp", "localhost:"+localPort, 5*time.Second)
	if err != nil {
		log("Cannot reach localhost:%s — is your service running?", localPort)
		serverConn.Close()
		return
	}

	go func() {
		defer serverConn.Close()
		defer localConn.Close()
		io.Copy(serverConn, localConn)
	}()
	go func() {
		defer serverConn.Close()
		defer localConn.Close()
		io.Copy(localConn, serverConn)
	}()
}

func runTCPTunnel(token, localPort string) error {
	log("Connecting TCP tunnel to rslvd.net...")
	conn, err := connectTCPControl(token)
	if err != nil {
		return err
	}
	defer conn.Close()

	log("✓ TCP Tunnel active!")
	log("  Local:   localhost:%s", localPort)
	log("  (Ctrl+C to stop)")

	for {
		line, err := readLine(conn, 60*time.Second)

		if err != nil {
			if err == io.EOF {
				return fmt.Errorf("server closed connection")
			}
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				_, werr := fmt.Fprintf(conn, "PING\n")
				if werr != nil {
					return fmt.Errorf("keepalive failed: %w", werr)
				}
				continue
			}
			return fmt.Errorf("connection lost: %w", err)
		}

		switch {
		case line == "CONNECT":
			go handleTCPData(token, localPort)
		case line == "PONG":
			// keepalive ack
		case strings.HasPrefix(line, "ERR "):
			return fmt.Errorf("server: %s", strings.TrimPrefix(line, "ERR "))
		}
	}
}

// ==================== UDP TUNNEL ====================

func runUDPTunnel(token, localPort string) error {
	log("Connecting UDP tunnel to rslvd.net...")

	serverIP, err := resolveHost(serverHost)
	if err != nil {
		return err
	}

	// Control socket for registration
	controlConn, err := net.Dial("udp", serverIP+":"+udpControlPort)
	if err != nil {
		return fmt.Errorf("cannot connect UDP control: %w", err)
	}
	defer controlConn.Close()

	// Send registration
	controlConn.Write([]byte("HELLO " + token + " " + deviceID() + " " + deviceName() + "\n"))

	// Wait for OK
	buf := make([]byte, 1024)
	controlConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := controlConn.Read(buf)
	if err != nil {
		return fmt.Errorf("registration timeout: %w", err)
	}

	response := strings.TrimSpace(string(buf[:n]))
	if !strings.HasPrefix(response, "OK") {
		return fmt.Errorf("registration failed: %s", response)
	}

	log("✓ UDP Tunnel registered!")
	log("  Local UDP: localhost:%s", localPort)

	// Data socket for packet relay
	dataConn, err := net.Dial("udp", serverIP+":"+udpDataPort)
	if err != nil {
		return fmt.Errorf("cannot connect UDP data: %w", err)
	}
	defer dataConn.Close()

	// Authenticate on data port
	dataConn.Write([]byte("DATA " + token + "\n"))

	// Wait for GO
	dataConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err = dataConn.Read(buf)
	if err != nil {
		return fmt.Errorf("data port auth timeout: %w", err)
	}
	dataResp := strings.TrimSpace(string(buf[:n]))
	if dataResp != "GO" {
		return fmt.Errorf("data port auth failed: %s", dataResp)
	}
	dataConn.SetReadDeadline(time.Time{})

	log("  Data channel ready")

	// Local UDP address
	localAddr, err := net.ResolveUDPAddr("udp", "localhost:"+localPort)
	if err != nil {
		return fmt.Errorf("cannot resolve local address: %w", err)
	}

	// Relay packets: server -> local -> server
	// Server sends framed packets: [4 bytes sender IP][2 bytes sender port][payload]
	// We strip the header, forward to local, then prepend the header to the response
	go func() {
		recvBuf := make([]byte, 65535)
		for {
			n, err := dataConn.Read(recvBuf)
			if err != nil {
				log("UDP server read error: %v", err)
				return
			}
			if n < 7 {
				continue
			}

			// Extract sender header (6 bytes) and payload
			header := make([]byte, 6)
			copy(header, recvBuf[:6])
			payload := recvBuf[6:n]

			// Forward payload to local service
			localConn, err := net.DialUDP("udp", nil, localAddr)
			if err != nil {
				log("Cannot reach localhost:%s: %v", localPort, err)
				continue
			}

			localConn.Write(payload)

			// Read response from local service (with timeout)
			localConn.SetReadDeadline(time.Now().Add(3 * time.Second))
			respBuf := make([]byte, 65535)
			rn, err := localConn.Read(respBuf)
			localConn.Close()
			if err != nil {
				continue
			}

			// Send response back to server with sender header prepended
			framed := append(header, respBuf[:rn]...)
			dataConn.Write(framed)
		}
	}()

	// Keepalive on control socket
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			controlConn.Write([]byte("PING\n"))
		}
	}
}

// ==================== DNS2TCP TUNNEL ====================
//
// DNS2TCP reverse tunnel protocol:
//   Client → Server: DNS query with QNAME = <base32data>.<token>.tunnel.rslvd.net
//   Server → Client: [txId 2B][type 1B][payload...]
//     type 0x00 = NOOP (no pending data)
//     type 0x01 = DATA (rest is [connId 2B][tcp data...])
//     type 0x02 = CONNECT (new public connection [connId 2B])
//     type 0x03 = CLOSE (public connection closed [connId 2B])
//
// Client sends response data with: [connId 2B][payload...] encoded in DNS query

const (
	dnsNoop    = 0x00
	dnsData    = 0x01
	dnsConnect = 0x02
	dnsClose   = 0x03
)

// encodeDataToDNS encodes binary data into DNS-safe base32 subdomain
func encodeDataToDNS(data []byte) string {
	return base32.HexEncoding.WithPadding(base32.NoPadding).EncodeToString(data)
}

// buildDNSQuery builds a DNS query packet with optional data payload
func buildDNSQuery(token string, txId uint16, data []byte) []byte {
	// Build query name: [<data>.]<token>.tunnel.rslvd.net
	var qname string
	if data != nil && len(data) > 0 {
		encoded := encodeDataToDNS(data)
		// Split into 63-char labels (DNS label max length)
		var labels []string
		for len(encoded) > 63 {
			labels = append(labels, encoded[:63])
			encoded = encoded[63:]
		}
		if len(encoded) > 0 {
			labels = append(labels, encoded)
		}
		qname = strings.Join(labels, ".") + "." + token + ".tunnel." + serverHost
	} else {
		qname = token + ".tunnel." + serverHost
	}

	buf := make([]byte, 512)

	// Transaction ID
	buf[0] = byte(txId >> 8)
	buf[1] = byte(txId & 0xff)

	// Flags: Standard query
	buf[2] = 0x01
	buf[3] = 0x00

	// Questions: 1
	buf[4] = 0x00
	buf[5] = 0x01

	// Answer/Authority/Additional RRs: 0
	buf[6] = 0x00
	buf[7] = 0x00
	buf[8] = 0x00
	buf[9] = 0x00
	buf[10] = 0x00
	buf[11] = 0x00

	offset := 12

	// QNAME labels
	labels := strings.Split(qname, ".")
	for _, label := range labels {
		if len(label) > 63 {
			label = label[:63]
		}
		buf[offset] = byte(len(label))
		offset++
		copy(buf[offset:], label)
		offset += len(label)
	}
	buf[offset] = 0x00
	offset++

	// QTYPE: TXT (16)
	buf[offset] = 0x00
	buf[offset+1] = 0x10
	offset += 2

	// QCLASS: IN (1)
	buf[offset] = 0x00
	buf[offset+1] = 0x01
	offset += 2

	return buf[:offset]
}

func runDNS2TCPTunnel(token, localPort string) error {
	log("Connecting DNS2TCP tunnel to rslvd.net...")
	log("Note: DNS2TCP has limited bandwidth (~500 B/poll, latency depends on poll rate)")

	serverIP, err := resolveHost(serverHost)
	if err != nil {
		return err
	}

	// DNS socket
	dnsConn, err := net.Dial("udp", serverIP+":"+dns2tcpPort)
	if err != nil {
		return fmt.Errorf("cannot connect DNS2TCP server: %w", err)
	}
	defer dnsConn.Close()

	// Register with initial poll (no data)
	var txCounter uint16
	query := buildDNSQuery(token, txCounter, nil)
	txCounter++
	dnsConn.Write(query)

	// Wait for response to confirm registration
	regBuf := make([]byte, 1024)
	dnsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := dnsConn.Read(regBuf)
	if err != nil {
		return fmt.Errorf("registration timeout: %w", err)
	}
	if n < 3 {
		return fmt.Errorf("invalid registration response")
	}
	dnsConn.SetReadDeadline(time.Time{})

	log("✓ DNS2TCP Tunnel active!")
	log("  Local TCP: localhost:%s", localPort)
	log("  (Polling server for connections...)")

	// Local connections: connId -> net.Conn
	localConns := make(map[uint16]net.Conn)
	sendCh := make(chan []byte, 64) // Data to send to server: [connId 2B][payload...]

	// Poll loop — sends queries and processes responses
	pollInterval := 250 * time.Millisecond
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	// Response reader goroutine
	go func() {
		buf := make([]byte, 65535)
		for {
			dnsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
			n, err := dnsConn.Read(buf)
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					continue
				}
				log("DNS read error: %v", err)
				return
			}
			if n < 3 {
				continue
			}

			// Parse response: [txId 2B][type 1B][payload...]
			msgType := buf[2]
			payload := buf[3:n]

			switch msgType {
			case dnsNoop:
				// Nothing pending

			case dnsConnect:
				// New public connection: payload = [connId 2B]
				if len(payload) < 2 {
					continue
				}
				connId := uint16(payload[0])<<8 | uint16(payload[1])
				// Connect to local service
				lc, err := net.DialTimeout("tcp", "localhost:"+localPort, 5*time.Second)
				if err != nil {
					log("Cannot connect to localhost:%s for conn %d: %v", localPort, connId, err)
					continue
				}
				localConns[connId] = lc
				log("  New connection #%d → localhost:%s", connId, localPort)

				// Read from local and queue for sending
				go func(id uint16, conn net.Conn) {
					readBuf := make([]byte, 200) // Small chunks for DNS
					for {
						rn, err := conn.Read(readBuf)
						if err != nil {
							delete(localConns, id)
							conn.Close()
							return
						}
						// Prepend connId
						msg := make([]byte, 2+rn)
						msg[0] = byte(id >> 8)
						msg[1] = byte(id & 0xff)
						copy(msg[2:], readBuf[:rn])
						sendCh <- msg
					}
				}(connId, lc)

			case dnsData:
				// Data from public connection: payload = [connId 2B][data...]
				if len(payload) < 3 {
					continue
				}
				connId := uint16(payload[0])<<8 | uint16(payload[1])
				data := payload[2:]
				if lc, ok := localConns[connId]; ok {
					lc.Write(data)
				}

			case dnsClose:
				// Public connection closed: payload = [connId 2B]
				if len(payload) < 2 {
					continue
				}
				connId := uint16(payload[0])<<8 | uint16(payload[1])
				if lc, ok := localConns[connId]; ok {
					lc.Close()
					delete(localConns, connId)
				}
			}
		}
	}()

	// Main loop: poll and send queued data
	for {
		select {
		case <-ticker.C:
			// Send poll or queued data
			select {
			case data := <-sendCh:
				query := buildDNSQuery(token, txCounter, data)
				txCounter++
				dnsConn.Write(query)
			default:
				// Empty poll
				query := buildDNSQuery(token, txCounter, nil)
				txCounter++
				dnsConn.Write(query)
			}
		case data := <-sendCh:
			// Data ready to send — send immediately
			query := buildDNSQuery(token, txCounter, data)
			txCounter++
			dnsConn.Write(query)
		}
	}
}

// ==================== MAIN ====================

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Printf("rslvd-tunnel v%s\n", version)
		os.Exit(0)
	}
	
	if len(os.Args) < 3 {
		usage()
	}
	
	mode := ModeTCP
	token := ""
	localPort := ""
	argIdx := 1
	
	// Parse flags
	if os.Args[argIdx] == "-udp" {
		mode = ModeUDP
		argIdx++
	} else if os.Args[argIdx] == "-dns" || os.Args[argIdx] == "-dns2tcp" {
		mode = ModeDNS2TCP
		argIdx++
	}
	
	if len(os.Args) < argIdx+2 {
		usage()
	}
	
	token = os.Args[argIdx]
	localPort = os.Args[argIdx+1]
	
	if token == "" || localPort == "" {
		usage()
	}
	
	log("rslvd-tunnel v%s - Mode: %s", version, mode)

	attempt := 0
	for {
		attempt++
		if attempt > 1 {
			log("Reconnecting in %v... (attempt %d)", reconnectWait, attempt)
			time.Sleep(reconnectWait)
		}

		var err error
		switch mode {
		case ModeTCP:
			err = runTCPTunnel(token, localPort)
		case ModeUDP:
			err = runUDPTunnel(token, localPort)
		case ModeDNS2TCP:
			err = runDNS2TCPTunnel(token, localPort)
		}
		
		if err != nil {
			log("Disconnected: %v", err)
		}
	}
}
