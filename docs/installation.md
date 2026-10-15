# Install and upgrade Dewbow

Dewbow's standalone executable includes its daemon and Web interface. Installation requires neither Node.js nor Rust and does not install Codex. Install the independent Codex CLI separately as described in the [CLI guide](cli.md).

## Supported release binaries

| System | Architecture | Requirements |
| --- | --- | --- |
| Linux | x64 | GNU libc, `curl`, `tar`, `sha256sum` or `shasum` |
| macOS | ARM64 or x64 | `curl`, `tar`, `shasum` |
| Windows | x64 | Windows system `tar.exe`, PowerShell 5.1 or newer |

These are the release workflow's targets. Linux musl, Linux ARM64 and Windows ARM64 have no release target. Older operating-system compatibility is not established by these targets. Build from source when a matching release is unavailable. A selected release must contain an archive for the detected architecture; see [release targets](releasing.md#build-without-publication) for availability.

## Install a release

The installers are `scripts/install.sh` and `scripts/install.ps1` on this repository's `main` branch. The one-line commands below use their full raw GitHub URLs and execute the scripts directly without saving a script file. The scripts resolve the latest stable GitHub Release by default, verify the archive SHA-256, reject unexpected archive entries and links, and run the extracted executable's `--version` before installing it. Checksums detect corruption; release binaries and checksum files share GitHub as their trust source. Binary signing and notarization remain deferred.

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.ps1 | iex
```

The default destination is `~/.local/bin`. The installer prints the directory to add to PATH if needed; it does not edit shell profiles, the Windows registry or system PATH. Open a new shell after updating persistent PATH settings, then verify:

```sh
dewbow --version
dewbow init --codex-executable <standalone-codex-executable>
dewbow doctor
dewbow web
```

Select an exact unprefixed version, including a release candidate, or another directory:

```sh
curl -fsSL https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.sh | sh -s -- --version 0.1.0 --install-dir "$HOME/tools/dewbow"
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.ps1))) -Version 0.1.0 -InstallDir "$HOME\Tools\dewbow"
```

`DEWBOW_INSTALL_DIR` also selects the default directory. An explicit directory argument takes precedence. Installers refuse to overwrite an existing executable, including one placed by a concurrent installation. They remove only their own temporary staging directory on completion or failure.

## Upgrade an installed executable

The `upgrade` command works without initialized Dewbow state. Check the latest stable release without changing any files:

```sh
dewbow upgrade --check
```

Read the selected release's notes, stop all daemons using this executable, then upgrade:

```sh
dewbow daemon stop
dewbow upgrade
dewbow --version
dewbow doctor
dewbow web
```

For a custom state directory:

```sh
dewbow --state-dir <state-directory> daemon stop
dewbow --state-dir <state-directory> upgrade
```

Upgrade holds the selected state's daemon lock and refuses retained daemon ownership records or a live recorded native process. Other custom state directories are not discovered automatically: stop every daemon using this executable before replacing it. `--check` does not acquire locks or initialize state. Upgrade never kills processes, resets databases, edits configuration or restarts the daemon.

Use `dewbow upgrade --version <version>` to select a newer published release explicitly, including a prerelease. Unprefixed SemVer is required. The default selects only stable releases. An equal version is a no-op; downgrades are refused. Source builds in the usual `target/debug` and `target/release` directories must be rebuilt from source.

Upgrade downloads from `rovewyn/dewbow` on GitHub using HTTPS and normal proxy settings, with connection/download timeouts and bounded asset sizes. It verifies the archive checksum, exact archive entries, manifest version/target/binary checksum and executable version. A verified candidate is staged on the installation filesystem. The previous executable is retained beside it as `dewbow.previous-<version>-<unique-id>` (or `dewbow.exe.previous-...`). Replacement failure restores the original path; a rollback failure identifies the retained backup for manual recovery. Backups are never overwritten or removed automatically.

The installation directory must be writable. Run the command with the same user authority that owns the installation; use a user-owned directory if it is not writable. No privilege escalation is performed. On Windows, retaining the running executable under a backup filename allows replacement without launching a detached update helper.

## Recovery and package managers

Retain executable backups until the new release has been checked. Follow each release's state and rollback requirements; an older executable may not read state written by a newer one. If rollback is supported, stop all related daemons, retain the failed executable separately and move the chosen backup to the original executable path. Never delete native Codex conversations or credentials as part of an upgrade.

GitHub Releases are the binary distribution channel in this change. npm workspaces remain private; nothing is published to npm or crates.io. A future npm installer should reuse the checked standalone artifacts and keep upgrades owned by npm. Cargo publication additionally requires publishable versions of the internal crates and a packaged source for the embedded Web assets; the current daemon build reads those assets from the sibling Web workspace. These packaging and publication changes require their own review. See [releasing](releasing.md) for release authorization and artifact checks.
