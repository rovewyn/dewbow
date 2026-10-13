# Install, operate, and verify the MVP

The Control Plane serves the built Web and owns its SQLite journal. Each host daemon owns a separate journal and a local Codex app-server. MCP and Web share the management service. See [interfaces](interfaces.md), [Control Plane](control-plane.md), [host daemon](host-daemon.md), and [Web](web.md) for the concrete contracts and configuration.

## One reproducible local setup

Use Node.js 24.21.0 LTS, npm 12.2.0, and Codex CLI 0.162.1 with local model access configured through `codex login`. Node's built-in SQLite is required. The local service commands support Windows, macOS, and Linux. CI checks all three platforms with synthetic data; a native Codex run is a separate acceptance step. With mise, prefix commands with `mise exec --` to select the pinned runtime.

From the checkout root:

```sh
npm ci
npm run build
codex --version
codex login status
npm run local:init
```

The initializer creates ignored, owner-only files in `state/local/`. Existing configuration values are preserved, so rerunning it does not rotate credentials or erase history. It creates distinct Core management, host, Core operator, and Team operator credentials, a permitted `local-host`, environment files, a private MCP configuration, and an empty work directory. For an existing Core setup, it adds `teamOperator` to the credential file and creates `team.env` only when absent, taking the Core origin and management credential from the existing `control-plane.env`. Do not delete only one of these configuration files to rotate a credential; update its associated service/client configuration together.

After a project-directory rename, check any explicit `DEWBOW_WEB_ROOT` in existing local configuration and point it at the current `apps/core-web/dist` build. The initializer preserves existing files and does not rewrite that path. Project naming changes require no database reset or credential rotation.

Start services in separate terminals, from the same checkout root:

```sh
# Terminal 1: Control Plane and built Web
npm run local:core:control-plane

# Terminal 2: local Codex runtime and host connection
npm run local:core:host-daemon

# Terminal 3: independent Team backend and built Team Web
npm run local:team:backend
```

Open `http://127.0.0.1:3000`. Use the `operator` value in the private `state/local/credentials.json` for Web login. The Web has no separate production listener. `/health` only establishes listener availability; a connected machine plus a completed native turn establishes the execution path.

Open `http://127.0.0.1:3100` for Team and sign in with `teamOperator` from the same private credential file. Team uses a separate cookie and database; its Core management credential stays in the backend environment. The Control Plane and Team can run without a daemon for operator-interface previews. Hosts then remain disconnected and execution actions are unavailable. Team definition and team management remain available when Core is stopped. See [Team workspace](team/workspace.md) for its standalone startup commands.

| Local file | Owner and purpose |
| --- | --- |
| `control-plane.env` | Control Plane configuration and management/operator credentials |
| `host-daemon.env` | This daemon's identity, credential, URL and journal |
| `agent.env` | External management client credential and URL |
| `team.env` | Independent Team listener, operator credential, database, Web directory, and Core connection |
| `mcp.json` | Private example client configuration containing the management header |
| `hosts.json` | Permitted-host identities and credentials |
| `control.sqlite` | Control Plane management metadata, decisions, deduplication and operator cookies |
| `daemon.sqlite` | Local owned sessions, process IDs, event journal and command results |
| `team.sqlite` | Team definitions, members, bindings, and request deduplication |
| `workdir/` | Existing work directory for the local smoke run |

Keep the directory and credentials private. SQLite WAL/SHM files belong to their databases. Back up storage while the Control Plane, Team backend, and daemon are stopped. Native Codex credentials and conversation files remain in the local Codex home and are also needed for continuity. Management credentials do not provide model access.

### Start and stop the complete live stack

After installing dependencies, start the real Control Plane, Team backend and host daemon with one command:

```sh
mise exec -- npm run local:up
mise exec -- npm run local:status
mise exec -- npm run local:down
```

`local:up` builds the workspaces, initializes missing private configuration, checks Codex CLI 0.162.1 and its login status, then starts a background controller. It reports `ready` only after the authenticated Core host connection and Team-to-Core configuration are confirmed. It prints the actual Core and Team URLs and the work directory; it never sends a model message or creates a conversation automatically. Sign in using `operator` and `teamOperator` in the selected directory's private `credentials.json`. The existing per-service startup commands remain available independently.

On Windows, select the actual standalone `codex.exe`, retaining its companion binaries. For an isolated demo, substitute your installation's executable for the synthetic path below:

```sh
mise exec -- npm run local:up -- --state-dir state/demo --core-port 3240 --team-port 3241 --codex-executable C:/Tools/codex/bin/codex.exe
mise exec -- npm run local:status -- --state-dir state/demo
mise exec -- npm run local:down -- --state-dir state/demo
```

The default directory is `state/local`; Core and Team default to ports 3000 and 3100. Different state directories with distinct ports can run concurrently. `--codex-home <directory>` selects an explicitly configured native home; otherwise the daemon uses the normal local Codex home and login. Existing credentials, environment values, definitions, databases, and native conversations are preserved. Explicit Codex options can fill missing daemon settings while stopped. Repeating `up` for a running directory returns its current status and does not start another runtime. Explicit options that conflict with saved values are rejected; choose another directory or deliberately edit the private environment file while stopped. The initializer accepts the same options and serializes configuration writes with `local-init.lock`. Keep state directories in ignored local paths.

The controller uses the application's real service implementations. It coordinates their lifecycle in one Node process and owns a separate native Codex process; ordinary service CLIs still run independently. All listeners in this local workflow must use matching loopback HTTP origins. It refuses occupied service ports and does not adopt existing listeners. `live.log`, `live-controller.json`, and `live-last-run.json` remain private in the chosen directory. The controller record contains a short-lived control credential; do not print or share it.

`down` authenticates the exact controller instance, calls service shutdown methods, waits for native runtime termination, and verifies its service ports are released. It stops only the selected stack and leaves other state directories and independently started services alone. Windows shutdown uses this control channel instead of attempting graceful shutdown with a process-kill signal. A normal stop records `stopped` and removes the active controller record without deleting configuration or conversations. `status` reports `degraded` when service or host readiness can no longer be confirmed; an unreachable or mismatched controller remains `unavailable`. Missing controller history is `notManaged`, not evidence that independently started services have stopped.

Failed startup cleans up resources it started. If a crash or shutdown failure leaves an ownership record, commands refuse to kill a recorded PID or assume its resources are gone. Inspect the private log, controller identity and daemon ownership record using the recovery runbook below. Stop only verified owned processes before removing a stale controller record and restarting. A leftover `local-init.lock` also requires confirming that its initializer has exited before removal. Never reset native Codex storage to repair local preview state.

### Windows runtime and private state

Install a separate CLI without replacing a desktop application's bundled runtime, for example `mise install npm:@openai/codex@0.162.1`. Locate that installation with `mise where npm:@openai/codex@0.162.1` and set `DEWBOW_CODEX_EXECUTABLE` in the ignored daemon environment file to its actual `codex.exe`. Do not use a `.cmd` shim or the npm `codex.js` wrapper: Windows termination cannot rely on its signal forwarding. Check that executable's version and login status before acceptance. Leave desktop configuration, credentials, and existing native conversations intact.

Private Dewbow directories and files must belong to the current Windows account. An elevated token may instead create files owned by Administrators; that SID is accepted only when it is also the current token's default owner. Initialization and database startup protect their ACLs, granting access to the account and SYSTEM, and disabling inherited grants. They reject links and reparse paths instead of securing their targets. Only the designated private directory is changed; ancestor directories are preserved. POSIX uses owner checks and directory/file modes 0700/0600. Windows ACL failures block startup. PowerShell is invoked without a profile or visible window only for this bounded setup operation; Codex execution uses no shell.

The elevated-token check establishes default ownership, not which account created the file. Other elevated administrators can share that owner SID; private ACLs do not isolate data from privileged operating-system administrators.

For a Windows smoke run, pass `(Resolve-Path state/local/workdir).Path` as the work directory argument in PowerShell. Use separate fresh ignored state and a synthetic work directory for acceptance. Never reset an existing installation to obtain a clean run. Graceful service shutdown releases its owned runtime and listener; a runtime that misses the five-second deadline is reported as a failure.

## Connect an external MCP client

Use Streamable HTTP at `http://127.0.0.1:3000/mcp` with `Authorization: Bearer <management-credential>`. The ignored `state/local/mcp.json` is an example; adapt its `mcpServers` wrapper to your client's settings format. Keep the real header out of browser storage and version control. Twelve tools are exposed; approval decisions are operator-only.

For a Codex CLI client, configure the URL with its documented command:

```sh
codex mcp add dewbow-core --url http://127.0.0.1:3000/mcp --bearer-token-env-var DEWBOW_MANAGEMENT_TOKEN
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
node --env-file=state/second-host.env apps/core-host-daemon/dist/cli.js
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
npm run local:core:control-plane > logs/control-plane.log 2>&1
npm run local:core:host-daemon > logs/host-daemon.log 2>&1
```

Raw native stderr is not forwarded. Keep shell diagnostics and acceptance traces private too. Stop each foreground service with Ctrl+C or send SIGTERM to its verified process. The daemon waits for its app-server to stop; the Control Plane closes sockets and storage. Stopping the Control Plane alone does not stop host execution. Verify the listener port is released before restarting on the same address. No system service, automatic boot startup, container, or cloud deployment is installed by this path.

## Tool content acceptance

Use a fresh synthetic work directory and new conversation to test an actual command producing Unicode output larger than 64 KiB, plus a native file edit. Read the activity's content in default and maximum-size chunks, confirm byte-preserving UTF-8 reconstruction, and inspect the recorded diff. Check older/newer history boundaries and update polling separately. Restart the daemon, wait for authenticated host reconciliation, then request the exact activity and content again. Confirm another conversation cannot reuse the content ID. Inspect only synthetic journals to verify output and diff bodies are absent. Keep private content databases, traces and screenshots in ignored directories.

When launching a standalone native executable, retain its companion binaries and resource layout. Packaged desktop environments can remap the executable path and prevent companion discovery; use an independent installation or an isolated copy of the complete standalone distribution for acceptance. Verify its version before execution and preserve Desktop's installation, configuration and credentials.

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
