# Building rslvd Android (native)

## Prerequisites

- **JDK 17**
- **Android SDK 36** + NDK `27.2.12479018` (for the terminal's PTY helper); export `ANDROID_HOME` (or set
  `sdk.dir` in `local.properties`).
- Gradle is provided via the wrapper (`./gradlew`, Gradle 8.11.1, AGP 8.9.2).

## Debug build

```bash
./gradlew :app:assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`

- Same `applicationId` (`net.rslvd.client`) as release; `versionName` carries a
  `-debug` suffix.
- Signed with the standard Android debug keystore — install with
  `adb install app/build/outputs/apk/debug/app-debug.apk` or by sideloading.

## Release signing

Release builds read signing config from `keystore.properties` (git-ignored). If it
is absent the release build falls back to the debug key so the project still
compiles, but **Play Store uploads must be signed with a real upload key**.

1. Generate an upload keystore (once):

   ```bash
   keytool -genkeypair -v -keystore rslvd-upload.jks -keyalg RSA -keysize 2048 \
     -validity 10000 -alias rslvd -dname "CN=rslvd.net, O=rslvd, C=US"
   ```

2. Copy `keystore.properties.example` → `keystore.properties` and fill in:

   ```properties
   storeFile=rslvd-upload.jks
   storePassword=********
   keyAlias=rslvd
   keyPassword=********
   ```

3. Build:

   ```bash
   ./gradlew :app:bundleRelease     # app/build/outputs/bundle/release/app-release.aab  (Play)
   ./gradlew :app:assembleRelease   # app/build/outputs/apk/release/app-release.apk     (sideload)
   ```

Verify a release artifact is signed:

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

> **Never commit** `keystore.properties` or `*.jks`. Both are in `.gitignore`.
> If you lose the upload key, you must use Google Play App Signing key reset.
