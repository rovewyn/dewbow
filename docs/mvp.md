# Dewbow Core MVP

Implementation handoff

Build a self-hosted service that lets an existing AI agent manage Codex sessions across multiple machines through MCP and an API. A small Web interface gives the human operator visibility, approval controls, and a way to intervene.

This specification covers Dewbow Core. Agent definitions, teams, members, and session bindings belong to Dewbow Team, which uses Core's authenticated HTTP API. See [Dewbow boundaries and projects](README.md).

## 1 Product goal and working flow

The MVP must demonstrate a complete workflow on two actual machines running Codex, with multiple sessions operating independently. The primary caller is an external AI client. The operator deploys the service and uses the Web interface when human input is needed.

### Core workflow

1. The operator starts one Control Plane and configures a Host Daemon on each machine. Each daemon initiates an authenticated connection to the Control Plane.

2. An external AI client connects through MCP, lists available hosts, and creates a session on a selected host and working directory.

3. The client sends a message, reads progress and replies, and sends a follow-up within the same Codex conversation.

4. The operator can inspect the session in the Web interface, allow or deny a pending Codex approval, send a message, or interrupt an active turn.

5. The client and operator can see the resulting execution state and read the persisted history.

### Components to build

- Control Plane: authenticated management API, MCP adapter, host connections, session metadata, host history proxying, and approval routing.

- Host Daemon: local Codex integration, session and process ownership, command handling, event capture, and connection recovery.

- Web interface: a machine and session list plus one conversation detail view, backed by the same management service.

The browser is a client of the Control Plane. Closing it must not stop daemon-owned execution. Codex runs on the selected host, in that session’s configured working directory.

### Product description

An agent-first, self-hosted service for managing Codex sessions across your machines.

## 2 Identity and observable state

Keep host, session, turn, event, and approval identities separate. These records provide enough structure for management clients to act safely and understand what happened.

### Minimum records

- Host: stable hostId, display name, connection status, and lastSeenAt. Reconnecting with the same configured identity must not create a second host.

- Session: stable sessionId, hostId, working directory, local Codex conversation reference, creation time, current state, activeTurnId, and latest event cursor.

- Turn: turnId, sessionId, originating requestId, state, timestamps, and an error when execution fails. A follow-up creates a new turn in the same session.

- Event: stable eventId or ordered cursor, sessionId, turnId when relevant, timestamp, type, and payload. Preserve message order and make repeated reads safe.

- Approval: approvalId, exact session and turn, Codex request reference, requested action, status, and decision record.

### Proposed state contract

Use a small, documented state vocabulary. The names below are the proposed interface contract; equivalent names are acceptable if their meaning remains explicit.

- Host connection: connected, disconnected, or revoked. Set disconnected after the documented heartbeat or connection timeout and retain lastSeenAt.

- Session execution: idle, running, awaiting_approval, interrupted, error, or unknown. Keep the last observed state and its timestamp when current state is unknown.

- Turn: accepted, running, awaiting_approval, completed, interrupted, error, or unknown. Accepted means the request was recorded; it does not mean Codex has started.

A completed turn means Codex reported that the turn ended normally. Task correctness remains for the calling agent or human to assess. A connection loss, silence, or closed browser must never be interpreted as successful completion.

### Conversation continuity

Every accepted send operation must target the selected session’s existing Codex conversation. Store the mapping needed to continue it. Show user messages, assistant replies, tool activity, approval events, and state changes in a readable sequence.

Allow one active turn per session. Return SESSION_BUSY for another send while a turn is accepted, running, awaiting approval, or unresolved. Clear activeTurnId after a confirmed terminal result; allow a follow-up when the local conversation is usable. Different sessions may run independently on either host.

## 3 MCP and API contract

Expose a small complete MCP tool set. MCP and Web must call the same management operations and observe the same IDs, state, history, and errors. Polling is sufficient for the external AI client.

The tool names and fields below are a proposed contract. Finalize the concrete schemas in the interface documentation before building clients.

| Tool | Input | Result |
| --- | --- | --- |
| listHosts | No required input | Hosts with IDs, connection state, and last seen |
| listSessions | Optional hostId | Session summaries and active turn references |
| createSession | hostId, workDir, requestId | Stable sessionId and creation state |
| getSession | sessionId | Current and last known state, active turn, pending approvals |
| readSessionHistory | sessionId, optional cursor and limit | Ordered messages and events, with nextCursor |
| sendMessage | sessionId, message, requestId | sessionId, turnId, and acceptance state |
| interruptTurn | sessionId, turnId, requestId | Interrupt request state; final state observed separately |

### Response behavior

Return structured results containing the relevant IDs, operation status, and timestamps. Error responses include code, message, retryable, and available session or turn references. Do not require clients to infer state by parsing chat text.

Cover invalid input, unauthorized access, missing records, unavailable hosts, SESSION_BUSY, stale approval or turn references, conflicting request IDs, and execution failures with stable error codes. A delivery timeout must identify an uncertain result so the client can inspect or retry with the same requestId.

### Retry contract

Require a caller-generated requestId for create, send, and interrupt. Scope it to the authenticated caller and operation. Persist its input fingerprint and resulting IDs for as long as the session record is retained, including across restarts. The same ID and input return the original operation; a changed input returns a conflict. A repeated interrupt must never target a newer turn.

Deduplicate commands at the daemon as well as the API boundary. After uncertain delivery, reconcile the recorded command before dispatching again. If the outcome remains unresolved, expose unknown and follow the recovery procedure in section 5. Do not claim exactly-once execution.

## 4 Web controls and human approvals

### Minimum Web interface

- Machine and session list: host name, connection state, last seen, associated sessions, and each session’s current or last known execution state.

- Conversation detail: ordered message history, progress and tool activity, current turn state, pending approvals, message input, and interrupt control.

- Readable updates: show new events while the page is open and restore the same history after refresh. Polling or a streaming transport is an implementation choice.

Use a basic responsive layout. Keep message delivery, pending requests, and errors visible so the operator can tell whether an action was accepted or is still uncertain.

### Approval routing

When Codex requests approval, create a pending approval record and display the requested action with its host, session, and turn. The operator chooses Allow or Deny in the Web interface. Route that decision to the exact active Codex request.

The server must check approvalId, sessionId, turnId, and pending status before applying a decision. Apply a decision once. A repeated identical decision can return the existing result; a stale, mismatched, or conflicting decision must fail clearly.

Keep requested, delivered, and resolved decision states distinguishable when delivery is delayed. During a host disconnect, disable approval actions until reconciliation confirms the request is still active. An interruption or ended turn invalidates approvals that are no longer actionable.

### Authentication and safe defaults

Authenticate the Web operator, external API or MCP client, and each daemon. Manual configuration of credentials and permitted hosts is sufficient. Separate the agent’s management credential from the operator’s approval authority; management access must not silently grant approval.

The daemon uses Codex credentials configured locally on its own machine. Keep daemon, agent API, and native Codex secrets out of browser storage, event payloads, responses, and logs. A protected operator session cookie may authenticate the Web interface. Use encrypted authenticated transport when connections cross machines.

Support revoking a host through configuration. Revocation closes or rejects its connection and blocks subsequent commands. Document the local execution behavior after revocation so the operator can safely stop any remaining process on that machine.

## 5 Runtime reliability and setup

### Execution and interruption

The Host Daemon owns each local Codex process or runtime connection independently of any browser tab. Validate the selected working directory on that host and return an actionable error when it cannot be used.

A send response acknowledges acceptance. Progress, approval requests, replies, and terminal execution state arrive as events. Interrupt must target the active turn and report interruption only after Codex or the local process confirms that it stopped. Keep the request pending or unknown when confirmation is unavailable.

### Disconnect and recovery

On connection loss, retain the host’s last seen time and mark affected active execution as unknown. Preserve known terminal results. Reject new sends to an unavailable host rather than creating an invisible queue.

On reconnect, the daemon reports its current sessions, active turns, pending approvals, and event positions. Reconcile that report with persisted records before accepting more commands. Replay available events without duplicate history entries and make any unrecoverable gap visible.

Persist Control Plane management metadata, approval decisions, and request deduplication records. The daemon owns event history; Codex owns saved chat. A Control Plane restart restores metadata and reconciles with connected daemons before reporting current execution state. History reads require an available host.

A daemon crash may terminate local execution. After restart, use actual Codex or process state to recover what can be recovered. Show error or unknown when a turn cannot be restored; never mark it resumed merely because its metadata survived.

For an unresolved turn, the operator verifies or stops the affected local execution and restarts the daemon. Reconciliation must confirm that the old turn is no longer active before allowing a follow-up in the saved conversation. Keep unknown if that cannot be verified. Document this recovery procedure and any local Codex continuation limits.

### Installation and operation

Provide one reproducible setup path for the Control Plane, persistent storage, MCP connection, and Host Daemon. Manual configuration is enough. Documentation under `docs/` must cover:

- Required runtime and Codex versions, and the target operating systems actually validated by the implementing team.

- Install and start commands, Control Plane address, host ID, credentials, local Codex setup, storage location, and working-directory selection.

- Connecting an external MCP client, signing in to the Web interface, adding a second host, revoking a host, and stopping services.

- Restart behavior, where to find sanitized logs, and how to recover an unresolved session or pending command.

The implementing team chooses the framework, database, transport, and Codex integration. Record those choices and validate the required Codex events, approvals, continuation, and interrupt behavior early. Existing Happy components may be reused where useful; the implementation approach remains a team decision.

## 6 Delivery and acceptance

### Implementation milestones

1. One host end to end: authenticated daemon connection, session creation, message execution, persisted reply, and MCP readback using actual Codex.

2. Complete interaction loop: follow-up in the same conversation, Web inspection and input, human allow and deny, and confirmed interruption.

3. Two hosts and recovery: independent sessions, duplicate-request handling, browser independence, disconnect reconciliation, and restart recovery.

4. Reproducible handoff: clean installation, documented interfaces, automated checks, and a recorded smoke run on both machines.

### Acceptance checklist

- [ ] An external AI client connects over MCP and lists two distinct, authenticated hosts running actual Codex.

- [ ] The client creates at least one session on each host, starts work, reads progress and replies, and sends a follow-up in the same conversation.

- [ ] Multiple sessions progress independently. A concurrent send to a busy session returns the documented error without starting another turn.

- [ ] The Web interface shows one real approval that is allowed and another that is denied. Each decision reaches the correct active request; stale decisions are rejected.

- [ ] An active turn is interrupted and its stopped state is confirmed. The caller can distinguish interrupt requested from interrupted.

- [ ] Refreshing and closing the Web interface leaves an ongoing daemon-owned execution running; reopening shows the accumulated history.

- [ ] Disconnecting a host makes active state unknown without reporting success. Reconnecting restores observed state and available history without duplicates.

- [ ] Invalid client and daemon credentials are rejected. A revoked host cannot reconnect or receive commands. Credentials do not appear in returned data or logs.

- [ ] Retrying create with the same request ID produces one session; retrying send produces one accepted turn. A changed payload with the same ID is rejected.

- [ ] Restarting the Control Plane restores management metadata and reads history from available hosts. Restarting a daemon reports actual recoverable state and never falsely resumes an interrupted process.

### Required handoff

Deliver source code, configuration examples, install and start instructions, API and MCP schemas, and a reproducible smoke-test script or runbook. Include sanitized traces with host, session, turn, request, and approval IDs that demonstrate the checklist on both actual machines. Record tested OS and Codex versions and any observed recovery limits.
