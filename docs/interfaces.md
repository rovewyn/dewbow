# Dewbow Web API

The Rust daemon exposes loopback Web operations using the shared `v1` camelCase contract. The machine-readable [OpenAPI contract](openapi.yaml) describes the current operator HTTP surface, including input/output schemas, authentication, errors and SSE framing. It uses OpenAPI 3.1; its `info.version: v1` identifies the management contract rather than the product release. Keep it aligned with the Rust daemon implementation when changing the API.

## API design and authority

The daemon serves both embedded Web assets and the operator API on `http://127.0.0.1:<configured-port>` (default port `3000`). Management resources use the `/api/v1` prefix. Reads use GET with path identities and optional query parameters; mutations use POST with JSON object bodies. Path identities must not be repeated in a body or query, even with the same value. Unknown fields and repeated query parameters are rejected, and the JSON body limit is 1 MiB. Integer query values use unsigned decimal digits. The HTTP adapter reconstructs the existing domain-operation input before validation, request fingerprinting and execution. The browser never reads databases directly.

There are two authority boundaries. The browser uses an operator cookie for the documented Web API. The CLI uses a private control credential for `/internal/<operation>`, including lifecycle, ticket issuance and upgrade handshakes. Those private control routes and static assets are outside the OpenAPI contract. No MCP endpoint, remote native-session management or external agent bearer access is provided.

`dewbow web` requests a 60-second one-use ticket through a separate protected local control endpoint. Web removes the URL fragment ticket before `POST /auth/login`, then uses an HttpOnly SameSite=Strict cookie. `POST /auth/logout` revokes it. Tickets and cookies expire in memory and are invalidated when the daemon exits. Never expose the private control credential in browser storage or URLs.

The cookie lasts at most 12 hours. Every Web POST requires `Host: 127.0.0.1:<configured-port>` and an `Origin` exactly equal to the server URL. GET and SSE require the same cookie and Host; if an Origin is supplied, it must also match. Using `localhost`, another hostname or a different port does not satisfy these checks. Operator JSON and SSE responses use `Cache-Control: no-store`. `GET /health` is an unauthenticated listener probe returning `{ "status": "available" }`; it does not establish native readiness or daemon identity.

## Requests, responses and errors

Reads return HTTP 200 with `{ "result": ... }`. Mutations return a durable operation receipt in that envelope and a `Location: /api/v1/operations/{commandId}` header. A delivered session or turn creation returns 201; an accepted receipt returns 202; other receipts return 200. An identical retry can return the same 201 and Location without creating another resource. None of these statuses means that a native turn has completed. Failures before a receipt is returned use `{ "error": { "code", "message", "retryable" } }` and these resource-API mappings:

| HTTP status | Management codes |
| --- | --- |
| `400` | Invalid JSON/input, unknown or repeated fields, invalid query values and other input errors |
| `401` | `UNAUTHORIZED`, including invalid credentials or a rejected Host/Origin |
| `403` | `FORBIDDEN` |
| `404` | `NOT_FOUND` |
| `409` | `REQUEST_CONFLICT`, `SESSION_BUSY`, `SESSION_IN_USE`, `STALE_TURN`, `STALE_INTERACTION`, `RECOVERY_REQUIRED` |
| `429` | `LIMIT_EXCEEDED` |
| `500` | `EXECUTION_FAILED`, `DELIVERY_UNCERTAIN` before a receipt can be returned |
| `503` | `UNAVAILABLE`, including shutdown or upgrade maintenance |

Once a mutation has a receipt, a delivery failure or uncertain outcome appears in an HTTP 200 operation's `status` and `error`. Discovery and history reads also return explicit partial-read errors inside their results. Clients must inspect these fields. `retryable` does not mean the native action never happened or authorize retrying with a new request ID. Authentication endpoints and private CLI control retain their separate error mappings. Login body extraction can return framework plain-text `400`, `413`, `415` or `422` errors rather than a management envelope; the OpenAPI file records that exception. Unsupported methods and unmatched paths can return framework responses without a management envelope.

For example, `POST /api/v1/sessions/session-example/turns` with `{ "message": "Hello", "requestId": "req-123" }` returns an operation receipt with `commandId`, target IDs, delivery `status` and an optional error. Read the Location for delivery status, the session or its subscription for actual turn state, and `/history` for native messages. `delivered` alone does not establish a completed answer. Retain the original request ID, path identities and identical body when retrying a lost response.

`GET /api/v1/operations/{commandId}` reads a retained receipt without executing a command or writing management storage. It exposes the same public fields as mutation responses, excluding fingerprints and native callback/process identities. A pruned or unknown receipt returns 404; absence does not establish that the action never happened. Receipt lookup follows the existing retention window and does not create an execution history.

## Remote execution

All seven mutations support an execution host. Creation keeps its required `hostId`; connection, sending, steering, interruption, answers and decisions accept optional `hostId` in the JSON body. Omission means this daemon. An explicit local host is normalized to the original local operation input, preserving existing local fingerprints. A remote host uses a direct authenticated member connection, target-owned native policy and the same typed operation rules. Membership control remains private CLI control; this does not expose browser enrollment.

Remote mutation responses retain the existing public operation shape. Their `Location` is `/api/v1/hosts/{hostId}/request-receipts/{requestId}?networkId=…&sourceHostId=…`. This authenticated GET requires both query fields, returns `{ result: { receiptScope: { networkId, sourceHostId, requestId }, receipt, receiptRetentionSeconds } }`, and never writes state or executes work. A currently authorized member can inspect another source's receipt, including after that source was removed; it cannot execute using that source's identity. The target may be this daemon. A missing receipt is `null`, not proof of nonexecution. Existing `/operations/{commandId}` reads remain available for this daemon's retained operations.

Remote routing adds `NOT_READY` (503), `SYNC_REQUIRED` and `HISTORY_CONFLICT` (409), and `RESOURCE_LIMIT` (429). Possible dispatch without a trustworthy response is `DELIVERY_UNCERTAIN` (500) unless a target receipt is already returned. Preserve the original identity and input; never select another target or invent a replacement request ID. Native completion still requires native state, independently of delivery. See [remote execution](network-execution.md).

## Contract version

The management contract's current name is `v1`. It covers domain operation names, input/output shapes, errors and session update semantics. The protocol package declares this version, session update snapshots include `contractVersion: "v1"`, and HTTP resources use `/api/v1`. The daemon and bundled Web implement one coordinated contract, without multi-version negotiation. The approved HTTP transition and removed routes are recorded in the [0.2.0 release notes](release-notes/0.2.0.md#http-api-transition).

Product releases do not automatically advance this contract. An additive change that preserves existing clients' behavior can remain in `v1`. Renaming or removing a required field, or changing delivery/error semantics incompatibly, requires an explicit contract-version decision and coordinated client/daemon transition. A future `v2` is possible when needed, not a requirement for the next product release. This is independent of the integer [database schema version](storage.md#version-identifiers).

## Operations

Paths below are relative to `/api/v1`. Remaining read inputs are query parameters; remaining mutation inputs are JSON body fields. Mutations reject query parameters. Domain names remain internal management operations and OpenAPI operation IDs, rather than HTTP paths.

| Method and resource path | Domain operation | Remaining input |
| --- | --- | --- |
| `GET /hosts` | `listHosts` | None |
| `GET /sessions` | `listSessions` | Optional `hostId` |
| `GET /sessions/{sessionId}` | `getSession` | None |
| `POST /sessions` | `createSession` | `hostId, workDir, requestId`, optional `sessionOptions` |
| `POST /sessions/{sessionId}/connections` | `connectSession` | `requestId` |
| `GET /sessions/{sessionId}/history` | `readSessionHistory` | Optional `cursor`, one of `beforeCursor/afterCursor/updateCursor`, `limit` |
| `GET /sessions/{sessionId}/activities/{itemId}` | `getSessionActivity` | None |
| `GET /sessions/{sessionId}/contents/{contentId}` | `readSessionContent` | Optional `contentCursor, limitBytes` |
| `POST /sessions/{sessionId}/turns` | `sendMessage` | `message, requestId`, optional `mode` |
| `POST /sessions/{sessionId}/turns/{turnId}/instructions` | `steerTurn` | `message, requestId` |
| `POST /sessions/{sessionId}/turns/{turnId}/interactions/{interactionId}/answers` | `answerQuestions` | `requestId, answers` |
| `POST /sessions/{sessionId}/turns/{turnId}/interactions/{interactionId}/decisions` | `decideApproval` | `requestId, decision` |
| `POST /sessions/{sessionId}/turns/{turnId}/interruptions` | `interruptTurn` | `requestId` |
| `GET /operations/{commandId}` | `getOperation` | None |
| `GET /sessions/{sessionId}/updates` | `subscribeSessionUpdates` | Optional `cursor, updateCursor`; SSE response |

`workDir` is an existing absolute local directory. Creation options permit model, reasoningEffort and instructionsAppend only. Models and efforts must be advertised by native Codex. Dewbow freezes the resolved creation model, effort, composed developer instructions and host-owned workspace sandbox/approval policy. It confirms identity, working directory and the managed settings on native resume. No member workspace profile or arbitrary native config input is accepted.

Question answers are `[{ questionId, answers: string[] }]`. Responses must match the current runtime, session, turn and pending callback. Stale responses fail. All cards and content use operator authority; this version has no agent/operator source separation.

## Identity, delivery and recovery

Discovery includes archived and child conversations, native parent/fork metadata and explicit per-provider results. Missing observations remain unknown. Reading list/history does not resume a native thread or start a model turn. Adoption is explicit and continues the same native ID; writer conflicts do not stop another runtime.

A mutation is journaled before native execution. Request IDs are scoped to the selected [state directory](operations.md#state-directory). The daemon guarantees deduplication for at least 24 hours from first acceptance (`createdAt`), including across restarts that reuse that directory. While the receipt is retained, identical operation/input retries return the original result; changed input under the same ID returns `REQUEST_CONFLICT`. User messages and answer bodies are not copied into management records; durable fingerprints establish identity. Deduplication does not guarantee exactly-once execution across an uncertain crash.

After startup recovery and every 24 hours while running, the daemon can remove older delivered/error receipts that have no active turn, unresolved execution or retained callback association. Accepted/unknown receipts remain regardless of age. After cleanup, reusing the ID can execute a new operation; the protocol does not reject expired IDs or extend the guarantee because a receipt happened to survive longer. Clients must reconcile old outcomes before resubmission. See [receipt retention](storage.md#receipt-retention) for protection rules and operational details.

Operation status is accepted, delivered, error or unknown. Delivered means native command acceptance, not completed execution. Turn state is accepted, running, awaiting_approval, awaiting_input, completed, interrupted, error or unknown. One session permits one active or unresolved turn. Different sessions may execute independently.

Restart reconciles recorded native IDs and completed turns. Unconfirmed delivery remains unknown and blocks a new send. Terminated-runtime callbacks are invalidated. Identity/configuration mismatches require explicit recovery. Native messages and credentials remain in Codex storage.

## History, content and updates

Initial native history returns the latest 50 visible items in source order; limit is 1–500. Reasoning is excluded. Before/after cursors page saved items, while updateCursor tracks new or changed items. Commit a cursor only after merging its page, and drain hasMoreUpdates. An older-page read does not replace the update watermark. Event cursor is a separate nonnegative integer.

Native item IDs and update ordinals establish ordering and merge identity. Terminal metadata establishes completion; a final-answer label alone does not. Volatile liveMessages bridge native persistence delays. Read failures remain explicit and do not advance the corresponding cursor.

Tool output and diffs are read from native Codex items, without a durable Dewbow content copy. Question and approval details are runtime memory only and expire with their turn/runtime. References and byte cursors bind the conversation and an allowlisted content selector; callers cannot choose arbitrary file paths. limitBytes is 4–262144 (default 65536). Pages preserve UTF-8 boundaries. Nonempty completed native command output has unknown completeness because its aggregate can be truncated. A recorded diff describes the native change, not the current file. All history/activity/content reads leave Dewbow storage unchanged.

`GET /api/v1/sessions/{sessionId}/updates` uses the same operator cookie. It emits SSE `snapshot` and `update` events whose JSON data is a `SessionUpdates` object, and `streamError` events whose JSON data is a management error. These data payloads have no HTTP-style `result` or `error` wrapper. OpenAPI represents the framed response as `text/event-stream` and records the JSON payload schemas in the `x-sse-events` extension. See [subscriptions](session-updates.md) for cursor and reconnection behavior. Browser disconnection releases the stream and does not interrupt execution.

## Contract maintenance

Review the OpenAPI file against the Rust [HTTP handlers](../apps/daemon/src/server.rs), [operation validation and dispatch](../apps/daemon/src/service.rs) and [native observation projection](../apps/daemon/src/observation.rs). The retained TypeScript tool catalog is not the HTTP route validator and is not a substitute for checking these implementations. Preserve the distinction between byte limits, JSON Schema character limits and runtime callback constraints.

For an optional local syntax/reference check without adding workspace dependencies:

```sh
npm exec --yes --package=@redocly/cli@2.63.0 --call="redocly lint docs/openapi.yaml --extends=minimal"
```

The validator does not follow the custom `x-sse-events` payload references when finding unused components, so it may warn that `SessionUpdates` is unused. It is the schema for both snapshot and update data. Review those extension references and compare representative JSON and SSE payloads with the schemas; syntax validation alone does not establish implementation conformance.

## Private Network CLI control

The authenticated loopback `/internal/<operation>` surface includes `createNetwork`, `createInvitation`, `joinNetwork`, `listNetworkJoins`, `getNetworkJoin`, `confirmNetworkJoin`, `getNetwork`, `listNetworkMembers`, `removeNetworkMember`, `leaveNetwork` and `setNetworkPeerAddress`. These private operations are outside the browser OpenAPI contract and are never served on the Peer listener. No Network browser route is added. `getNetworkJoin` reads the public key for an exact local pending or retained attempt so denial retries survive restart. Mutation inputs use stable `requestId`; confirmation binds `joinAttemptId`, full `publicKey` and allow/deny decision. Reads do not require a request ID.

See [CLI membership](cli.md#network-membership) for arguments and output. `getNetwork` adds retained join progress, Peer settings and listener status. Members expose exact admission identities and separate short-lived reachability observations. Dissemination reports known-peer current-history acknowledgements and retained per-recipient departure tasks, without a global completion claim. Maintenance rejects mutations while preserving diagnostic reads. These operations do not read or execute remote native sessions.
