#!/bin/sh
# rslvd-tunnel installer for OpenWRT
# Run from the router shell:
#   curl -fsSL https://rslvd.net/install-openwrt.sh | sh
# or if curl isn't available:
#   wget -qO- https://rslvd.net/install-openwrt.sh | sh

BASE_URL="https://rslvd.net/dl"
INSTALL_DIR="/usr/local/bin"
BINARY="$INSTALL_DIR/rslvd-tunnel"

echo ""
echo "  rslvd-tunnel installer for OpenWRT"
echo ""

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)              TARGET="linux-amd64"  ;;
  aarch64)             TARGET="linux-arm64"  ;;
  armv7l|armv6l)       TARGET="linux-arm"    ;;
  mips)
    # Detect endianness from /proc/cpuinfo
    if grep -q "LE" /proc/cpuinfo 2>/dev/null || [ "$(echo -n '\x01' | od -An -tx1 | tr -d ' ')" = "01" ]; then
      TARGET="linux-mipsle"
    else
      TARGET="linux-mips"
    fi
    ;;
  mips64)              TARGET="linux-mips64" ;;
  mipsel|mips64el)     TARGET="linux-mipsle" ;;
  *) echo "  Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "  Detected: $ARCH → $TARGET"

# Check for wget or curl
if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
  FETCH_OUT="-o"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO"
  FETCH_OUT=""
else
  echo "  Neither curl nor wget found. Install one first:"
  echo "    opkg update && opkg install curl"
  exit 1
fi

# Check for writable install location
# OpenWRT: prefer /usr/local/bin, fall back to /tmp (volatile) with a warning
if [ ! -w "$INSTALL_DIR" ] 2>/dev/null; then
  if mount | grep -q "overlayfs\|jffs2\|ext4" 2>/dev/null; then
    mkdir -p "$INSTALL_DIR" 2>/dev/null || true
  fi
  if [ ! -d "$INSTALL_DIR" ]; then
    INSTALL_DIR="/tmp"
    BINARY="/tmp/rslvd-tunnel"
    echo "  Warning: /usr/local/bin not writable — installing to /tmp (lost on reboot)"
    echo "  For persistent install, expand router storage or use a USB drive."
  fi
fi

echo "  Downloading $TARGET..."
if [ -n "$FETCH_OUT" ]; then
  $FETCH "${BASE_URL}/${TARGET}" $FETCH_OUT "$BINARY"
else
  $FETCH "$BINARY" "${BASE_URL}/${TARGET}"
fi
chmod +x "$BINARY"

echo ""
echo "  Installed: $BINARY"
VERSION=$("$BINARY" --version 2>/dev/null || echo "unknown")
echo "  Version:   $VERSION"
echo ""

# Offer to set up a startup script if /etc/rc.local exists (persistent runs)
if [ "$INSTALL_DIR" != "/tmp" ]; then
  echo "  To run on boot, add to /etc/rc.local:"
  echo "    $BINARY <TOKEN> <LOCAL_PORT> &"
  echo ""
fi

echo "  Usage:"
echo "    rslvd-tunnel <TOKEN> <LOCAL_PORT>"
echo ""
echo "  Example (expose a local web server on port 80):"
echo "    rslvd-tunnel abc123... 80"
echo ""
echo "  Get your token from: https://rslvd.net/dashboard"
echo ""
