# Dewbow Core host daemon

`@dewbow/core-host-daemon` owns a local Codex app-server over stdio. It initiates an authenticated WebSocket connection to the Control Plane and journals managed session metadata, command fingerprints, approvals and management events in SQLite. Browser lifetime does not affect its runtime. One app-server can run independent turns for separate conversations; each conversation permits one active or unresolved turn.

The public `discoverSessions` and `readSessionHistory` methods call the read-only SDK. The authenticated host connection also exposes these reads to Control Plane clients. All discovered conversations, including archived and child conversations, can be listed and read without importing their catalog or messages into Dewbow SQLite. New sessions create native conversations. Explicit `connectSession` requests use SDK `CodexRuntime.connectSession` to resume an existing native ID without a fork or a new model turn. The daemon controls it after Codex confirms an idle connection. Native writer locks reject conflicting ownership; the daemon does not stop Desktop or CLI processes. Connected conversations use the existing send, approval, interrupt, and restart recovery flow. `runtimeState` reports observed Codex execution separately from `connectionState`. Failed connection requests leave runtime observations unchanged. Only confirmed connections, or unresolved owned turns, qualify for automatic recovery; an unsuccessful first connection is not retried by a restart.

## Local prerequisites and configuration

Use the workspace's pinned Node.js/npm and a Codex CLI supporting the app-server v2 methods and events described in [Interfaces](interfaces.md). The initial integration targets Codex CLI 0.162.1. Run `codex --version` and complete local `codex login` setup before starting the daemon. Native credentials remain in that machine's Codex home. No Control Plane credential is used for model access.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEWBOW_HOST_ID` | Required | Stable operator-configured identity matching a permitted-host entry |
| `DEWBOW_HOST_TOKEN` | Required at startup | This host's separate bearer credential |
| `DEWBOW_CONTROL_PLANE_URL` | `http://127.0.0.1:3000` | Control Plane origin; HTTPS required across machines |
| `DEWBOW_HOST_STATE` | `state/host-daemon.sqlite` | Private daemon journal; one journal per identity |
| `CODEX_HOME` | Codex/SDK default | Local native Codex configuration and history |
| `DEWBOW_CODEX_EXECUTABLE` | `codex` | Installed executable |
| `DEWBOW_CODEX_MODEL` | Native Codex configuration | Creation-time model default; session overrides take precedence and recovery uses the saved snapshot |

Create the work directory before `createSession`. The daemon checks that it is an absolute, existing directory with read, write, and traversal access, then stores its canonical path. Invalid directories return `INVALID_WORKDIR` without creating a Codex thread. Every turn uses the selected saved conversation and work directory.

Run from the repository root with credentials configured outside Git:

```sh
npm ci
DEWBOW_HOST_ID=example-host npm run core:host-daemon -- --check
npm run core:host-daemon
```

`--check` validates identity and URL configuration without opening storage, reading Codex, starting a process, or connecting to the service. Normal startup creates the journal, checks previous process ownership, initializes app-server, recovers saved conversations, and connects to the Control Plane. Ctrl+C or SIGTERM stops the owned runtime and closes storage and transport. Sanitized logs contain only component and connection/runtime status. Raw native stderr and RPC diagnostics are not forwarded.

Only loopback connections can use HTTP/WS. For a second machine, configure a reachable HTTPS origin and trust its certificate through the normal system/Node trust setup (for a private CA, `NODE_EXTRA_CA_CERTS`). Do not disable verification. Use a distinct host ID, credential, and local journal; retain that identity when reconnecting.

## Execution, approval, and interruption

Threads use `workspace-write`, `on-request`, and the native `user` approvals reviewer. The external management agent cannot change sandbox or approval authority. Command-execution and file-change approval callbacks become distinct management approval records. Allow/Deny is delivered only to the exact pending callback and active turn. No session-wide approval or policy amendment is applied. Other native callbacks are rejected as unsupported and produce a visible event rather than receiving an invented answer.

Created sessions accept the model, reasoning effort and appended instructions described in [Agent configuration and session snapshots](interfaces.md#agent-configuration-and-session-snapshots). The daemon resolves and journals the configuration before native creation, verifies the native response, and uses that immutable snapshot on reconnect/restart. It composes instructions once; recovery sets the saved complete additional developer instruction string without appending. The host's project/user config and `DEWBOW_CODEX_MODEL` are not reapplied as defaults to these saved sessions. Native adoption without a definition has no agent snapshot and does not apply the host model default. MCP, skills and tool environment remain host-managed.

A send records the user input and acceptance before `turn/start`. Native turn and thread IDs remain separate from management IDs. The daemon captures assistant deltas and completed replies, tool names/commands/status, plan progress, approvals and state changes. It excludes reasoning, raw account/configuration RPCs, arbitrary tool arguments/results, and native stderr. Known environment credentials are redacted from retained payloads. Do not ask tools to print private credentials into conversation text.

`turn/interrupt` acknowledges only delivery. A `turn/completed` notification with `interrupted` confirms stopping. Normal completion requires native `completed`; native `failed` produces `EXECUTION_FAILED`. Silence, disconnects, and closed browsers never produce completion.

## Reconnect and crash recovery

The daemon keeps running on a transport disconnect or configured host revocation. It reconnects after two seconds. It first replays persisted events after the Control Plane's metadata cursors, reports current state and command results, and waits for `ready`. Events accumulated during this handshake are flushed too. Commands are journaled before runtime dispatch. Identical command retries use saved results; unresolved commands are not executed again after restart.

A runtime exit makes active turns unknown, records recovery events, closes the connection and exits the daemon with a failure status. Normal daemon shutdown waits for the app-server process to exit. A second daemon using the same state file is rejected while its recorded daemon or runtime PID is alive; a failed duplicate startup does not remove the original owner's record.

After a daemon crash, inspect the private journal's recorded process IDs locally. If an owned process is still alive, verify its identity and stop it before restarting; do not kill an unrelated process merely because its PID was reused. Restart then calls `thread/resume` without sending input. Only after previous owned processes are stopped and Codex confirms a usable, non-active conversation may the old turn become a confirmed interrupted or saved terminal result. Saved metadata alone never establishes resumed execution. Pending callbacks from an ended runtime are invalidated.

If thread resume fails or Codex reports active execution, the session stays unknown and rejects follow-ups. Verify/stop local execution and retry daemon startup. Do not edit the journal to bypass unresolved state. A creation interrupted before its Codex thread reference was saved cannot be automatically adopted; inspect and stop any orphan locally, then create a new managed session. An empty native thread created before its first message may not be resumable after a runtime restart; it stays unknown, and the operator may create a new managed session after verifying that no turn ran. The daemon does not restore tool subprocess side effects or reconstruct missing native history.

Missing or incompatible snapshots also require recovery rather than fallback. Journals predating `sessionConfig` are unsupported; stop the services and recorded runtime, archive the Dewbow journals and start with fresh state as documented in [Operations](operations.md#resetting-dewbow-state-after-contract-changes). Native Codex conversations and credentials are preserved. No data migration or compatibility conversion is provided.

## Validation

```sh
npm run build
npm run typecheck
npm test
DEWBOW_HOST_ID=example-host node apps/core-host-daemon/dist/cli.js --check
git diff --check
```

The critical daemon integration test runs a synthetic app-server subprocess and transport. It protects command deduplication, process ownership, conversation continuity, busy sessions, exact approval routing, independent sessions, confirmed interruption, event replay, and restart recovery including the command/turn write gap. It uses temporary synthetic data and no native Codex credentials. Actual Codex and two-machine smoke checks are separate from CI.

## Native data and journal contents

Codex remains the source of saved conversation metadata and chat messages. Discovery caches live only in memory. SDK history reads the native read-only history projection. A confirmed, connected Dewbow-created conversation with no recorded turns returns an empty message page when Codex has not yet indexed its history and no message cursor was supplied. Missing history after a turn, discovered or adopted native conversations, disconnected or unresolved sessions, and other storage errors remain visible, with no fallback to a Dewbow message copy. Read-only queries do not start or resume conversations. A native writer lock is distinct from an active model turn.

Dewbow SQLite contains execution ownership, native conversation mapping, request IDs and input fingerprints, management turns, approvals and event positions. It does not contain user messages, assistant text or assistant plan text. A command fingerprint is computed from the original input; only its metadata is journaled. Current message input and assistant deltas are transient. Native Codex persists its own conversation as usual. The daemon owns the durable event history, served through authenticated `events` queries with exclusive cursors. Streaming text is held only in volatile reply caches until native saved history catches up; stripped event references cannot reconstruct lost text. Obsolete Dewbow tables are recreated during early development; there is no legacy-data migration.
