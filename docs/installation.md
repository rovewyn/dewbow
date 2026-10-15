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

Read the selected release's notes, then upgrade the selected installation and state:

```sh
dewbow upgrade
dewbow --version
dewbow daemon status
```

The [state directory](operations.md#state-directory) is Dewbow's private local data directory for configuration, management storage, runtime ownership files and daemon diagnostics; it defaults to `~/.dewbow`. It is selected independently of the executable's installation directory. If initialization used a custom directory, select that same directory when stopping the daemon and upgrading:

```sh
dewbow --state-dir <state-directory> upgrade
```

Upgrade downloads and verifies the candidate while the selected daemon continues serving. It then enters maintenance: new conversations, connections and sends are refused; existing turns can finish through steering, answers, approvals and operator interruptions. Accepted management requests and active or unresolved turns must all finish before stopping. The default wait is 300 seconds; `--wait-seconds <seconds>` changes it, including zero for idle-only upgrades. A timeout aborts without interrupting turns and resumes admission. If the updater disconnects while draining, its 30-second lease expires and admission resumes automatically.

The stopped daemon and its owned native process must release their ownership and listener before snapshotting or replacement. These operations hold the daemon lock. Stale records are recovered only after validating identity, confirming both recorded processes have exited, and reserving the configured loopback port. A held lock, live recorded process, occupied port, invalid record or configuration mismatch blocks recovery. Other custom state directories are not discovered automatically: stop their daemons before replacing this executable. A running daemon without the `v1` upgrade protocol must also be stopped explicitly first. `--check` does not acquire locks, recover records or initialize state.

Use `dewbow upgrade --version <version>` to select a newer published release explicitly, including a prerelease. Unprefixed SemVer is required. The default selects only stable releases. An equal version is a no-op; downgrades are refused. Source builds in the usual `target/debug` and `target/release` directories must be rebuilt from source.

Upgrade downloads from `rovewyn/dewbow` on GitHub using HTTPS and normal proxy settings, with connection/download timeouts and bounded asset sizes. It verifies the archive checksum, exact entries, manifest version/target/binary checksum and executable version. Archive tools and executable probes have 30-second deadlines. The release must declare `upgrade.contractVersion: "v1"`, `stateSchema: 1` and `rollbackSafe: true`; releases requiring other state or manual rollback handling are rejected before maintenance. Checksums and metadata share the release's trust source; they are not signatures.

Use a previously downloaded release archive with its published `<archive>.sha256` alongside it. Offline archives receive the same checks without contacting GitHub:

```sh
dewbow --state-dir <state-directory> upgrade --version <version> --archive <release-archive>
```

A verified candidate is staged on the installation filesystem and flushed before replacement. The previous executable is retained beside it as a hard link named `dewbow.previous-<version>-<unique-id>` (or `dewbow.exe.previous-...`). The launch path is replaced in one operation: POSIX rename on Linux/macOS, or `FileRenameInfoEx` with replacement and POSIX semantics on Windows. The original path is never moved aside. Termination before the switch leaves the old executable launchable; termination after it leaves the new executable launchable. A failed switch preserves the original path and backup. Backups are never overwritten or removed automatically.

Initialized state receives a private `upgrade/` transaction and snapshot of `config.json` and checkpointed `daemon.sqlite`. Native conversations, credentials, Codex configuration and workspace files are never backed up or restored. The candidate starts from the installation path and remains in maintenance across restarts. Validation checks its launched process identity, exact version, native initialization, model catalog and inventory protocol without sending a prompt. Each startup/shutdown phase has a 60-second deadline, configurable with `--timeout-seconds <seconds>`. A durable commit marker is flushed before admitting work. A previously running daemon stays running; a previously stopped daemon starts for validation and stops again. Without initialized state, the command reports that daemon startup could not be checked.

Before commit, failed replacement or startup triggers guarded rollback. It verifies process exit, backup hashes and unchanged configuration, retains failed management files and executable, restores the management snapshot and previous executable, then validates the previous service. It refuses rollback while an owned process or listener remains alive, if backups are corrupt, if configuration or the installation changed externally, or if the candidate may have accepted work. Only a process launched by this updater can be terminated through its launch handle after a shutdown deadline; recorded PIDs are never killed. A surviving native process blocks rollback even after candidate termination. Failed recovery retains the transaction and backups for inspection.

The installation directory must be writable and its filesystem must support hard links and atomic replacement. Windows also requires support for `FileRenameInfoEx` POSIX replacement of a running executable. Unsupported operations fail without moving the original executable aside; there is no fallback to a two-step replacement. Run the command with the same user authority that owns the installation; use a user-owned directory if it is not writable. No privilege escalation or detached update helper is used. Linux/macOS synchronize the installation directory before and after replacement; Windows has no equivalent directory synchronization through Rust's standard filesystem API. Process-interruption tests do not establish hardware power-loss guarantees.

## Recovery and package managers

Recover an interrupted, uncommitted upgrade from the installed executable:

```sh
dewbow --state-dir <state-directory> upgrade --recover
```

Recovery stops only the exact authenticated instance still sealed by this transaction, confirms ownership has ended, and restores and validates the preceding version. It preserves the original running/stopped choice. Partial restoration can be retried from the immutable snapshot. A pending transaction keeps startup sealed; do not delete it to bypass validation. If ownership or files cannot be verified, resolve the reported condition and retain private files for inspection. An updater terminated after stopping the old daemon does not restart it independently; a detached supervisor remains deferred.

After durable commit, automatic rollback is refused because new work may have been accepted. Follow the release's manual rollback guidance and retain a suitable current state backup before changing versions. Never delete native Codex conversations or credentials. Previous executable links, `upgrade/`, archived `upgrade-history-*` snapshots and `upgrade-failed-state-*` files are private recovery data. Keep them until acceptance is complete; later upgrades archive the preceding committed transaction. Remove only reviewed backups while stopped, and keep them out of Git and shared logs.

GitHub Releases are the binary distribution channel in this change. npm workspaces remain private; nothing is published to npm or crates.io. A future npm installer should reuse the checked standalone artifacts and keep upgrades owned by npm. Cargo publication additionally requires publishable versions of the internal crates and a packaged source for the embedded Web assets; the current daemon build reads those assets from the sibling Web workspace. These packaging and publication changes require their own review. See [releasing](releasing.md) for release authorization and artifact checks.
