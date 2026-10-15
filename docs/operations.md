# Local operations

Use the [CLI guide](cli.md) for prerequisites, installation and builds. Dewbow runs one local Rust daemon with embedded Web and an independently installed native Codex CLI.

## Start, inspect and stop

```sh
dewbow init --codex-executable <standalone-codex-executable>
dewbow doctor
dewbow web
dewbow daemon status
dewbow daemon stop
```

The default private state directory is `~/.dewbow`. Every command accepts `--state-dir <directory>`. Initialization also accepts `--codex-home <directory>` and `--port <available-port>`. Existing configuration and host identity are retained; conflicting initialization options fail. Use a separate ignored directory for synthetic demos.

`doctor` checks private configuration, CLI version and login, and read-only native app-server capabilities. It does not send a model prompt. `daemon run` runs in the foreground; `daemon start` launches a user background process. Readiness requires private storage, initialized Codex and Web. Duplicate starts return the same instance. No system service, boot startup or automatic background update is installed. See [install and upgrade](installation.md) for the explicit `upgrade` command and executable backups.

`web` opens an authenticated one-use local login link. Use its printed plain loopback URL for sharing locally; never share the ticket or private configuration. Unauthenticated direct visits instruct the user to open through CLI. Sign-out clears the operator cookie.

## Windows runtime and private state

Install the official independent Codex distribution and retain its companion executables/resources. Select its executable explicitly when Desktop's alpha runtime precedes it on PATH. Keep Desktop, native home and login intact.

State directories use a protected current-user and SYSTEM ACL on Windows and mode 0700 on POSIX. Files and parent paths reject links/reparse points. Do not use a shared work directory as Dewbow's state directory. Synthetic workspaces belong in a separate ignored directory.

The retained TypeScript protocol helpers allow up to 60 seconds for one Windows PowerShell ACL operation, including startup and validation. Timeouts, a missing helper and nonzero exits stop the operation; private contents are written only after ACL protection succeeds. Errors identify timeouts, missing PowerShell or a numeric exit status without including raw helper output or private paths. Ownership and reparse-point rejection remains mandatory.

The runtime prefers the documented native MXC sandbox on supported Windows devices, while honoring native requirements and fallback. It does not edit Codex configuration, disable native sandboxing or automatically provision legacy sandbox accounts. A device with no permitted functioning native sandbox needs native Codex setup before tool execution.

## Recovery and state resets

Stop the selected daemon before editing or backing up its configuration/databases. Stop verifies instance identity, its own native runtime, daemon process exit and listener release. It never kills an arbitrary saved PID. Start, stop, foreground run and actual upgrades can remove a valid stale instance record only under the daemon lock, after both recorded processes have exited and the matching configured port can be reserved. Invalid records, configuration mismatches, occupied ports and live or reused PIDs still require inspection. `daemon status` and `upgrade --check` never clean up records. Verify ownership and stop only the intended instance; do not stop Desktop or other sessions.

On Linux/macOS, `SIGTERM`, `SIGINT` and `SIGHUP` request the same owned-runtime cleanup as an authenticated stop. On Windows, delivered console stop events use that cleanup; detached background processes should be stopped through the CLI. Forced process termination leaves recovery to the next start after the safety checks above. See [CLI lifecycle](cli.md#lifecycle) for platform boundaries.

Unknown delivery after a restart is not successful execution. Inspect the turn, request and native history. Retry the original request only with identical input and request ID; an unresolved turn blocks another send. Old runtime callbacks cannot be replayed. Empty native conversations that cannot resume require explicit recovery rather than silent replacement.

To reset obsolete Dewbow state, stop the daemon and verify its owned native runtime is gone, then retain the old private state as a backup and initialize a fresh directory with `dewbow --state-dir <fresh-directory> init`. Startup rejects earlier Rust state containing a separate content database or the obsolete journal schema. Old Rust and TypeScript management databases are not imported or deleted. Do not remove native Codex home, conversations, credentials or workspace files. Keep backups and local acceptance results out of Git.

## Acceptance

Use dedicated synthetic workspaces and fresh private state for real Codex checks. Discover and inspect existing sessions without continuing private conversations; prepare an independent synthetic native session for adoption. Verify creation, follow-ups, question responses, Allow/Deny, tool output/diffs, interruption and browser refresh. Synthetic CI checks do not substitute for this real environment acceptance.
