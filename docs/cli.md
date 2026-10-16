# Dewbow CLI

The `dewbow` executable contains the local daemon and the built Web. Node.js is a development dependency, not a Dewbow runtime requirement. Codex remains a separately installed native dependency.

Use the [standalone installers and upgrade guide](installation.md) for released binaries. `dewbow upgrade --check` checks the latest stable release; `dewbow upgrade` hands off to an independent supervisor and worker, then waits for download, verification, task draining, replacement and startup validation with guarded rollback. `--detach` returns after acceptance; `--status` reads durable progress without launching processes. `--archive` uses a downloaded release; `--recover` resumes an interrupted job or retries blocked recovery. Closing the foreground connection after acceptance does not cancel the upgrade.

## Build and prerequisites

Use the stable Rust 1.99.0 pinned in `rust-toolchain.toml`, Node.js 24.21.0 and npm 12.2.0 with the committed root lockfiles. Follow [workspace setup](workspace.md#setup-and-builds) to verify the active versions before running these commands from the repository root. mise is an [optional local environment manager](workspace.md#optional-local-environment-management). On Windows, install the MSVC C++ build tools and Windows SDK if they are missing.

```sh
npm ci
npm run build
cargo build --workspace --bins --examples
```

Build Web assets before Cargo: the daemon embeds `apps/web/dist`. A build without those assets can compile for library tests, but daemon startup refuses to serve an incomplete application. Use `cargo build --release --bin dewbow` after the Web build for the standalone executable. Keep build artifacts out of Git.

The native integration targets the independent Codex CLI 0.162.1. Install the official standalone distribution, retaining its companion binaries and resources. Do not replace Desktop's bundled runtime. On Windows, the official signed installer can be used:

```powershell
$env:CODEX_NON_INTERACTIVE = '1'
$installer = Invoke-RestMethod https://chatgpt.com/codex/install.ps1
& ([scriptblock]::Create($installer)) -Release 0.162.1
codex --version
codex login status
```

If another installation precedes it on PATH, select the independent executable explicitly. Existing Codex login, native conversations and configuration are retained.

## First start

```sh
dewbow init --codex-executable <standalone-codex-executable>
dewbow doctor
dewbow web
```

`init` creates private configuration and a stable host ID in Dewbow's state directory: its private local data directory for configuration, management storage, runtime ownership files and daemon diagnostics. It defaults to `~/.dewbow` (`%USERPROFILE%\.dewbow` on Windows or `$HOME/.dewbow` on POSIX). See [state directory operations](operations.md#state-directory) for file purposes and selection rules. `web` starts the background daemon if necessary, opens the browser with a one-use login link, and prints the ordinary loopback URL. No model turn is started automatically. Direct unauthenticated visits show instructions to use the CLI.

For a checkout demo with separate Dewbow state, use an ignored state directory and another available port:

```sh
dewbow --state-dir state/demo init --codex-executable <standalone-codex-executable> --port 3240
dewbow --state-dir state/demo doctor
dewbow --state-dir state/demo web
dewbow --state-dir state/demo daemon status
dewbow --state-dir state/demo daemon stop
```

All commands accept `--state-dir <directory>`; use the same directory for initialization and subsequent commands. Relative paths such as `state/demo` are resolved from the current working directory. Initialization also accepts `--codex-home` for native Codex conversations and credentials; otherwise the normal `CODEX_HOME` or `~/.codex` is used. Changing `--state-dir` alone does not change Codex home. Conversation working files use their own `workDir`. Existing configuration is preserved. Conflicting initialization options fail instead of overwriting it; edit private configuration while stopped, or choose another state directory.

## Lifecycle

`daemon run` runs in the foreground. `daemon start` launches a user background process and waits for storage, native initialization and the Web listener. Repeating start returns the existing ready instance. `daemon status` verifies the protected local endpoint against the saved instance identity. `daemon stop` shuts down its owned Codex process and verifies both process exit and listener release. There is no system service or boot startup.

An occupied port is never adopted. `daemon start`, `daemon stop`, foreground `daemon run` and an actual upgrade recover stale instance records under the daemon lock. Recovery validates the record and configured port, verifies that both recorded daemon and native processes have exited, and reserves the port before removing the record. A live or reused PID, held lock, occupied port, invalid record or configuration mismatch requires manual inspection; recovery never kills a recorded PID or resets a database. `daemon status` and `upgrade --check` remain read-only. Do not erase native Codex storage to repair Dewbow state.

Linux and macOS handle `SIGINT`, `SIGTERM` and `SIGHUP` through the same shutdown path as `daemon stop`, stopping the owned native runtime before removing the instance record. Windows handles delivered console Ctrl+C, Ctrl+Break, close, logoff and shutdown events. Detached Windows background processes use `daemon stop`; console events are not a Windows service-control implementation, and forced termination cannot perform graceful cleanup. A subsequent start recovers a forced exit only after the ownership checks above pass.

## Network membership

Network membership is available through the selected running local daemon. Initialize and start each daemon first. Members are peers: every active member can invite another host or remove any member, including the founder or itself. LAN or existing VPN reachability is required. There is no coordinator, automatic discovery, NAT traversal, relay or remote native-session access in these commands.

Choose an available explicit HTTPS Peer port and a reachable address for each node. The Peer listener is separate from the loopback operator listener. For example, on the first machine:

```sh
dewbow daemon start
dewbow network create Personal --listen-endpoint https://0.0.0.0:7443 --advertised-endpoint https://192.0.2.10:7443
dewbow network invite
```

These documentation addresses are placeholders; substitute reachable addresses on your LAN/VPN. Repeat `--advertised-endpoint` for up to eight addresses. Neither endpoint may use port zero. Creation and joining require listener and advertised settings on first use; later invocations may omit them to reuse saved settings. A settings change stops the previous Peer runtime, drains its work and starts the replacement. A bind failure returns an error without reporting membership success; `network status` shows retained settings and `peerListenerStatus`. Correct settings through a new create/join invocation before admission. A failed rebind does not stop local conversations.

Transfer the invitation through a trusted channel. On the joining machine:

```sh
dewbow daemon start
dewbow network join --listen-endpoint https://0.0.0.0:7443 --advertised-endpoint https://192.0.2.11:7443
```

Paste the invitation at the prompt, or use `join --invitation-stdin` with one invitation line supplied by a trusted input source. Invitations are sensitive credentials; avoid shell history, process arguments, files in version control and diagnostic logs. Only `network invite` outputs the token. An invitation expires after ten minutes and permits one admission; possession alone cannot approve a join.

On the inviting machine, inspect and confirm the exact joining host and key:

```sh
dewbow network pending
dewbow network confirm <joinAttemptId> --public-key <publicKey>
# Alternatively:
dewbow network deny <joinAttemptId>
```

`pending` shows `hostId`, the full public key and its SHA-256 fingerprint. The joining command reports its own host, public key and fingerprint; `status` also exposes the pending joining key. Compare these values through your trusted channel. Confirmation checks the full key, current issuer authority, invitation expiry and complete causal context again at commit. A daemon restart discards pending prompts; the joiner automatically resubmits its retained attempt while the invitation is usable. A committed approval or denial is recovered without another prompt. The joining daemon polls and validates complete admission history before reporting `active`; `joining` and an issuer's approval do not by themselves establish readiness.

```sh
dewbow network status
dewbow network members
dewbow network remove <membershipId>
dewbow network leave
dewbow network set-peer-address <membershipId> https://192.0.2.12:7443
dewbow network --json status
```

`membershipId` identifies an exact admission generation, rather than a name or IP. `remove` can target the founder, an offline peer or self without target consent; self-removal is a leave. Removal changes authority and preserves conversations, working files, native credentials, receipts and admitted tasks. Joining starts no conversation or model turn. Readmission requires a new invitation and key. Leaving an already inactive generation detaches it idempotently.

Status distinguishes `none`, `joining`, `active`, `left` and `removed`. `joinStatus` shows the retained join phase and `joinRequestId`/`joinAttemptId` identify recovery. Members show current membership separately from a recent authenticated reachability observation; `unknown` is not removal. Dissemination lists confirmations from known peers only. Current-history acknowledgements are volatile and become pending again after restart or another history change. Departure acknowledgements are durable and scoped to the exact recipient generation. Neither proves that every undiscovered peer has received a change.

An offline self-exit takes effect locally immediately and retains departure delivery tasks. Keep the daemon running, or restart it later, to continue bounded delivery retries. The old key has only restricted departure/proof authority. Fresh membership and old departure tasks remain separate. A replacement key at the same address cannot acknowledge an old recipient's task. Forks retain accepted history; cross-branch self-departure uses the verified recipient view without selecting it locally.

Every mutation accepts `--request-id <id>` and prints the selected ID to stderr before sending. After a lost response, repeat the identical command and input with that ID. Changed input fails with `REQUEST_CONFLICT`. Do not generate a new ID or key to resolve an uncertain join. Joining automatically recovers retained attempts while the daemon runs, including proof-only recovery when the issuer no longer has its old TLS key. An untrusted negative result cannot cancel uncertainty. `--json` emits one JSON result on stdout; ordinary output uses indented JSON. All Network commands honor `--state-dir` and require a running daemon; they never open the management database independently. Maintenance blocks mutations and permits status reads.

## Validation

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --bins --examples
node scripts/test-rust.mjs
node --test scripts/tests/rust-daemon.test.mjs scripts/tests/network-lifecycle.test.mjs
```

The Rust acceptance script uses an explicitly marked synthetic Codex home and the compiled SDK fixture. It covers lifecycle, operator authentication, deduplication, questions, approvals, streaming, Unicode content and restart recovery. Recovery checks force daemon termination, verify automatic stale-record recovery and refusal of live PIDs, occupied ports and invalid records, and send `SIGINT`, `SIGTERM` and `SIGHUP` to foreground daemons on Linux/macOS. Windows checks send a real Ctrl+Break event to a synthetic foreground daemon in its own hidden console. Both paths verify native process exit, instance cleanup and port release. Rust replacement tests exit subprocesses before backup, after backup and after the atomic switch, including replacement of the running test executable. Upgrade supervisor tests disconnect the foreground client, kill workers and supervisors, restart after losing both, preserve post-commit request receipts, and retry bounded recovery after repairing a synthetic corrupt backup. POSIX tests hang up the frontend's process group; Windows tests close a kill-on-close Job Object and refuse a host that forbids breakaway before maintenance. Separate durable checkpoints cover uninitialized installations. Run successful detachment tests from a host that permits job breakaway; a restrictive test harness is expected to reject handoff. The CI matrix runs these checks on Linux, Windows and both macOS architectures. Synthetic checks and CI builds do not establish real native or multi-machine acceptance. Keep actual screenshots and results in ignored local directories.
