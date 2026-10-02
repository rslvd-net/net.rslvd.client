# rslvd Android (native)

A **pure native Android app** (Kotlin + Jetpack Compose) for [rslvd.net](https://rslvd.net).
No WebView — it talks directly to the rslvd REST API.

> This replaces the old Capacitor/WebView wrapper in `../android-app/`. The PWA
> already covers the "wrap the website" use case; this app is the standalone
> native client.

## Features

- **Account** — register, sign in (with 2FA/TOTP support), view plan & limits, sign out.
  JWT is stored in `EncryptedSharedPreferences` and sent as a Bearer token.
- **Hosts** — list, create, delete `@rslvd.net` subdomains; copy/rotate the DDNS
  update key; one-tap "Add to DDNS".
- **Tunnels** — list, create (name / target host:port / protocol), delete; copy the
  connect token used by the `rslvd-tunnel` client.
- **Universal DDNS updater** — a `WorkManager` job detects the device's public IPv4
  and pushes it to every configured target on an interval (15 m / 30 m / 1 h / 6 h).
  - **Defaults to rslvd**: adding a host auto-fills its rslvd update endpoint.
  - **Universal**: add any DynDNS-compatible provider via a URL template containing
    the `{ip}` token (Google Domains, No-IP, DuckDNS, Cloudflare via a worker, etc.).
  - Reschedules after reboot (`BootReceiver`) and posts a status notification.
- **Shell** — a real terminal: native PTY (`forkpty` via JNI) + xterm-256color
  emulator, so `nano`, `vim`, `top`, `less`, readline history and ANSI colours all
  work. Extra-keys row for ESC/TAB/CTRL/ALT/arrows/Home/End/PgUp/PgDn/Del. The
  Play flavour runs the sandboxed `/system/bin/sh`; the full flavour
  (`net.rslvd.debug`) runs bash from the bootstrap `$PREFIX`.

## Architecture

| Layer        | Tech                                              |
|--------------|---------------------------------------------------|
| UI           | Jetpack Compose + Material 3, single-Activity     |
| State        | `AppViewModel` (AndroidViewModel) + `StateFlow`   |
| Networking   | Retrofit + OkHttp + Moshi (`ApiClient`/`ApiService`) |
| Auth storage | `androidx.security:security-crypto` (encrypted prefs) |
| Background   | `androidx.work` (`DdnsWorker`, `DdnsScheduler`)   |
| Terminal     | `:terminal-emulator` / `:terminal-view` (vendored from termux-app, Apache-2.0) driven by `shell/TerminalHost` |

API base URL: `https://rslvd.net/api/` (see `data/ApiClient.kt`).

## Build

Requirements: JDK 17, Android SDK 36 + NDK 27.2.12479018 (`ANDROID_HOME` set; the NDK
builds the PTY helper `libtermux.so` for arm64-v8a / armeabi-v7a / x86_64).

```bash
# Debug APK
./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk   (applicationId net.rslvd.client.debug)

# Signed release (needs keystore.properties — see below)
./gradlew :app:bundleRelease    # → app/build/outputs/bundle/release/app-release.aab
./gradlew :app:assembleRelease  # → app/build/outputs/apk/release/app-release.apk
```

See [BUILD.md](BUILD.md) for signing setup and [PLAY_STORE.md](PLAY_STORE.md) for
Google Play submission.
