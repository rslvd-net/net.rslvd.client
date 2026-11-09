#!/usr/bin/env bash
# rslvd-tunnel installer — one line install:
#   curl -fsSL https://rslvd.net/install.sh | bash
#
# Installs the native Go binary — no SSH, no dependencies needed.
set -eu

BASE_URL="https://rslvd.net/dl"

# ── Pick the install directory ───────────────────────────────────────────────
# Termux — and every Termux fork, including the rslvd Terminal app — exports
# $PREFIX as its own prefix, which is already on PATH and is the only place an
# unrooted Android app may write to. Never hardcode /data/data/com.termux/...:
# a fork has a different prefix, and Android denies writes to /usr/local/bin.
if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ] && [ -w "$PREFIX/bin" ]; then
  INSTALL_DIR="$PREFIX/bin"
  ON_ANDROID=1
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  INSTALL_DIR="/usr/local/bin"
  ON_ANDROID=0
else
  INSTALL_DIR="$HOME/.local/bin"
  ON_ANDROID=0
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
    echo "  Windows users: download from ${BASE_URL}/rslvd-tunnel-windows-amd64.exe"
    exit 1
esac

FILENAME="rslvd-tunnel-${OS}-${ARCH}"
DOWNLOAD_URL="${BASE_URL}/${FILENAME}"

if [ "$ON_ANDROID" = 1 ]; then
  echo "  → Detected: Android/Termux (${ARCH})"
else
  echo "  → Detected: ${OS}/${ARCH}"
fi
echo "  → Downloading ${FILENAME}..."

mkdir -p "$INSTALL_DIR"

# Download next to the target, check it, then move it into place so an
# interrupted or bogus download never leaves a broken $BINARY behind.
TMP=$(mktemp "${TMPDIR:-/tmp}/rslvd-tunnel.XXXXXX")
trap 'rm -f "$TMP"' EXIT

if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMP"; then
  echo "  ✗ Download failed: $DOWNLOAD_URL"
  exit 1
fi

# The web app answers unknown /dl/ paths with index.html and status 200, so
# curl -f alone does not prove we got a binary. ELF magic = 7f 45 4c 46.
if [ "$(head -c 4 "$TMP" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
  echo "  ✗ ${FILENAME} is not a runnable binary (bad architecture or server error)"
  echo "    Try again, or report it at https://rslvd.net/support"
  exit 1
fi

chmod 755 "$TMP"
mv -f "$TMP" "$BINARY"

# Add to PATH if needed (Termux's $PREFIX/bin is always in PATH already)
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    SHELL_RC=""
    if [ -n "${ZSH_VERSION:-}" ]; then
      SHELL_RC="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
      SHELL_RC="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then
      SHELL_RC="$HOME/.bash_profile"
    fi
    if [ -n "$SHELL_RC" ] && ! grep -qF "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null; then
      printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$SHELL_RC"
      echo "  → Added $INSTALL_DIR to PATH in $SHELL_RC"
    fi
    export PATH="$INSTALL_DIR:$PATH"
    ;;
esac

echo ""
if ! VERSION=$("$BINARY" --version 2>/dev/null); then
  echo "  ✗ Installed to $BINARY, but it will not start on this device."
  echo "    On Android this means the binary was built against glibc instead of"
  echo "    being statically linked — please report it:"
  echo "    https://rslvd.net/support"
  exit 1
fi
echo "  ✓ Installed: $BINARY  ($VERSION)"
echo ""
echo "  Usage:"
echo "    rslvd-tunnel <TOKEN> <LOCAL_PORT>"
echo ""
echo "  Example (expose local port 8080):"
echo "    rslvd-tunnel abc123... 8080"
echo ""
echo "  Get your token from: https://rslvd.net/dashboard"
echo ""
