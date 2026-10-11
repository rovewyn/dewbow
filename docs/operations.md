# Install, operate, and verify the MVP

The Control Plane serves the built Web and owns its SQLite journal. Each host daemon owns a separate journal and a local Codex app-server. MCP and Web share the management service. See [interfaces](interfaces.md), [Control Plane](control-plane.md), [host daemon](host-daemon.md), and [Web](web.md) for the concrete contracts and configuration.

## One reproducible local setup

Use Node.js 24.21.0 LTS, npm 12.2.0, and Codex CLI 0.162.1 with local model access configured through `codex login`. Node's built-in SQLite is required. Commands below target macOS and Linux. CI checks both platforms with synthetic data; a native Codex run is a separate acceptance step. Windows is not part of this setup path.

From the checkout root:

```sh
npm ci
npm run build
codex --version
codex login status
npm run local:init
```

The initializer creates ignored, owner-only files in `state/local/`. Existing files are preserved, so rerunning it does not rotate credentials or erase history. It creates three distinct credentials, a permitted `local-host`, environment files, a private MCP configuration, and an empty work directory. Do not delete only one of these configuration files to rotate a credential; update its associated service/client configuration together.

Start services in separate terminals, from the same checkout root:

```sh
# Terminal 1: Control Plane and built Web
npm run local:control-plane

# Terminal 2: local Codex runtime and host connection
npm run local:host-daemon
```

Open `http://127.0.0.1:3000`. Use the `operator` value in the private `state/local/credentials.json` for Web login. The Web has no separate production listener. `/health` only establishes listener availability; a connected machine plus a completed native turn establishes the execution path.

| Local file | Owner and purpose |
| --- | --- |
| `control-plane.env` | Control Plane configuration and management/operator credentials |
| `host-daemon.env` | This daemon's identity, credential, URL and journal |
| `agent.env` | External management client credential and URL |
| `mcp.json` | Private example client configuration containing the management header |
| `hosts.json` | Permitted-host identities and credentials |
| `control.sqlite` | Control Plane management metadata, decisions, deduplication and operator cookies |
| `daemon.sqlite` | Local owned sessions, process IDs, event journal and command results |
| `workdir/` | Existing work directory for the local smoke run |

Keep the directory and credentials private. SQLite WAL/SHM files belong to their databases. Back up storage while both services are stopped. Native Codex credentials and conversation files remain in the local Codex home and are also needed for continuity. Management credentials do not provide model access.

## Connect an external MCP client

Use Streamable HTTP at `http://127.0.0.1:3000/mcp` with `Authorization: Bearer <management-credential>`. The ignored `state/local/mcp.json` is an example; adapt its `mcpServers` wrapper to your client's settings format. Keep the real header out of browser storage and version control. Eight tools are exposed; approval decisions are operator-only.

For a Codex CLI client, configure the URL with its documented command:

```sh
codex mcp add dewbow --url http://127.0.0.1:3000/mcp --bearer-token-env-var DEWBOW_MANAGEMENT_TOKEN
```

Start that client with the management environment loaded. For example, Node can load the private file and start the interactive client without putting the credential on the command line:

```sh
node --env-file=state/local/agent.env --input-type=module -e 'import {spawnSync} from "node:child_process"; const result = spawnSync("codex", [], {stdio:"inherit", env:process.env}); process.exitCode = result.status ?? 1;'
```

Ask the agent to list hosts, create a session in an existing absolute work directory, send a message, poll progress/history, and send a follow-up. Only pass the management credential to that client. The daemon strips Dewbow credentials from the native Codex child environment.

## Automated native smoke run

The script calls real MCP, creates new managed conversations, runs two message turns per conversation, and retains those sessions for inspection. It checks authentication rejection, create/send retry IDs, changed-input conflicts, busy rejection, independent sessions, conversation continuity, and ordered event pagination. It does not decide approvals or change native permissions.

```sh
npm run local:smoke -- local-host "$PWD/state/local/workdir"

# Two independent conversations on the same actual host
npm run local:smoke -- local-host "$PWD/state/local/workdir" local-host "$PWD/state/local/workdir"
```

The script writes a private `outputs/smoke-<timestamp>.json` containing IDs, states and event positions, without credentials, raw native logs, message history or work-directory paths. A failure keeps its partial trace and any accepted sessions. Inspect those IDs before retrying; the script starts new conversations on a new run. Completion means a native turn ended, not that an arbitrary task was correct.

## Add a second actual machine

The second machine is started manually by the operator. Install the same checkout revision, runtimes and Codex CLI, run `npm ci` and `npm run build`, and authenticate Codex locally. Choose a distinct stable host ID and random host credential. Add its entry to the Control Plane's private `hosts.json` using the [example](examples/hosts.json). IDs and credentials must be unique. Copy only that host's credential to the second machine.

Before crossing machines, configure a reachable HTTPS/WSS origin. Set `DEWBOW_CONTROL_PLANE_HOST` to the desired interface, `DEWBOW_PUBLIC_ORIGIN` to the exact reachable HTTPS origin, and `DEWBOW_TLS_CERT`/`DEWBOW_TLS_KEY` to a trusted certificate/key pair. Restart the Control Plane. Both daemons and external clients must use that origin. Use a certificate trusted by the browser and Node; a private CA can be supplied to Node with `NODE_EXTRA_CA_CERTS`. Certificate verification remains enabled. Network exposure, certificate provisioning and firewall rules are operator configuration.

On the second machine, copy [host-daemon.env.example](examples/host-daemon.env.example) to a private ignored file such as `state/second-host.env`. Set its host ID, credential, HTTPS URL, and local journal path. Create the selected work directory there, then run:

```sh
node --env-file=state/second-host.env apps/host-daemon/dist/cli.js
```

Wait until Web/MCP lists two distinct connected hosts. From a client with the updated HTTPS management environment, run:

```sh
node --env-file=state/agent.env scripts/smoke.mjs local-host /absolute/workdir/on/first-host second-host /absolute/workdir/on/second-host
```

Paths refer to the selected host's filesystem, not the client machine. Record each actual machine's OS and Codex version with the private acceptance artifacts. A second daemon or mock transport on the first machine is not two-machine acceptance.

## Human interaction and recovery runbook

Keep evidence in ignored `outputs/`; do not publish native history or machine paths in commits or PRs.

| Check | Procedure and expected observation |
| --- | --- |
| Allow | In Web, send `Request human approval to run printf dewbow-allow with sandbox_permissions require_escalated. Run it once if allowed; do not retry if denied.` Inspect the exact command/host/turn, then Allow. Observe requested, delivered and resolved decision events and native command completion. |
| Deny | Repeat with `printf dewbow-deny`, then Deny. Observe the decision and the command's declined state. Reusing a stale/mismatched callback through the API must fail; CI protects this boundary. |
| Interrupt | Send `Run sleep 120. If the command yields, poll it with write_stdin until it finishes. Do not request elevated permissions.` During an active turn, Interrupt. Delivery is not the terminal result; wait for native `interrupted`. A model may finish a turn while leaving a tool session running, so target an observed active turn. |
| Browser independence | While a turn is active, refresh, close Web, and poll `getSession` through MCP. Reopen the same `#session=<id>` URL. Execution and accumulated event history remain owned by the daemon; history reads require an available host. |
| Independent work | Start work in two different conversations while one awaits approval or is running. Both have separate native conversation references and turn IDs. A second send to the busy conversation returns `SESSION_BUSY`. |
| Transport loss | Stop only the Control Plane while a native turn is active; leave the daemon running. Restart the same Control Plane journal. It initially shows disconnected/unknown, then reconciles and replays. IDs stay stable and event IDs do not duplicate. No disconnect is reported as completion. |
| Daemon restart | Stop the daemon with Ctrl+C during an active turn, then start it with the same journal/native home. Check actual native recovery. The old turn becomes confirmed stopped/terminal only when Codex reports a usable non-active conversation; otherwise it remains unknown. Follow-up uses the saved native thread after recovery. |
| Invalid credentials | Wrong management and operator credentials must be rejected. A wrong host credential must never show connected. The automated service test covers these cases with synthetic transports. |
| Revocation | Set the host's `revoked` field to `true`. A management request or the next heartbeat reloads it and closes the connection. New commands/reconnects are rejected. Local native execution may continue; stop the daemon on that machine. Restore permission only when intended. |
| Uncertain delivery | Inspect `getSession`, operation state and history; retry with the original request ID/input. Do not change request IDs to bypass an unresolved turn. |

For unresolved execution, inspect the private daemon journal's `meta/owner` record and verify recorded daemon/runtime PIDs against the actual processes. Stop only verified owned processes, then restart the daemon. `thread/resume` must confirm a usable non-active saved conversation before follow-up is enabled. If it fails, keep the session unknown and inspect local Codex state. Do not edit the journal to force idle. A create interrupted before saving its native thread cannot be adopted automatically. An empty native thread created before its first message may also be unavailable for resume; keep it unknown and create a new session only after verifying that no turn ran. The runtime does not restore arbitrary tool subprocess effects or missing native history.

Service stdout contains sanitized component/status messages. To retain it locally:

```sh
mkdir -p logs
npm run local:control-plane > logs/control-plane.log 2>&1
npm run local:host-daemon > logs/host-daemon.log 2>&1
```

Raw native stderr is not forwarded. Keep shell diagnostics and acceptance traces private too. Stop each foreground service with Ctrl+C or send SIGTERM to its verified process. The daemon waits for its app-server to stop; the Control Plane closes sockets and storage. Stopping the Control Plane alone does not stop host execution. Verify the listener port is released before restarting on the same address. No system service, automatic boot startup, container, or cloud deployment is installed by this path.

## Acceptance record

Record the checkout commit, each actual host's OS/Codex version, MCP client/version, request/session/turn/approval IDs, terminal states, replay cursor ranges, and the observed recovery limits in a private report. Reference the native smoke JSON and Web screenshots. Keep simulated CI checks separate from actual runs. The [MVP checklist](mvp.md#acceptance-checklist) is complete only after the operator runs and records the second actual machine.

## Resetting Dewbow state after contract changes

The current `v1` contract uses camelCase JSON fields and verb-first camelCase operations. Old clients, permitted-host files and journals are unsupported. Update all services and clients together. No compatibility aliases or data conversion run during startup.

Managed session records now also require `sessionConfig`: a creation-time override/resolved snapshot for new sessions, or explicit `null` for native connections without an agent definition. Journals predating this field must be archived and replaced. Do not backfill snapshots from the latest Team definition or host defaults; those values cannot establish the original session configuration.

Before using this contract with existing state, stop the Control Plane and every daemon. Inspect each daemon's recorded owner and verify that its owned Codex runtime has stopped. Archive the old Dewbow journal files together with their SQLite `-wal` and `-shm` companions, then start the services with fresh Dewbow journals. Preserve the archive for local inspection. An unsupported ownership record returns `RECOVERY_REQUIRED` rather than being treated as evidence that its processes stopped.

Use a permitted-host file matching the current example, with `hostId`. The local initializer preserves existing files and will not replace an old `hosts.json`; prepare that configuration explicitly. Keep credentials private. Preserve native Codex conversations, credentials and unrelated files. Native conversations can be discovered and connected again; old Dewbow management IDs, requests and event history are not imported.

## Native discovery and message ownership

The daemon uses the existing SDK to list native conversations and read their saved chat on demand. The Web list includes archived and child conversations and provides name, directory and ID search. Select an SDK-discovered conversation and click Connect conversation to continue it through the daemon. This resumes the original native ID and context. If another runtime holds its writer lock, release the conversation there before retrying. Connection adds execution metadata only; messages remain in native Codex storage. A catalog snapshot is transient and refreshes about every ten seconds. Native storage and runtime observations can be partial; source outcomes and read errors remain explicit.

The daemon SQLite journal stores management metadata, approvals, request fingerprints and event history, never user or assistant message bodies. Control Plane SQLite stores its own requests and decisions plus routing/state summaries and cursors, with no event table. Saved chat belongs to Codex and requires a connected host for reading. This early-development update recreates obsolete Dewbow tables instead of migrating them. Stop the Control Plane, daemon and recorded runtime before starting this revision with old state; management IDs, requests, approvals and event history from the old schema are discarded. Native Codex conversations and credentials are preserved. Update all services and clients together with the contract pinned to v1. A browser may retain already loaded messages in memory during a disconnect.

Pending sends keep their bodies in memory. A Control Plane restart cannot automatically deliver a body it no longer has. Keep the original message and request ID in the management client and retry them together; changing the ID can create another operation. An unresolved original turn remains busy until reconciliation or the original retry establishes its outcome. The native smoke script validates conversation continuity from SDK messages, not copied event text.
