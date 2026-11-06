#!/bin/bash
set -e
export PATH=$PATH:/usr/local/go/bin

# CGO must stay off. With it on, a build whose GOARCH matches the build host
# links against that host's C library: building arm64 on an arm64 server produced
# an ELF with interpreter /lib/ld-linux-aarch64.so.1, which cannot run on Android
# (bionic, /system/bin/linker64) — Termux then reports "No such file or directory".
export CGO_ENABLED=0

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/tunnel-client"
OUT_DIR="${OUT_DIR:-/opt/rslvd/public/dl}"
mkdir -p "$OUT_DIR"

build() {
  local goarch="$1" name="$2" extra="${3:-}"
  echo "Building ${name}..."
  (cd "$SRC_DIR" && env GOOS=linux GOARCH="$goarch" $extra \
    go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/$name" .)
}

build amd64 rslvd-tunnel-linux-amd64
build arm64 rslvd-tunnel-linux-arm64            # 64-bit Android/Termux
build arm   rslvd-tunnel-linux-arm "GOARM=7"    # 32-bit Android/Termux
build mips  rslvd-tunnel-linux-mips  "GOMIPS=softfloat"
build mipsle rslvd-tunnel-linux-mipsle "GOMIPS=softfloat"
build mips64 rslvd-tunnel-linux-mips64 "GOMIPS64=softfloat"

echo "Building darwin/amd64..."
(cd "$SRC_DIR" && GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/rslvd-tunnel-darwin-amd64" .)
echo "Building darwin/arm64 (Apple Silicon)..."
(cd "$SRC_DIR" && GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/rslvd-tunnel-darwin-arm64" .)
echo "Building windows/amd64..."
(cd "$SRC_DIR" && GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/rslvd-tunnel-windows-amd64.exe" .)

chmod +x "$OUT_DIR"/rslvd-tunnel-*
chown -R rslvd:rslvd "$OUT_DIR" 2>/dev/null || true

echo ""
echo "Done! Binaries:"
ls -lh "$OUT_DIR/"
echo ""
echo "Linux builds must be static (no PT_INTERP):"
for f in "$OUT_DIR"/rslvd-tunnel-linux-*; do
  printf '  %s: ' "$(basename "$f")"
  readelf -l "$f" 2>/dev/null | grep -qi interpreter && echo "DYNAMIC (broken for Android)" || echo "static"
done
