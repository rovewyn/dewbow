# Local operations

Use the [CLI guide](cli.md) for prerequisites, installation and builds. Dewbow runs one local Rust daemon with embedded Web and an independently installed native Codex CLI.

## State directory

The state directory is Dewbow's private local data directory for configuration, management storage, runtime ownership files and daemon diagnostics. The default is `~/.dewbow`: `%USERPROFILE%\.dewbow` on Windows or `$HOME/.dewbow` on POSIX. It belongs to the selected local daemon instance, and all conversations managed through that directory share its single Dewbow database.

Every CLI command accepts `--state-dir <directory>`. Use the same directory for `init`, `doctor`, `web`, daemon commands and upgrades; omitting the option selects the default directory again. Relative paths are resolved from the command's current working directory. For separate instances, use distinct state directories and available ports. Use an ignored directory for synthetic demos.

Restarting with the same state directory preserves its host identity, managed conversation bindings, frozen configuration, retained request receipts and recovery records. Receipt retention follows the 24-hour minimum retry window described below; restarting does not reset receipt age. Use the original directory to recover an existing instance.

The directory can contain these files:

| File | Purpose |
| --- | --- |
| `config.json` | Private daemon configuration, including the stable host ID, port, control credential and selected native Codex executable/home |
| `daemon.sqlite` | The only Dewbow database: managed conversation bindings, frozen creation configuration, request deduplication receipts and minimum recovery state |
| `daemon.sqlite-wal`, `daemon.sqlite-shm` | SQLite support files for the same database |
| `network-keys/` | Private per-admission PKCS#8 keys, deletion residues and quarantined unreferenced files |
| `migration-backups/` | Verified inactive database/configuration backups from supported storage migrations, with hash manifests |
| `init.lock`, `daemon.lock`, `instance.json` | Initialization locking, exclusive daemon ownership and process identity used for lifecycle checks and recovery |
| `daemon.log` | Daemon diagnostics when written; it is not an archive of conversation content or complete command output |
| `upgrade/`, `upgrade-history-*`, `upgrade-failed-state-*` | Private upgrade transactions and inactive state snapshots retained for guarded recovery; these are not additional runtime databases |

Conversation working files belong to the conversation's `workDir`. Native Codex conversations, history, execution status and credentials belong to Codex home, selected during `init` with `--codex-home <directory>`, otherwise `CODEX_HOME` or `~/.codex`. Selecting a different Dewbow state directory does not itself select a different Codex home. Use separate state and work directories; see [daemon ownership](daemon.md#ownership-and-interfaces) for the durable storage boundary.

### Fresh initialization and request continuity

Initializing Dewbow in an empty state directory creates an independent host identity and set of management records. The stable `hostId` is stored in `config.json`; the request IDs, input fingerprints, target associations and delivery receipts are stored in `daemon.sqlite`. Merely creating a directory does not initialize an instance. A fresh initialization does not import these records from another directory, even on the same computer or with the same Codex home. The old directory's data remains where it was.

For example, a client submits `req-123`, Dewbow sends it to Codex, and the connection drops before the client receives a response. After restarting with the original state directory, an identical retry within the 24-hour window can find the receipt and return its known result or explicit unknown-delivery state without submitting the command again. Older receipts still required for uncertain delivery or active execution remain protected. A newly initialized directory has no such receipt. After connecting the intended native conversation, it can treat that request ID as new and execute it again; deduplication does not span state directories.

Codex history can help establish what happened in the native conversation, but cannot reconstruct Dewbow's complete request identity and delivery associations. An absent receipt in a new directory does not prove a request never ran. Reuse the original state directory for restart recovery, and inspect uncertain outcomes before retrying from a replacement instance. Native Codex conversations and credentials remain in the selected Codex home.

Network storage and protected key recovery are described in [management storage](storage.md#network-storage-foundation). The [Peer transport](network-peers.md) supports explicitly configured listeners, membership synchronization and restricted lifecycle recovery. Use the [Network CLI](cli.md#network-membership) to create, invite, confirm joining, remove peers or leave through the running daemon. Use the target-scoped [Network read API](interfaces.md#network-reads) for remote native-session reads and subscriptions. Remote execution remains unavailable. Keep the daemon running to retry joins and departure tasks; stopped daemons perform no delivery. `DEWBOW_NETWORK_WORKING_BYTES` sets a positive byte count for complete-history validation; increase it if retained history exceeds the default 16 MiB budget. Never delete history to fit the budget or copy a key as a way to join.

### Automatic receipt cleanup

The daemon cleans eligible receipts after startup recovery and every 24 hours while it remains running. The timer belongs to the daemon; there is no OS scheduled task, separate cleanup process or configurable TTL. Shutdown stops the timer. Upgrade maintenance skips cleanup, and checkpointing waits for any cleanup already admitted. A skipped pass is retried at the next daily tick or restart.

The minimum retry window is 24 hours from first acceptance, including time while the daemon is stopped. Only older delivered/error receipts with no active or unresolved turn or retained callback association are removed. Accepted/unknown receipts and required recovery records stay. In normal continuous operation this retains eligible receipts for about 24–48 hours, and unresolved records can remain longer. Removing rows frees reusable SQLite space without an automatic file-shrinking `VACUUM`.

Once a receipt is removed, a retry with that request ID may execute as new work. Inspect the native conversation and reconcile old outcomes before intentionally resubmitting beyond the guaranteed window. Cleanup does not delete native Codex history, change host identity or remove managed sessions. See [receipt retention](storage.md#receipt-retention) for transaction and recovery rules.

## Start, inspect and stop

```sh
dewbow init --codex-executable <standalone-codex-executable>
dewbow doctor
dewbow web
dewbow daemon status
dewbow daemon stop
```

These commands use the default state directory. Initialization accepts `--port <available-port>` as well as the directory options above. Existing configuration and host identity are retained; conflicting initialization options fail.

`doctor` checks private configuration, CLI version and login, and read-only native app-server capabilities. It does not send a model prompt. `daemon run` runs in the foreground; `daemon start` launches a user background process. Readiness requires private storage, initialized Codex and Web. Duplicate starts return the same instance. No system service, boot startup or automatic background update is installed. See [install and upgrade](installation.md) for the explicit `upgrade` command and executable backups.

`web` opens an authenticated one-use local login link. Use its printed plain loopback URL for sharing locally; never share the ticket or private configuration. Unauthenticated direct visits instruct the user to open through CLI. Sign-out clears the operator cookie.

## Windows runtime and private state

Install the official independent Codex distribution and retain its companion executables/resources. Select its executable explicitly when Desktop's alpha runtime precedes it on PATH. Keep Desktop, native home and login intact.

State directories use a protected current-user and SYSTEM ACL on Windows and mode 0700 on POSIX. Files and parent paths reject links/reparse points. Do not use a shared work directory as Dewbow's state directory. Synthetic workspaces belong in a separate ignored directory.

The retained TypeScript protocol helpers allow up to 60 seconds for one Windows PowerShell ACL operation, including startup and validation. Timeouts, a missing helper and nonzero exits stop the operation; private contents are written only after ACL protection succeeds. Errors identify timeouts, missing PowerShell or a numeric exit status without including raw helper output or private paths. Ownership and reparse-point rejection remains mandatory.

The runtime prefers the documented native MXC sandbox on supported Windows devices, while honoring native requirements and fallback. It does not edit Codex configuration, disable native sandboxing or automatically provision legacy sandbox accounts. A device with no permitted functioning native sandbox needs native Codex setup before tool execution.

## Recovery and state resets

Stop the selected daemon before editing or backing up its configuration and management database. Stop verifies instance identity, its own native runtime, daemon process exit and listener release. It never kills an arbitrary saved PID. Start, stop, foreground run and actual upgrades can remove a valid stale instance record only under the daemon lock, after both recorded processes have exited and the matching configured port can be reserved. Invalid records, configuration mismatches, occupied ports and live or reused PIDs still require inspection. `daemon status` and `upgrade --check` never clean up records. Verify ownership and stop only the intended instance; do not stop Desktop or other sessions.

On Linux/macOS, `SIGTERM`, `SIGINT` and `SIGHUP` request the same owned-runtime cleanup as an authenticated stop. On Windows, delivered console stop events use that cleanup; detached background processes should be stopped through the CLI. Forced process termination leaves recovery to the next start after the safety checks above. See [CLI lifecycle](cli.md#lifecycle) for platform boundaries.

An accepted upgrade runs in independent supervisor and worker processes. `upgrade --detach` returns after acceptance; `upgrade --status` reads the persisted outcome without restarting anything. Worker exit triggers bounded recovery, and a surviving worker replaces a lost supervisor. If both exit, the next matching `init`, `web`, `daemon start`, foreground `daemon run` or repeated `upgrade` resumes the job. `recoveryRequired` blocks normal startup until inspection and `upgrade --recover`. Installation-level runner/checkpoint files live in private `.dewbow-updater/` beside the executable; selected state snapshots remain in `upgrade/`. Preserve both until acceptance. See [upgrade recovery](installation.md#recovery-and-package-managers) for boundaries and cleanup.

Unknown delivery after a restart is not successful execution. Inspect the turn, request and native history. Retry the original request only with identical input and request ID; an unresolved turn blocks another send. Old runtime callbacks cannot be replayed. Empty native conversations that cannot resume require explicit recovery rather than silent replacement.

Read the target [release's notes](release-notes/README.md) for supported upgrade sources, migration steps and any exceptional reset requirements. The general preserving upgrade policy is in [management storage and compatibility](storage.md). Inspect uncertain operations before changing management state; native history alone cannot restore a lost deduplication boundary.

For an explicitly authorized reset, including unsupported unpublished development state or synthetic fixtures, stop the daemon and verify its owned native runtime is gone, retain the old private state as a backup, then initialize a fresh directory with `dewbow --state-dir <fresh-directory> init`. This creates a new host identity and independent deduplication/recovery state. Do not remove native Codex home, conversations, credentials or workspace files. Keep backups and local acceptance results out of Git.

## Acceptance

Use dedicated synthetic workspaces and fresh private state for real Codex checks. Discover and inspect existing sessions without continuing private conversations; prepare an independent synthetic native session for adoption. Verify creation, follow-ups, question responses, Allow/Deny, tool output/diffs, interruption and browser refresh. Synthetic CI checks do not substitute for this real environment acceptance.
