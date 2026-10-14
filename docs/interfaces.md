# Dewbow API and MCP interfaces

[Dewbow MVP specification](mvp.md) defines Dewbow's scope. The private `@dewbow/protocol` workspace owns wire records, management input schemas, and the SQLite journal used by the Dewbow Control Plane and host daemon. The daemon uses the SDK for native discovery, saved messages, and explicit conversation connection. Management records track execution ownership.

## Management operations

All Dewbow-owned request, response, TypeScript object, configuration and persisted JSON fields use `camelCase`, such as `hostId`, `sessionId`, `workDir` and `requestId`. Operation and MCP tool names use verb-first `camelCase`. The HTTP path uses the same operation name, for example `POST /api/createSession`. SQLite tables and columns retain lowercase `snake_case`; the event journal maps JSON `sessionId` to SQL `session_id`. Native Codex protocol and storage names stay unchanged at their adapter boundaries.

Identifiers are opaque strings; times are ISO 8601 UTC. `POST /api/<operation>` accepts a JSON object matching the schemas in `packages/protocol/src/index.ts`. Responses are `{ result: ... }` or `{ error: { code, message, retryable, sessionId?, turnId? } }`. Bearer authentication identifies the external agent. The Web operator uses an HttpOnly, SameSite=Strict cookie issued by `POST /auth/login`; `POST /auth/logout` clears it. Only the operator can call `decideApproval`.

| Operation | Input | Result |
| --- | --- | --- |
| `listHosts` | `{}` | `{ hosts: Host[] }` |
| `listSessions` | optional `hostId` | `{ sessions: SessionSummary[], discovery }` |
| `listWorkspaceProfiles` | `hostId` | `{ profiles }` with profile IDs, names and kinds |
| `createSession` | `hostId`, `requestId`, one of absolute `workDir` or `workspaceProfileId`, optional `sessionOptions` | `Operation` with stable `sessionId` |
| `connectSession` | SDK-discovered `sessionId`, `requestId` | `Operation`; resume the same native conversation, then poll readiness |
| `getSession` | `sessionId` | `{ session, contextAuthority, turns, interactions, interactionsError, operations }` |
| `readSessionHistory` | `sessionId`, optional exclusive event `cursor` (default 0), one of `beforeCursor`, `afterCursor`, `updateCursor`, `limit` (1–500, default 50) | `{ events, nextCursor, hasMore, messages, activities, beforeCursor, afterCursor, updateCursor, hasMoreUpdates, liveMessages, historyError, eventsError }` |
| `getSessionActivity` | `sessionId`, exact native `itemId` | `SessionActivity` with private content references |
| `readSessionContent` | `sessionId`, `contentId`, optional `contentCursor`, `limitBytes` (4–262144, default 65536) | `ContentPage` with text, byte offset, length, availability, completeness and next cursor |
| `sendMessage` | `sessionId`, `message`, `requestId`, optional `mode` (`default` or `plan`, default `default`) | `Operation` with stable `turnId` |
| `steerTurn` | `sessionId`, exact active `turnId`, `message`, `requestId` | `Operation`; append instructions with the current turn mode |
| `answerQuestions` | exact `sessionId`, `turnId`, `interactionId`, `requestId`, `answers: [{ questionId, answers: string[] }]` | `Operation`; Dewbow validates question identity and response authority |
| `interruptTurn` | `sessionId`, exact `turnId`, `requestId` | `Operation`; delivery does not confirm interruption |
| `decideApproval` | exact `sessionId`, `turnId`, `interactionId`, `requestId`, `decision` (`allow` or `deny`) | `Operation`; operator only, absent from MCP |

Conversation summaries combine SDK-native metadata with optional Dewbow execution metadata. `managed` indicates a management record, not confirmed ownership. `managed: false` means there is no management record; send, interrupt and approval operations return `SESSION_NOT_CONNECTED`. Call `connectSession` to resume it through the SDK. Its management and native IDs stay unchanged. `connectionState` becomes `connecting`, then `connected` or `error`; sending requires a confirmed connection. An existing writer produces `SESSION_IN_USE` without stopping that process. Release the conversation there, then retry connection with a new request ID. Native IDs are scoped by host and Codex home. A managed conversation retains its original management ID and appears once. Discovery includes archived and child conversations. `discovery` reports each host's observation time, source outcomes and read error. Inventories are held in memory, not copied into Dewbow SQLite. A disconnected host retains only the current process's last snapshot; a Control Plane restart needs the host to reconnect before discovering its conversations again.

History has independent event and native-item streams. `nextCursor` advances only management events. The initial native page contains the latest 50 visible items across messages and activities, in ascending source order; reasoning is excluded. Use `beforeCursor` for older items and `afterCursor` for newer historical items. Poll `updateCursor` for newly created or changed items, including updates to IDs far outside the latest page. Drain `hasMoreUpdates` before the next poll. Cursors bind the conversation and direction, with source position and item ID as tie breakers. Older-page reads must not replace the current update watermark. Retain a watermark only after committing its returned items. Native reads are bounded to 8 MiB of item JSON per page; a large page fails explicitly and may require a smaller limit.

Merge by item ID and `updatedOrdinal`; completed items take precedence over partial snapshots. Native completion metadata determines `itemComplete`, rather than text length or a `final_answer` phase alone. A completed final answer uses its completion source position so it follows intervening activity. `liveMessages` supplies volatile assistant output until native storage catches up. `eventsError` leaves the event cursor unchanged. `historyError` means unavailable native content, rather than an empty conversation. Previously loaded items may remain in browser memory during a disconnect.

Activity bodies load separately from host-private storage. Content IDs and byte cursors are scoped to the native home and conversation; callers cannot select a host filesystem path. UTF-8 chunks never split a code point. Command deltas captured by the owning daemon become complete only on an observed terminal item. Native aggregated output without that capture has unknown completeness; missing bodies are unavailable and interrupted captures remain partial. File diffs describe the native recorded change, not the current file. Exact activity reads refresh native metadata and retain a newer complete capture; source unavailability can return cached metadata. The Control Plane relays content transiently and never write it to their management journals.

`Operation.status` is `accepted`, `delivered`, `error`, or `unknown`. Accepted means durably recorded. Delivered means the daemon applied the command; observe the turn separately for completion or interruption. Delivery without a result within 15 seconds becomes unknown with `DELIVERY_UNCERTAIN`. Inspect `getSession` or retry with the same request ID. Do not change IDs to work around uncertainty.

Mutation request IDs are scoped to caller and operation. Their fingerprints and results persist for the session's lifetime. Same ID and input return the original operation with its current delivery status. Changed input returns `REQUEST_CONFLICT`. Both services journal command IDs and fingerprints before execution. Message and structured-answer bodies are excluded from both management journals. Pending bodies are volatile; interaction details and completed answers live only in the host-private content store. The daemon never repeats a command whose outcome remains unresolved after restart. After a Control Plane restart, an unseen send remains unresolved and blocks another turn; the client must retry the original message and request ID. The daemon deduplicates that retry. This is deduplication, not an exactly-once guarantee.

## Agent configuration and session snapshots

Session creation accepts execution overrides for the selected host and working directory. For example:

```json
{
  "hostId": "writing-host",
  "workDir": "/workspace/article",
  "requestId": "create-editor-001",
  "sessionOptions": {
    "reasoningEffort": "high",
    "instructionsAppend": "Act as an editor. Preserve the author's meaning."
  }
}
```

Omit `sessionOptions` or use `{}` to inherit the host's Codex configuration for the selected work directory, including native instructions and tools. Dewbow does not copy or replace Codex's built-in base instructions.

`sessionOptions` accepts only:

| Field | Meaning |
| --- | --- |
| `model` | Non-empty model name, at most 200 characters; overrides the host model default |
| `reasoningEffort` | Non-empty effort name, at most 200 characters; must be advertised by the selected model |
| `instructionsAppend` | Additional developer instructions, at most 100,000 characters; an empty string adds nothing |

Omitted fields inherit the creation-time baseline; `null`, unknown keys and arbitrary native `config` passthrough are rejected. Model names and effort support are checked on the host, not hard-coded into the management schema. Model selection is session override, then `DEWBOW_CODEX_MODEL`, then effective native project/user config, then the native catalog default. Effort selection is session override, then effective native config, then the selected model's default. Sandbox, approval policy and reviewer remain host-owned. This version does not support session-specific MCP, skills or tool configuration. No shared config file is modified.

`Session.sessionConfig` contains `{ overrides, resolved }`. Acceptance persists the original overrides with `resolved: null` before dispatch. The daemon reads effective native configuration and the model catalog, then persists the resolved snapshot before `thread/start`. Its `session_configured` event synchronizes that snapshot to the Control Plane. The snapshot contains model, model provider, reasoning effort, composed `developerInstructions`, approval policy, reviewer and the workspace sandbox policy. Creation succeeds only when the native response confirms the selected model, effort, directory and execution policy. `getSession` exposes the same snapshot, and both journals retain it for recovery.

Instructions are composed once as the effective baseline's additional developer instructions plus `instructionsAppend`, separated by a blank line when both are non-empty. Recovery and explicit reconnection of created sessions send the saved `developerInstructions` value directly to `thread/resume`; they never append again or send instructions as a user message. `connectSession` accepts no new overrides. Later host defaults affect new sessions only. A changed model/policy, missing snapshot or failed resume leaves the session unresolved; it never creates another native thread or silently substitutes defaults. Nested JSON key order does not change request fingerprints; changed values conflict under the same request ID.

Existing native conversations adopted by the daemon have `sessionConfig: null`. Dewbow leaves their native model and instructions selected by native resume, while retaining its existing host approval/sandbox boundary. This is separate from snapshot recovery of Dewbow-created sessions. Old managed records without the new configuration field are unsupported; use fresh Dewbow journals under the [state reset procedure](operations.md#resetting-dewbow-state-after-contract-changes). There are no compatibility aliases or migrations, and the contract remains `v1`.

Snapshots fix the fields Dewbow manages, not the entire Codex environment. Codex upgrades, `AGENTS.md`, built-in instructions, provider connection settings, and host tools/MCP/skills may still change execution. A snapshot does not preserve credentials or guarantee full prompt reproducibility.

## State and errors

Hosts are `connected`, `disconnected`, or `revoked`. A heartbeat runs every 10 seconds; no pong for 30 seconds disconnects the host. Reconnect retains the configured host identity. The daemon replays events after saved cursors, reports sessions, turns, interactions and command results, and waits for `ready` before accepting new commands.

Session `runtimeState` is `idle`, `running`, `awaiting_approval`, `awaiting_input`, `interrupted`, `error`, or `unknown`. It expresses observed Codex execution. `connectionState` is independently `disconnected`, `connecting`, `connected`, or `error`; a failed connection does not make the native runtime erroneous. Request acceptance reserves `activeTurnId` but does not report `running` before Codex confirms start. Preserve `lastKnownState` and `lastKnownAt` when state becomes unknown. Turns add `accepted` and `completed`, and retain their `mode`. `activeTurnId` stays set for accepted, running, awaiting input/approval, and unknown turns. A session has one active turn; separate sessions can progress independently. Only a confirmed terminal event clears the active turn. Completion means Codex ended normally, not that the task was correct.

Stable errors include `INVALID_INPUT`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `HOST_UNAVAILABLE`, `SESSION_BUSY`, `SESSION_NOT_READY`, `SESSION_NOT_CONNECTED`, `SESSION_IN_USE`, `STALE_TURN`, `STALE_INTERACTION`, `REQUEST_CONFLICT`, `DELIVERY_UNCERTAIN`, `INVALID_WORKDIR`, `EXECUTION_FAILED`, and `RECOVERY_REQUIRED`. Unavailable hosts reject new commands instead of queuing them. Disconnects and service restarts preserve terminal results and make unresolved execution unknown. Unavailable daemon history produces `eventsError` without advancing the event cursor.

Interactions have `interactionId`, management session/turn IDs, native `itemId`, `kind` (`approval`, `questions`, or `unsupported`), `authority` (`agent` or `operator`), `blocking`, `sensitive`, timestamps, a content reference, optional details, decision and response request ID. Status is `pending`, `requested`, `delivered`, `resolved`, or `invalidated`. Request delivery is separate from native resolution. Terminal turns invalidate pending callbacks. A runtime restart cannot reuse an old callback ID. Details load from the host; `interactionsError` preserves an explicit unavailable state alongside cached metadata.

`getSession.contextAuthority` declares the required role for conversation content and continuation. It remains operator-only even when the original sensitive interaction has left the recent window. The interaction query includes the latest 50 records plus unresolved callbacks (maximum 500), with a 6 MiB combined details budget prioritizing unresolved prompts. Remaining details keep their private content reference and load using `readSessionContent`; approval decisions stay disabled until their details are visible. Host query responses are bounded to 8 MiB, below the transport frame limit.

Only a confirmed built-in `request_user_input` origin permits agent answers. Question wording never grants authority. Exact raw native events or a bounded, owned, exact-session rollout lookup establish origin. Malformed/ambiguous origins, secret questions, uncertain writable rollout overlap, extra writable roots and prior allowed approvals keep file-based classification operator-only. Unknown callbacks are visible and can be interrupted; Dewbow does not invent a native response. Blocking questions produce `awaiting_input`; nonblocking questions remain visible while the turn runs. Question details include opaque `questionId`, header, prompt, options, `allowCustom` and `secret`. Supply every question exactly once; supplied option labels must match when custom answers are disallowed.

After a secret or malformed-secrecy interaction, or a response to an operator-only question, the conversation's native context requires the Dewbow operator for messages, activities, event content, output/diff reads and new continuation. Management clients see restricted placeholders and may still interrupt or reconcile its original requests. This boundary persists across later turns and service restarts because native context may repeat earlier private answers. `ContentRef.authority` describes read access, and the host enforces it even for a previously known content ID. Ordinary question details and responses remain readable to authenticated agent callers.

Every mutation uses its own request ID, including approvals and structured answers. Identical retries reuse the stable command; changed input conflicts. A definite invalid answer restores a still-current interaction to pending so a corrected answer can use a new ID. Uncertain delivery must retry the original ID and body. Message client IDs use the globally scoped command ID; positive native evidence can reconcile an unknown send/steer without repeating execution. Missing evidence keeps the result unknown. Native permission approvals grant only the requested profile for the current turn, with no session-wide policy amendment.

## History and host transport

Selected-session updates are available through authenticated `GET /api/subscribeSessionUpdates`. This SSE interface sends `snapshot` and `update` envelopes containing public session details and existing bounded history pages. Mutations remain JSON HTTP operations. See [Session update subscriptions](session-updates.md) for cursor recovery, authority and lifecycle.

Events have a session-local increasing cursor and `eventId = sessionId:cursor`, an optional management turn ID, timestamp, type and allowlisted payload. Append is idempotent on `(sessionId,cursor)`. Saved chat comes directly from the host's native Codex history through the SDK. Dewbow journals retain message references, tool metadata, approvals and state changes, but no message text or assistant plan text. Only the daemon retains event history. The Control Plane persists its own request/decision metadata and current execution summaries, not event payloads. Exclude transport credentials and raw account/configuration RPCs. Native Codex credentials remain on the host. Existing SDK-discovered conversations are visible and readable. Only an explicit connection request adopts their execution. Connected conversations use the same approval, interrupt, deduplication, and restart recovery flow as newly created ones.

The daemon opens an authenticated WebSocket at `/hosts/connect`, using a bearer credential and a `hello` with `hostId`. Frames use the `ToHost` and `ToControlPlane` unions in the protocol package. One connection per permitted host is allowed. Read-only `query` / `query_result` frames fetch discovery pages, native history, and daemon event history on that connection. Discovery snapshots refresh every ten seconds and travel in pages of up to 500 records; native history preserves the SDK's bounded pages. Control Plane session IDs differ from Codex thread/turn references. Each service owns its private SQLite file.

## MCP

`/mcp` provides stateless Streamable HTTP with JSON responses and polling. Authenticated callers use JSON-RPC `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. The thirteen management tools excluding `decideApproval` use the same service as Web. Initialization negotiates `2025-03-26` and advertises `tools` and `serverInfo`. No MCP session ID is needed. GET and DELETE return 405; SSE and stateful MCP sessions are not implemented. Success includes structured content and JSON text. Tool failures return `isError: true` and a structured error in text. Unknown RPC methods use `-32601`; invalid requests use `-32600`/`-32602`.

See the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) and [Codex app-server reference](https://learn.chatgpt.com/docs/app-server). Check bindings against the installed Codex version when changing integration.

## Scope and acceptance

No scheduler, desktop wrapper, automatic host enrollment, package publication, or cloud provisioning is required. Existing native conversations can be connected explicitly; an active writer must release the conversation first. Manual credentials and permitted hosts are sufficient. Setup and recovery instructions belong in `docs/`; the root README stays brief under repository policy. Full acceptance requires two actual machines. Two daemons on one machine establish only a local transport test. The operator will start the second host manually.

## Early development contracts

Dewbow-owned contracts remain pinned to `v1`. Breaking changes update the current contract and all callers together, without version negotiation or legacy support. Old operation names and snake_case JSON fields are rejected; there are no aliases or naming migrations. Existing journals containing the old JSON contract must be replaced with fresh Dewbow state using the [state reset procedure](operations.md#resetting-dewbow-state-after-contract-changes). SQL schema names are unchanged. Session execution is exposed as `runtimeState`; turn and operation state fields retain their own meanings. Obsolete Dewbow-owned tables are recreated rather than migrated. Codex native data and credentials are outside this reset.

For managed workspace creation, `Session.workDir` is null until host provisioning resolves its canonical path. `Session.workspace` records profile, source, branch and preparation state; ready ownership is immutable. Existing explicit-directory calls remain supported. Provisioning does not fetch, reset or clean up user work.
