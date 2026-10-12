# Dewbow Core Control Plane

`@dewbow-core/control-plane` is a Node.js service with an authenticated management API, stateless MCP adapter, outbound-daemon WebSocket gateway, and private SQLite storage for management metadata. All clients call the same management operations. It has no SDK dependency and does not access native Codex storage or credentials.

See [MVP interfaces](interfaces.md) for schemas, state, retry semantics, event cursors, and the approval authority boundary. See [MVP specification](mvp.md) for product acceptance. See [Installation and operation](operations.md) for the complete setup path.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEWBOW_CONTROL_PLANE_HOST` | `127.0.0.1` | Bind address |
| `DEWBOW_CONTROL_PLANE_PORT` | `3000` | Listener port |
| `DEWBOW_PUBLIC_ORIGIN` | Listener HTTP(S) origin | Exact allowed HTTP Host and browser Origin; set the reachable hostname when using TLS or a proxy |
| `DEWBOW_CONTROL_PLANE_STATE` | `state/control-plane.sqlite` | SQLite journal path |
| `DEWBOW_HOSTS_FILE` | `state/hosts.json` | Permitted-host JSON file |
| `DEWBOW_MANAGEMENT_TOKEN` | Required at startup | External API/MCP bearer credential |
| `DEWBOW_OPERATOR_PASSWORD` | Required at startup | Separate human login credential |
| `DEWBOW_TLS_CERT`, `DEWBOW_TLS_KEY` | Unset | PEM files for HTTPS/WSS; required as a pair for non-loopback binding |
| `DEWBOW_WEB_ROOT` | Built `apps/core-web/dist/` | Local static Web assets |

The host file is a private JSON array:

```json
[
  { "hostId": "example-host", "name": "Example host", "token": "<replace-with-host-credential>", "revoked": false }
]
```

Host IDs and tokens must be unique. Keep management, operator, and daemon credentials distinct. Do not put this file or actual environment values in Git. Storage files are created with owner-only access. Protect the containing directory and TLS keys too.

## Start and stop

Use the runtime and installation steps in [Workspace development](workspace.md). From the repository root:

```sh
npm ci
npm run core:control-plane -- --check
npm run core:control-plane
```

Configure credentials and the permitted-host file before normal startup. `--check` checks listener configuration only. It does not validate credentials, open storage, connect to hosts, or prove service readiness. Normal startup opens storage and the listener. `GET /health` reports listener availability. Service logs contain component/status messages, not raw requests or native Codex diagnostics. Ctrl+C or SIGTERM closes sockets and storage.

`npm run build --workspace @dewbow-core/web` creates the static interface. The Control Plane serves it at its root; no additional Web process is needed for the local built deployment.

For cross-machine use, configure HTTPS/WSS with a certificate trusted by both clients and hosts. Keep certificate verification enabled. A loopback listener may sit behind an authenticated TLS reverse proxy which preserves the configured Host header. Plain HTTP/WS is restricted to local use. No production CORS exception is included.

## Authentication and MCP

External callers send `Authorization: Bearer <management-credential>` to `/api/<operation>` or `/mcp`. MCP provides the eight tools documented in [Interfaces](interfaces.md). It intentionally has no approval tool. Configure the external client's Streamable HTTP URL as `https://<control-plane-host>/mcp` and its authorization header outside browser storage.

The operator sends `{ "password": "<operator-credential>" }` to `/auth/login`. A protected cookie lasts 12 hours and survives Control Plane restarts. `/auth/logout` removes the saved session and clears the cookie. Requests with an unrecognized Host or Origin are rejected. The Web browser receives no daemon, agent, or native Codex credentials.

## Revocation and recovery

Set a host's `revoked` field to `true` or remove its entry. Configuration is reloaded before management requests and every 10-second heartbeat. The connection is closed and future authentication and commands are blocked. Token rotation also disconnects the old credential. Revocation does not kill local Codex: the operator must stop the daemon on that host to terminate its owned runtime.

A connection without a heartbeat pong for 30 seconds becomes disconnected. Active sessions become unknown; terminal results remain terminal. Commands recorded without a result within 15 seconds become `DELIVERY_UNCERTAIN`. A reconnect first replays available events and reconciles state and command results; only then can commands be accepted again. Commands absent from the daemon journal can be delivered with the original ID. A pending send body stays in memory; after a Control Plane restart the client must supply the original message and request ID again. Commands recorded as unresolved stay unknown.

A restart restores hosts, managed session metadata, approval decisions, and request fingerprints, then marks disconnected active execution unknown until a host reconciles. Event history is read from the daemon on demand and requires an available host. Retrying the original request returns its durable operation. Do not use a new request ID to bypass uncertainty. Follow the [daemon recovery procedure](host-daemon.md#reconnect-and-crash-recovery).

## Validation

```sh
npm run build
npm run typecheck
npm test
node apps/core-control-plane/dist/cli.js --check
git diff --check
```

The service integration test uses a synthetic WebSocket host. It covers bearer rejection, origin checks, shared API/MCP history, request deduplication and conflicts, SESSION_BUSY, operator-only approval, exact turn checks, disconnect/replay, and restart persistence. It does not establish real Codex execution or two-machine acceptance.

## Native conversation reads

The session list merges the connected daemon's SDK inventory with optional managed execution records. Native titles, archive state and chat are read from Codex; they are not copied into Control Plane SQLite. Catalog snapshots and live assistant deltas are held in memory. The Control Plane has no event history table. It keeps request acceptance/results, decisions, routing metadata, current state summaries and synchronization cursors; it never stores the daemon event stream. `readSessionHistory` proxies separate native-message and daemon-event reads. `eventsError` reports an unavailable event journal without advancing its cursor. Already received live output may remain in the volatile cache during disconnects. Both services expire inactive live reply caches after ten minutes and remove replies once terminal native messages are read. Native chat requires an available host and native history store. Both API and MCP expose the same native read results and source errors. Existing conversations support an explicit `connectSession` request before sending. The daemon confirms connection to the same native ID; a conflicting writer must release it first.
