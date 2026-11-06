#!/data/data/com.termux/files/usr/bin/bash
#
# termux-build.sh — build rslvd's debug APK on the phone, inside Termux.
#
# The only part of Google's Android tooling that genuinely cannot run on an ARM
# phone is aapt2: AGP downloads an x86_64 build from maven.google.com and it dies
# with "cannot execute binary file". Termux ships a native aarch64 aapt2 (the
# same AOSP tool, compiled for Android), so this script installs it and points
# AGP at it with android.aapt2FromMavenOverride. Everything else — the SDK
# platform jar, d8/r8, apksigner, the Kotlin compiler — is Java and runs as-is.
#
# Usage:
#   cd net.rslvd.client/rslvd-android
#   ./termux-build.sh                 # first run: install packages, SDK, Gradle; then build
#   ./termux-build.sh --clean         # wipe app/build first
#   ./termux-build.sh --heap 3072     # give Gradle more (or less) heap
#   ./termux-build.sh -- :app:assembleRelease   # anything after -- goes to gradlew
#
# Output: app/build/outputs/apk/debug/app-debug.apk
#
# Needs ~6 GB free in $HOME (SDK + Gradle distribution + Gradle caches) and a
# couple of GB of RAM. The first build downloads Gradle 8.11.1 and every
# androidx/compose artifact, so give it a fast unmetered connection.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$SCRIPT_DIR

SDK_DIR=""
BT_VERSION="35.0.0"          # AGP 8.9.2's default for compileSdk 36
HEAP_MB=""
ASSUME_YES=0
DO_CLEAN=0
GRADLE_ARGS=()

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Build rslvd's debug APK inside Termux (no PC, no proot, no emulation).

  ./termux-build.sh [options] [-- gradle-args...]

Options:
  -y, --yes              don't ask before installing Termux packages
      --sdk DIR          SDK location (default: $HOME/android-sdk)
      --build-tools VER  SDK build-tools to install (default: 35.0.0)
      --heap MB          Gradle JVM heap (default: half of RAM, clamped 1024..3072)
      --clean            run `clean` before building
  -h, --help             this text

The build is incremental and the setup steps are idempotent, so re-running the
script after a `git pull` just rebuilds.
EOF
}

while (($#)); do
  case $1 in
    -y|--yes)       ASSUME_YES=1 ;;
    --sdk)          SDK_DIR=${2:?--sdk needs a directory}; shift ;;
    --build-tools)  BT_VERSION=${2:?--build-tools needs a version}; shift ;;
    --heap)         HEAP_MB=${2:?--heap needs a number}; shift ;;
    --clean)        DO_CLEAN=1 ;;
    -h|--help)      usage; exit 0 ;;
    --)             shift; GRADLE_ARGS+=("$@"); break ;;
    *)              die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# 0. Are we where we think we are?
# ---------------------------------------------------------------------------

if [[ -z ${PREFIX:-} || $PREFIX != *com.termux* ]]; then
  die "this script must run inside Termux (PREFIX=$PREFIX); on a PC use ./gradlew :app:assembleDebug"
fi

case $(uname -m) in
  aarch64|arm64|x86_64|i686) ;;
  *) warn "untested CPU architecture '$(uname -m)'; Termux aapt2 may not match" ;;
esac

[[ -f $PROJECT_DIR/gradlew && -f $PROJECT_DIR/app/build.gradle ]] \
  || die "$PROJECT_DIR does not look like rslvd-android (no gradlew/app/build.gradle)"

# 6 GB is roughly SDK (2 GB) + Gradle distribution (0.4 GB) + caches (2.5 GB).
avail_kb=$(df -Pk "$HOME" | awk 'NR==2 { print $4 }')
if (( avail_kb < 5 * 1024 * 1024 )); then
  die "only $(( avail_kb / 1024 / 1024 )) GB free in \$HOME; need ~6 GB (try: pkg clean, or --sdk onto faster/larger storage)"
elif (( avail_kb < 8 * 1024 * 1024 )); then
  warn "only $(( avail_kb / 1024 / 1024 )) GB free in \$HOME; a first build can use 6 GB"
fi

if (( ! ASSUME_YES )) && [[ -t 0 ]]; then
  printf 'Install/update Termux packages, Android SDK and Gradle, then build the debug APK? [Y/n] '
  read -r reply
  case ${reply:-y} in [Nn]*) exit 1 ;; esac
fi

# Long builds get killed when the screen sleeps unless we hold a wake lock.
WAKE_LOCKED=0
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock && WAKE_LOCKED=1
fi
cleanup() { (( WAKE_LOCKED )) && termux-wake-unlock >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Termux packages: JDK, native aapt2, unzip
# ---------------------------------------------------------------------------

log "installing Termux packages (JDK, aapt2, unzip)"
# openjdk-17 is the safest JDK for AGP 8.9 / Kotlin 1.9.22; fall back to 21 if the
# 17 package has been dropped from the repo.
pkg install -y openjdk-17 >/dev/null 2>&1 || pkg install -y openjdk-21 >/dev/null 2>&1 \
  || die "could not install a JDK (pkg install openjdk-17)"
pkg install -y aapt2 unzip zip curl >/dev/null 2>&1 || die "pkg install aapt2 unzip zip curl failed"

JAVA_HOME=""
for cand in "$PREFIX/lib/jvm/java-17-openjdk" "$PREFIX/lib/jvm/java-21-openjdk" "$PREFIX"/lib/jvm/*openjdk*; do
  if [[ -x $cand/bin/javac ]]; then JAVA_HOME=$cand; break; fi
done
[[ -n $JAVA_HOME ]] || die "no JDK found under $PREFIX/lib/jvm (pkg install openjdk-17)"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
log "JDK: $(java -version 2>&1 | head -1) ($JAVA_HOME)"

AAPT2=$PREFIX/bin/aapt2
[[ -x $AAPT2 ]] || die "native aapt2 missing after install (pkg install aapt2)"
aapt2_version=$("$AAPT2" version 2>&1 | head -1) \
  || die "Termux aapt2 does not run on this device; try: pkg upgrade aapt2"
log "aapt2: $aapt2_version"

# ---------------------------------------------------------------------------
# 2. Android command-line tools + SDK platform
# ---------------------------------------------------------------------------

SDK_DIR=${SDK_DIR:-$HOME/android-sdk}
SDKMANAGER=$SDK_DIR/cmdline-tools/latest/bin/sdkmanager

if [[ ! -x $SDKMANAGER ]]; then
  tools_url=${CMDLINE_TOOLS_URL:-}
  if [[ -z $tools_url ]]; then
    log "looking up the current Android command-line tools"
    tools_url=$(curl -fsSL --retry 3 https://dl.google.com/android/repository/repository2-3.xml 2>/dev/null \
      | grep -o 'commandlinetools-linux-[0-9]*_latest\.zip' | sort -uV | tail -1 || true)
  fi
  # Pinned fallback for when the index is unreachable. sdkmanager is a JVM app,
  # so the linux-x86_64 download is fine: only its bundled binaries are x86_64,
  # and the SDK platform it installs is pure Java/data.
  [[ -n $tools_url ]] || tools_url=commandlinetools-linux-13114758_latest.zip
  case $tools_url in http*) ;; *) tools_url=https://dl.google.com/android/repository/$tools_url ;; esac

  log "downloading command-line tools"
  tmpdir=$(mktemp -d)
  curl -fL --retry 3 --progress-bar -o "$tmpdir/tools.zip" "$tools_url" \
    || die "download failed: $tools_url"
  unzip -q "$tmpdir/tools.zip" -d "$tmpdir" || die "could not unzip $tools_url"
  mkdir -p "$SDK_DIR/cmdline-tools"
  rm -rf "$SDK_DIR/cmdline-tools/latest"
  mv "$tmpdir/cmdline-tools" "$SDK_DIR/cmdline-tools/latest" || die "could not unpack command-line tools"
  rm -rf "$tmpdir"
fi

export ANDROID_HOME=$SDK_DIR
export ANDROID_SDK_ROOT=$SDK_DIR
log "SDK: $SDK_DIR"

log "accepting SDK licenses"
# `yes` exiting early is normal here; don't let pipefail turn it into a failure.
( yes 2>/dev/null || true ) | "$SDKMANAGER" --sdk_root="$SDK_DIR" --licenses >/dev/null 2>&1 \
  || warn "license acceptance returned non-zero; continuing (packages below may still install)"

want=()
[[ -f $SDK_DIR/platforms/android-36/android.jar ]] || want+=("platforms;android-36")
[[ -d $SDK_DIR/build-tools/$BT_VERSION ]] || want+=("build-tools;$BT_VERSION")

if ((${#want[@]})); then
  log "installing SDK packages: ${want[*]}"
  sdk_log=$HOME/.sdkmanager-termux.log
  if ! "$SDKMANAGER" --sdk_root="$SDK_DIR" "${want[@]}" >"$sdk_log" 2>&1; then
    tail -n 25 "$sdk_log" >&2
    die "sdkmanager failed (full log: $sdk_log)"
  fi
fi

[[ -f $SDK_DIR/platforms/android-36/android.jar ]] \
  || die "platforms;android-36 missing after install; run: sdkmanager --sdk_root=$SDK_DIR 'platforms;android-36'"

BT_DIR=$SDK_DIR/build-tools/$BT_VERSION
if [[ ! -d $BT_DIR ]]; then
  BT_DIR=$(ls -d "$SDK_DIR"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
  BT_DIR=${BT_DIR%/}
  [[ -n $BT_DIR && -d $BT_DIR ]] || die "no build-tools installed under $SDK_DIR"
  warn "build-tools $BT_VERSION not present; using ${BT_DIR##*/}"
fi
log "build-tools: ${BT_DIR##*/}"

# ---------------------------------------------------------------------------
# 3. Point Gradle at Termux's binaries (user-level config, never the repo)
# ---------------------------------------------------------------------------

GRADLE_USER_DIR=${GRADLE_USER_HOME:-$HOME/.gradle}
mkdir -p "$GRADLE_USER_DIR"
props=$GRADLE_USER_DIR/gradle.properties
touch "$props"

# Replace a previous managed block instead of appending duplicates.
if grep -q '^# >>> rslvd-termux >>>' "$props"; then
  stripped=$(mktemp)
  awk '
    /^# >>> rslvd-termux >>>/ { skip = 1 }
    !skip { print }
    /^# <<< rslvd-termux <<</ { skip = 0 }
  ' "$props" > "$stripped"
  mv "$stripped" "$props"
fi

{
  echo '# >>> rslvd-termux >>> (managed by rslvd-android/termux-build.sh)'
  echo "org.gradle.java.home=$JAVA_HOME"
  echo "# AGP would otherwise download an x86_64 aapt2 and fail on ARM."
  echo "android.aapt2FromMavenOverride=$AAPT2"
  echo "android.suppressUnsupportedCompileSdk=36"
  echo "kotlin.compiler.execution.strategy=in-process"
  echo 'org.gradle.parallel=false'
  echo '# <<< rslvd-termux <<<'
} >> "$props"
log "updated $props"

# local.properties is git-ignored; keep any of the user's other settings.
local_props=$PROJECT_DIR/local.properties
if ! grep -qx "sdk.dir=$SDK_DIR" "$local_props" 2>/dev/null; then
  others=$(grep -v '^sdk\.dir=' "$local_props" 2>/dev/null || true)
  {
    [[ -n $others ]] && printf '%s\n' "$others"
    printf 'sdk.dir=%s\n' "$SDK_DIR"
  } > "$local_props"
  log "wrote sdk.dir into $local_props"
fi

# ---------------------------------------------------------------------------
# 4. Build
# ---------------------------------------------------------------------------

if [[ -z $HEAP_MB ]]; then
  mem_mb=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 4096)
  HEAP_MB=$(( mem_mb / 2 ))
  (( HEAP_MB < 1024 )) && HEAP_MB=1024
  (( HEAP_MB > 3072 )) && HEAP_MB=3072
fi
log "Gradle heap: ${HEAP_MB}m (override with --heap)"

chmod +x "$PROJECT_DIR/gradlew" 2>/dev/null || true
cd "$PROJECT_DIR"

gradle_cmd=(
  ./gradlew --no-daemon --console=plain --max-workers=2
  "-Dorg.gradle.jvmargs=-Xmx${HEAP_MB}m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8"
  -Pkotlin.compiler.execution.strategy=in-process
)
(( DO_CLEAN )) && gradle_cmd+=(clean)
gradle_cmd+=(:app:assembleDebug)
((${#GRADLE_ARGS[@]})) && gradle_cmd+=("${GRADLE_ARGS[@]}")

log "building: ${gradle_cmd[*]}"
status=0
"${gradle_cmd[@]}" || status=$?

if (( status != 0 )); then
  cat >&2 <<EOF

Build failed (gradlew exit $status). On a phone the usual causes:

  * Out of memory / "GC overhead limit exceeded" / the process was killed:
      ./termux-build.sh --heap 1024 --clean
  * "aapt2 ... Permission denied", "cannot execute binary file" or an aapt2
    crash, including resources.arsc from compileSdk 36:
      pkg upgrade aapt2 && ./termux-build.sh --clean
  * "error while loading shared libraries: libc.so.6": something is using a
    glibc build (e.g. an SDK tool you copied from a PC). Everything here has to
    come from Termux packages.
  * Kotlin daemon died: it is already forced in-process; re-run with --heap 2048.
  * Gradle can't download: check the connection, then re-run — downloads resume.

For the full traceback: ./gradlew --no-daemon :app:assembleDebug --stacktrace
EOF
  exit "$status"
fi

apk=$PROJECT_DIR/app/build/outputs/apk/debug/app-debug.apk
[[ -f $apk ]] || die "Gradle reported success but $apk is missing"

log "debug APK: $apk ($(du -h "$apk" | cut -f1))"
sha256sum "$apk"
echo
echo "Install it by opening that file in a file manager, or:"
echo "  adb install -r '$apk'          # wireless debugging / another machine"
