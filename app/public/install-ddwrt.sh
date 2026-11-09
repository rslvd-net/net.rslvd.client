#!/bin/sh
# rslvd-tunnel installer for DD-WRT
# Run from the router shell (SSH in first):
#   curl -fsSL https://rslvd.net/install-ddwrt.sh | sh
# or:
#   wget -qO- https://rslvd.net/install-ddwrt.sh | sh
#
# DD-WRT persistent storage options (fastest to slowest):
#   1. JFFS2 partition (/jffs) — enable under Administration > JFFS2 Support
#   2. USB drive mounted at /opt via Optware/Entware
#   3. /tmp — volatile, lost on reboot

BASE_URL="https://rslvd.net/dl"

echo ""
echo "  rslvd-tunnel installer for DD-WRT"
echo ""

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)              TARGET="linux-amd64"  ;;
  aarch64)             TARGET="linux-arm64"  ;;
  armv7l|armv6l|armv5*) TARGET="linux-arm"  ;;
  mips)
    # Check /proc/cpuinfo for endianness clues
    if grep -qi "little" /proc/cpuinfo 2>/dev/null; then
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
  FETCH_CMD="curl -fsSL"
  FETCH_OUT="-o"
elif command -v wget >/dev/null 2>&1; then
  FETCH_CMD="wget -qO"
  FETCH_OUT=""
else
  echo "  Neither curl nor wget found."
  echo "  Enable JFFS2 + install Entware, then: opkg install curl"
  exit 1
fi

# Pick best persistent install location for DD-WRT
if [ -d "/jffs/usr/bin" ] || ([ -d "/jffs" ] && [ -w "/jffs" ]); then
  mkdir -p /jffs/usr/bin
  INSTALL_DIR="/jffs/usr/bin"
  PERSISTENT="jffs"
elif [ -d "/opt/usr/bin" ] || ([ -d "/opt" ] && [ -w "/opt" ]); then
  mkdir -p /opt/usr/bin
  INSTALL_DIR="/opt/usr/bin"
  PERSISTENT="opt"
else
  INSTALL_DIR="/tmp"
  PERSISTENT="tmp"
fi

BINARY="$INSTALL_DIR/rslvd-tunnel"

if [ "$PERSISTENT" = "tmp" ]; then
  echo "  Warning: No persistent storage found — installing to /tmp (lost on reboot)"
  echo "  For persistence, enable JFFS2: Administration > JFFS2 Support > Enable"
else
  echo "  Installing to $INSTALL_DIR (persistent)"
fi

echo "  Downloading $TARGET..."
if [ -n "$FETCH_OUT" ]; then
  $FETCH_CMD "${BASE_URL}/${TARGET}" $FETCH_OUT "$BINARY"
else
  $FETCH_CMD "$BINARY" "${BASE_URL}/${TARGET}"
fi
chmod +x "$BINARY"

echo ""
echo "  Installed: $BINARY"
VERSION=$("$BINARY" --version 2>/dev/null || echo "unknown")
echo "  Version:   $VERSION"
echo ""

# Add to PATH if needed
if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
  echo "  Note: Add to your PATH if needed:"
  echo "    export PATH=\$PATH:$INSTALL_DIR"
  echo ""
fi

# DD-WRT startup via /jffs/etc/config scripts
if [ "$PERSISTENT" = "jffs" ]; then
  echo "  To run on boot, create /jffs/etc/config/rslvd.startup:"
  echo "    mkdir -p /jffs/etc/config"
  echo "    echo '#!/bin/sh' > /jffs/etc/config/rslvd.startup"
  echo "    echo '$BINARY <TOKEN> <LOCAL_PORT> &' >> /jffs/etc/config/rslvd.startup"
  echo "    chmod +x /jffs/etc/config/rslvd.startup"
  echo ""
elif [ "$PERSISTENT" = "opt" ]; then
  echo "  To run on boot via Entware, add to /opt/etc/init.d/S99rslvd:"
  echo "    $BINARY <TOKEN> <LOCAL_PORT> &"
  echo ""
fi

echo "  Usage:"
echo "    $BINARY <TOKEN> <LOCAL_PORT>"
echo ""
echo "  Example (expose router admin UI on port 80):"
echo "    $BINARY abc123... 80"
echo ""
echo "  Get your token from: https://rslvd.net/dashboard"
echo ""
