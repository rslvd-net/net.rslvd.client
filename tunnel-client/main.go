package main

import (
	"context"
	"crypto/sha256"
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
	serverHost = "rslvd.net"

	// TCP ports
	tcpControlPort = "7000"
	tcpDataPort    = "7001"

	// UDP ports
	udpControlPort = "7100"
	udpDataPort    = "7101"

	reconnectWait = 5 * time.Second
	version       = "1.4.0"
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
	ModeTCP TunnelMode = "tcp"
	ModeUDP TunnelMode = "udp"
	ModeSSH TunnelMode = "ssh" // premium: raw public port → local SSH daemon
	ModeADB TunnelMode = "adb" // premium: raw public port → local adb / adbd
)

// Remote-access modes publish a real TCP port on the server (premium feature).
func isRemoteMode(m TunnelMode) bool {
	return m == ModeSSH || m == ModeADB
}

// defaultLocalPort is used when the user omits the local port argument.
func defaultLocalPort(m TunnelMode) string {
	switch m {
	case ModeSSH:
		return "22"
	case ModeADB:
		return "5555"
	}
	return ""
}

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
	fmt.Fprintf(os.Stderr, "  TCP:  rslvd-tunnel <token> <local_port>\n")
	fmt.Fprintf(os.Stderr, "  UDP:  rslvd-tunnel -udp <token> <local_port>\n")
	fmt.Fprintf(os.Stderr, "  SSH:  rslvd-tunnel -ssh <token> [local_port]   (premium, default 22)\n")
	fmt.Fprintf(os.Stderr, "  ADB:  rslvd-tunnel -adb <token> [local_port]   (premium, default 5555)\n\n")
	fmt.Fprintf(os.Stderr, "Remote access (SSH/ADB) publishes a real TCP port on rslvd.net, so any\n")
	fmt.Fprintf(os.Stderr, "SSH or ADB client can reach this machine from anywhere:\n\n")
	fmt.Fprintf(os.Stderr, "  rslvd-tunnel -ssh abc123 22      # then: ssh -p <port> you@rslvd.net\n")
	fmt.Fprintf(os.Stderr, "  rslvd-tunnel -adb abc123 5555    # then: adb connect rslvd.net:<port>\n")
	fmt.Fprintf(os.Stderr, "  rslvd-tunnel -adb abc123 5037    # exposes a PC's adb server instead\n\n")
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

// ==================== TCP + REMOTE (SSH / ADB) TUNNELS ====================

// connectTCPControl performs the control handshake. For remote-access tunnels
// the server answers "OK <public_port>" and that port is returned as publicPort.
func connectTCPControl(token string) (net.Conn, string, error) {
	conn, err := dialServer(serverHost, tcpControlPort, 10*time.Second)
	if err != nil {
		return nil, "", fmt.Errorf("cannot reach %s:%s — %w", serverHost, tcpControlPort, err)
	}

	fmt.Fprintf(conn, "HELLO %s %s %s\n", token, deviceID(), deviceName())

	line, err := readLine(conn, 10*time.Second)
	if err != nil {
		conn.Close()
		return nil, "", fmt.Errorf("no response from server: %w", err)
	}

	if strings.HasPrefix(line, "ERR ") {
		conn.Close()
		return nil, "", fmt.Errorf("server error: %s", strings.TrimPrefix(line, "ERR "))
	}
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) == 0 || fields[0] != "OK" {
		conn.Close()
		return nil, "", fmt.Errorf("unexpected server response: %s", line)
	}

	publicPort := ""
	if len(fields) > 1 {
		publicPort = fields[1]
	}
	return conn, publicPort, nil
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

// printRemoteHelp explains how to reach a raw-port tunnel from the outside.
func printRemoteHelp(mode TunnelMode, publicPort, localPort string) {
	if publicPort == "" {
		log("  (server did not report a public port — check your dashboard)")
		return
	}
	switch mode {
	case ModeSSH:
		log("  Public:  %s:%s  (raw TCP)", serverHost, publicPort)
		log("  Connect: ssh -p %s <user>@%s", publicPort, serverHost)
		log("  Or use your tunnel hostname: ssh -p %s <user>@<name>.%s", publicPort, serverHost)
	case ModeADB:
		log("  Public:  %s:%s  (raw TCP)", serverHost, publicPort)
		if localPort == "5037" {
			log("  Connect (adb server mode): adb -H %s -P %s devices", serverHost, publicPort)
			log("  Then use any device by serial, e.g. adb -H %s -P %s shell", serverHost, publicPort)
		} else {
			log("  Connect: adb connect %s:%s", serverHost, publicPort)
			log("  Then:    adb -s %s:%s shell", serverHost, publicPort)
			log("  Tip: on the device run  adb tcpip %s  first (or enable ADB over network)", localPort)
		}
	}
}

func runTCPTunnel(token, localPort string, mode TunnelMode) error {
	if isRemoteMode(mode) {
		log("Connecting remote access (%s) tunnel to rslvd.net...", strings.ToUpper(string(mode)))
	} else {
		log("Connecting TCP tunnel to rslvd.net...")
	}

	conn, publicPort, err := connectTCPControl(token)
	if err != nil {
		return err
	}
	defer conn.Close()

	if isRemoteMode(mode) {
		log("✓ %s tunnel active!", strings.ToUpper(string(mode)))
		log("  Local:   localhost:%s", localPort)
		printRemoteHelp(mode, publicPort, localPort)
	} else {
		log("✓ TCP Tunnel active!")
		log("  Local:   localhost:%s", localPort)
		log("  (Ctrl+C to stop)")
	}

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

// ==================== MAIN ====================

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Printf("rslvd-tunnel v%s\n", version)
		os.Exit(0)
	}

	mode := ModeTCP
	argIdx := 1

	// Parse flags
	for argIdx < len(os.Args) && strings.HasPrefix(os.Args[argIdx], "-") {
		switch os.Args[argIdx] {
		case "-udp":
			mode = ModeUDP
		case "-ssh":
			mode = ModeSSH
		case "-adb":
			mode = ModeADB
		case "-dns", "-dns2tcp":
			fmt.Fprintln(os.Stderr, "DNS2TCP tunneling has been removed — use -ssh, -adb, TCP or -udp instead.")
			os.Exit(1)
		default:
			usage()
		}
		argIdx++
	}

	if len(os.Args) <= argIdx {
		usage()
	}

	token := os.Args[argIdx]
	localPort := defaultLocalPort(mode)
	if len(os.Args) > argIdx+1 {
		localPort = os.Args[argIdx+1]
	}

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
		case ModeTCP, ModeSSH, ModeADB:
			err = runTCPTunnel(token, localPort, mode)
		case ModeUDP:
			err = runUDPTunnel(token, localPort)
		}

		if err != nil {
			log("Disconnected: %v", err)
		}
	}
}
