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

The commands below describe the current implementation. Check the source and target [release notes](release-notes/README.md) for command availability, supported state formats and release-specific upgrade or rollback requirements. Follow [management storage and compatibility](storage.md) when an upgrade changes persisted state.

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

Upgrade hands the request to an independent supervisor and worker running a retained copy of the current executable. The foreground command waits and reports progress by default; closing its terminal or losing the remote connection after acceptance does not cancel the job. Use `--detach` to return once accepted and `--status` for read-only durable progress and the final outcome:

```sh
dewbow --state-dir <state-directory> upgrade --detach
dewbow --state-dir <state-directory> upgrade --status
```

Repeating `upgrade` attaches to the pending job for this installation and state instead of creating a competing upgrade. A different version or state is refused while that job is pending. `--status` does not launch processes or recover files; `pending` reports a durable incomplete job, not proof that its processes are alive. A handoff error or timeout is unconfirmed: inspect status and repeat the command to resume it.

Upgrade downloads and verifies the candidate while the selected daemon continues serving. The verified candidate is retained as a recovery checkpoint before maintenance. It then enters maintenance: new conversations, connections and sends are refused; existing turns can finish through steering, answers, approvals and operator interruptions. Accepted management requests and active or unresolved turns must all finish before stopping. The default wait is 300 seconds; `--wait-seconds <seconds>` changes it, including zero for idle-only upgrades. A timeout aborts without interrupting turns and resumes admission. Losing the frontend does not release maintenance; if the worker itself exits while draining, its 30-second lease expires and admission resumes automatically.

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

The installation directory must be writable and its filesystem must support hard links and atomic replacement. Windows also requires support for `FileRenameInfoEx` POSIX replacement of a running executable. Unsupported operations fail without moving the original executable aside; there is no fallback to a two-step replacement. Run the command with the same user authority that owns the installation; use a user-owned directory if it is not writable. The retained runner uses that same authority and never requests elevation. Linux/macOS synchronize the installation directory before and after replacement; Windows has no equivalent directory synchronization through Rust's standard filesystem API. Process-interruption tests do not establish hardware power-loss guarantees.

On Linux/macOS, runners use a new session without a controlling terminal and have private log handles rather than launcher pipes. On Windows, they inherit no handles or console and must escape the caller's Job Object before running. A host policy that forbids job breakaway causes handoff to fail before maintenance; see Microsoft's [job object process rules](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). These are user processes, not system services. Host reboot, session-wide termination, container teardown or a policy that kills the entire user/cgroup can terminate both controllers. No boot startup is installed; durable recovery runs at the next supported command.

Job checkpoints and state commit/rollback markers are staged and flushed before an immutable hard link publishes the complete record. The selected state's recovery filesystem must also support hard links. Process exit before publication leaves only an ignored staging file; a published marker is always complete. Retained staging files belong to the same private recovery data and can be reviewed with its backups after acceptance.

## Recovery and package managers

Recover an interrupted, uncommitted upgrade from the installed executable:

```sh
dewbow --state-dir <state-directory> upgrade --recover
```

The supervisor detects worker exit and resumes from durable checkpoints. A surviving worker replenishes a lost supervisor. Recovery covers the interval after stopping the old daemon but before publishing its state snapshot, as well as replacement and validation. The job permits three execution/recovery attempts per round; repeated failures end in `recoveryRequired` with checkpoints retained. Resolve the reported ownership, configuration or file problem, then use `upgrade --recover` to start another bounded recovery round.

If both controllers exit, `init`, `web`, `daemon start` and foreground `daemon run` resume a matching pending job before starting normal service. Startup continues with the installed executable selected by recovery, including when its image changed during the command. Repeating `upgrade` also resumes it. A different state directory is never adopted automatically. Startup blocks on `recoveryRequired`; inspect `upgrade --status` and recover explicitly after repair. Diagnostics, status and stop commands remain available for inspection.

Recovery stops only the exact authenticated instance still sealed by this transaction, confirms ownership has ended, and restores and validates the preceding version. It preserves the original running/stopped choice. Partial restoration can be retried from the immutable snapshot. A pending transaction keeps startup sealed; do not delete it to bypass validation. If ownership or files cannot be verified, resolve the reported condition and retain private files for inspection. After durable commit, a lost completion record triggers availability checks, without restoring the preceding database or undoing accepted requests. An uninitialized installation uses a separate binary commit checkpoint and does not create daemon state during recovery.

The private `.dewbow-updater/` directory beside the installed executable owns one installation's handoff lock, retained runner, verified candidate, request, attempts, diagnostics and checkpoints. It is separate from the selected state directory so recovery also works before initialization. Completed jobs are retained as `history-<job-id>` when a later job is submitted. Do not move the installation, delete the runner or remove pending job files during an upgrade. Jobs are tied to the exact installation and state paths; filesystem locks and immutable job identities prevent overlapping workers and delayed children from taking over later jobs. Recorded PIDs are diagnostics, never authority to terminate processes.

After durable commit, automatic rollback is refused because new work may have been accepted. Follow the release's manual rollback guidance and retain a suitable current state backup before changing versions. Never delete native Codex conversations or credentials. `.dewbow-updater/`, previous executable links, `upgrade/`, archived `upgrade-history-*` snapshots and `upgrade-failed-state-*` files are private recovery data. Keep them until acceptance is complete; later upgrades archive the preceding committed transaction. Remove only reviewed backups after all updater processes and the selected daemon have stopped, and keep them out of Git and shared logs.

GitHub Releases are the binary distribution channel in this change. npm workspaces remain private; nothing is published to npm or crates.io. A future npm installer should reuse the checked standalone artifacts and keep upgrades owned by npm. Cargo publication additionally requires publishable versions of the internal crates and a packaged source for the embedded Web assets; the current daemon build reads those assets from the sibling Web workspace. These packaging and publication changes require their own review. See [releasing](releasing.md) for release authorization and artifact checks.
