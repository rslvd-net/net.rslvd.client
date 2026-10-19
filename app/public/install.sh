#!/usr/bin/env bash
# rslvd-tunnel installer — one line install:
#   curl -fsSL https://rslvd.privatedns.org/install.sh | bash
#
# Installs the native Go binary — no SSH, no dependencies needed.
set -e

BASE_URL="https://rslvd.privatedns.org/dl"

# Termux (Android) uses $PREFIX/bin which is always in PATH
if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
  INSTALL_DIR="$PREFIX/bin"
else
  INSTALL_DIR="/usr/local/bin"
fi
BINARY="$INSTALL_DIR/rslvd-tunnel"

echo ""
echo "  ██████╗ ███████╗██╗    ██╗   ██╗██████╗ "
echo "  ██╔══██╗██╔════╝██║    ██║   ██║██╔══██╗"
echo "  ██████╔╝███████╗██║    ██║   ██║██║  ██║"
echo "  ██╔══██╗╚════██║██║    ╚██╗ ██╔╝██║  ██║"
echo "  ██║  ██║███████║███████╗╚████╔╝ ██████╔╝"
echo "  ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═══╝  ╚═════╝ "
echo ""
echo "  rslvd-tunnel installer  (native binary, no SSH needed)"
echo ""

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64)              ARCH="amd64" ;;
  aarch64|arm64)       ARCH="arm64" ;;
  armv7l|armv8l|armv6l) ARCH="arm" ;;
  *) echo "  ✗ Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
  linux|darwin) ;;
  *)
    echo "  ✗ Unsupported OS: $OS"
    echo "  Windows users: download from https://rslvd.privatedns.org/dl/rslvd-tunnel-windows-amd64.exe"
    exit 1 ;;
esac

FILENAME="rslvd-tunnel-${OS}-${ARCH}"
DOWNLOAD_URL="${BASE_URL}/${FILENAME}"

if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
  echo "  → Detected: Android/Termux (${ARCH})"
else
  echo "  → Detected: ${OS}/${ARCH}"
fi
echo "  → Downloading ${FILENAME}..."

mkdir -p "$INSTALL_DIR"
curl -fsSL "$DOWNLOAD_URL" -o "$BINARY"
chmod +x "$BINARY"

# Add to PATH if needed (Termux's PREFIX/bin is always in PATH already)
if [ -z "$PREFIX" ]; then
  SHELL_RC=""
  if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "$(which zsh 2>/dev/null)" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_RC="$HOME/.bash_profile"
  fi

  if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
    if [ -n "$SHELL_RC" ]; then
      echo "export PATH=\"\$PATH:$INSTALL_DIR\"" >> "$SHELL_RC"
      echo "  → Added $INSTALL_DIR to PATH in $SHELL_RC"
    fi
    export PATH="$PATH:$INSTALL_DIR"
  fi
fi

echo ""
VERSION=$("$BINARY" --version 2>/dev/null || echo 'v1.0.0')
echo "  ✓ Installed: $BINARY  ($VERSION)"
echo ""
echo "  Usage:"
echo "    rslvd-tunnel <TOKEN> <LOCAL_PORT>"
echo ""
echo "  Example (expose local port 8080):"
echo "    rslvd-tunnel abc123... 8080"
echo ""
echo "  Get your token from: https://rslvd.privatedns.org/dashboard"
echo ""
