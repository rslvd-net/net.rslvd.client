# rslvd shell package repository (repo.rslvd.net)

Packages and the first-run bootstrap used by the full Android build
(`net.rslvd.debug`) are built from a fork of
[termux-packages](https://github.com/termux/termux-packages) with prefix
`/data/data/net.rslvd.debug/files/usr`.

## Layout

- `rslvd-packages.patch` – every change on top of upstream termux-packages
  (base commit printed by `build-repo.sh`). It contains:
  - `termux-{am,am-socket,core,exec,keyring,licenses,tools}` forked as
    `rslvd-*` packages. Each `Provides`/`Replaces`/`Conflicts` its termux-*
    name so upstream dependencies still resolve. User-facing binaries are
    renamed `termux-<x>` → `rslvd-<x>` with `termux-<x>` left as a symlink
    (`scripts/rslvd_rebrand.sh`). Internal loader/library names
    (`libtermux-exec*.so`) and the Android class `com.termux.termuxam.Am`
    inside the bundled `am.apk` are intentionally unchanged: the app's
    `LD_PRELOAD` and `am` wrapper depend on them.
  - `scripts/properties.sh`: `TERMUX_APP__PACKAGE_NAME=net.rslvd.debug`
    (bakes the prefix into every binary).
  - `scripts/buildorder.py` / `scripts/generate-bootstraps.sh`: resolve
    virtual (`Provides:`) package names, pull `rslvd-*` into the bootstrap.
  - `packages/tsu`: revision bump + prefix rewrite (`TERMUX_FS` →
    `/data/data/net.rslvd.debug/files`). `tsu`/`sudo` only work on rooted
    devices (Magisk/KernelSU); they do not grant root by themselves.
  - `packages/rslvd-keyring/rslvd-repo.gpg`: public half of the repo signing
    key, installed to `$PREFIX/etc/apt/trusted.gpg.d/rslvd-repo.gpg`.
- `build-repo.sh` – mirrors `termux-packages/output/*.deb` into the pool,
  builds `rslvd-tunnel`, writes `Packages`/`Release`, signs
  `InRelease` + `Release.gpg`, generates `bootstrap-<arch>.zip(.sha256)` and
  refreshes `rslvd-packages.patch`.

## Signing key

The apt private key lives **outside** the repo in `~/.rslvd-apt-gpg`
(override with `RSLVD_APT_GNUPGHOME`). Fingerprint:
`94D3 F979 7627 73EB EE45 4A17 A714 57FA F39B DB39`
(`rslvd package repository <repo@rslvd.net>`).

To create a new key (then rebuild `rslvd-keyring` with the exported public
key and republish the bootstrap):

```sh
export GNUPGHOME=~/.rslvd-apt-gpg; mkdir -m700 -p "$GNUPGHOME"
gpg --batch --quick-gen-key 'rslvd package repository <repo@rslvd.net>' ed25519 sign never
gpg --export repo@rslvd.net > ~/termux-packages/packages/rslvd-keyring/rslvd-repo.gpg
```

## Building

```sh
git clone https://github.com/termux/termux-packages ~/termux-packages
git -C ~/termux-packages checkout <base commit from build-repo.sh output>
git -C ~/termux-packages apply scripts/shell-repo/rslvd-packages.patch
cd ~/termux-packages && ./scripts/run-docker.sh ./build-package.sh -a aarch64 \
    rslvd-tools bash apt dpkg netcat-openbsd net-tools dnsutils nmap util-linux tsu
cd <this repo> && RSLVD_REPO_DIR=~/rslvd-repo bash scripts/shell-repo/build-repo.sh
rsync -a --delete ~/rslvd-repo/ ubuntu@129.146.61.187:/opt/rslvd-repo/
```

Verify before deploying:

```sh
unzip -q ~/rslvd-repo/bootstraps/bootstrap-aarch64.zip -d /tmp/bs
grep -rlI /data/data/com.termux /tmp/bs/bin /tmp/bs/etc /tmp/bs/libexec   # comments only
gpgv --keyring /tmp/bs/share/rslvd-keyring/rslvd-repo.gpg \
    ~/rslvd-repo/apt/rslvd-main/dists/stable/InRelease
```

## Third-party repos (ivam3)

`https://ivam3.github.io/termux-packages` was reviewed and is **not** added
as an apt source: its `.deb`s are compiled for `/data/data/com.termux` (they
fail under our prefix), several maintainer scripts download and run code at
install time, and the catalogue is mostly offensive-security tooling.
`https://ivam3.github.io/demon-packages` has no `dists/` metadata (404).
Individual packages from there can be rebuilt from source for our prefix on
request instead of being mirrored.
