# Dewbow Web API

The Rust daemon exposes loopback Web operations using the shared `v1` camelCase contract. The machine-readable [OpenAPI contract](openapi.yaml) describes the current operator HTTP surface, including input/output schemas, authentication, errors and SSE framing. It uses OpenAPI 3.1; its `info.version: v1` identifies the management contract rather than the product release. Keep it aligned with the Rust daemon implementation when changing the API.

## API design and authority

The daemon serves both embedded Web assets and the operator API on `http://127.0.0.1:<configured-port>` (default port `3000`). The design uses named management operations rather than resource-oriented REST routes: reads and mutations are JSON `POST /api/<operation>` requests. Request bodies are objects, unknown top-level fields are rejected, and the JSON body limit is 1 MiB. The daemon validates the operation, manages request identity and recovery, then calls its owned native Codex runtime or reads native storage through the SDK. The browser never reads databases directly.

There are two authority boundaries. The browser uses an operator cookie for the documented Web API. The CLI uses a private control credential for `/internal/<operation>`, including lifecycle, ticket issuance and upgrade handshakes. Those private control routes and static assets are outside the OpenAPI contract. No MCP endpoint, remote management or external agent bearer access is provided.

`dewbow web` requests a 60-second one-use ticket through a separate protected local control endpoint. Web removes the URL fragment ticket before `POST /auth/login`, then uses an HttpOnly SameSite=Strict cookie. `POST /auth/logout` revokes it. Tickets and cookies expire in memory and are invalidated when the daemon exits. Never expose the private control credential in browser storage or URLs.

The cookie lasts at most 12 hours. Every Web POST requires `Host: 127.0.0.1:<configured-port>` and an `Origin` exactly equal to the server URL. SSE requires the same cookie and Host; if an Origin is supplied, it must also match. Using `localhost`, another hostname or a different port does not satisfy these checks. `GET /health` is an unauthenticated listener probe returning `{ "status": "available" }`; it does not establish native readiness or daemon identity.

## Requests, responses and errors

Successful management requests return HTTP 200 with `{ "result": ... }`. Management failures return `{ "error": { "code", "message", "retryable" } }` with these current status mappings:

| HTTP status | Management codes |
| --- | --- |
| `400` | All other management errors, including `INVALID_INPUT`, `REQUEST_CONFLICT`, `DELIVERY_UNCERTAIN`, `RECOVERY_REQUIRED` and `UNAVAILABLE` |
| `401` | `UNAUTHORIZED`, including invalid credentials or a rejected Host/Origin |
| `403` | `FORBIDDEN` |
| `404` | `NOT_FOUND` |

Once a mutation has a receipt, a delivery failure or uncertain outcome may instead appear in an HTTP 200 operation's `status` and `error`. Discovery and history reads also return explicit partial-read errors inside their results. Clients must inspect these fields. `retryable` does not mean the native action never happened or authorize retrying with a new request ID. Login body extraction can return framework plain-text `400`, `413`, `415` or `422` errors rather than a management envelope; the OpenAPI file records that exception.

For example, `POST /api/sendMessage` with `{ "sessionId": "session-example", "message": "Hello", "requestId": "req-123" }` returns an operation receipt with `commandId`, target IDs, delivery `status` and an optional error. Follow `getSession` or the subscription for the turn's actual state and use `readSessionHistory` for native messages. `delivered` alone does not establish a completed answer. Retain the original request ID and identical input when retrying a lost response.

## Contract version

The management contract's current name is `v1`. It covers operation names, input/output shapes, errors and session update semantics. The protocol package declares this version, and session update snapshots include `contractVersion: "v1"`. HTTP operations still use `/api/<operation>`; the current service has no versioned API routes or multi-version negotiation. The marker describes the one contract implemented by the bundled daemon and Web client.

Product releases do not automatically advance this contract. An additive change that preserves existing clients' behavior can remain in `v1`. Renaming or removing a required field, or changing delivery/error semantics incompatibly, requires an explicit contract-version decision and coordinated client/daemon transition. A future `v2` is possible when needed, not a requirement for the next product release. This is independent of the integer [database schema version](storage.md#version-identifiers).

## Operations

| Operation | Input | Result |
| --- | --- | --- |
| `listHosts` | `{}` | `{ hosts }` containing this local host |
| `listSessions` | optional `hostId` | `{ sessions, discovery }` |
| `getSession` | `sessionId` | Session, host, turns, interactions and operations |
| `createSession` | `hostId, workDir, requestId`, optional `sessionOptions` | Operation with new management session ID |
| `connectSession` | `sessionId, requestId` | Operation retaining the native conversation ID |
| `readSessionHistory` | `sessionId`, optional event `cursor`, one native `beforeCursor/afterCursor/updateCursor`, `limit` | Bounded events, messages, activities and independent cursors |
| `getSessionActivity` | `sessionId, itemId` | Exact native activity metadata and private content references |
| `readSessionContent` | `sessionId, contentId`, optional `contentCursor, limitBytes` | Bounded UTF-8 content page |
| `sendMessage` | `sessionId, message, requestId`, optional `mode` | New turn operation; mode is default or plan |
| `steerTurn` | `sessionId, turnId, message, requestId` | Instruction to the exact active turn |
| `answerQuestions` | `sessionId, turnId, interactionId, requestId, answers` | Exact question callback response |
| `decideApproval` | `sessionId, turnId, interactionId, requestId, decision` | Single-request allow or deny |
| `interruptTurn` | `sessionId, turnId, requestId` | Interrupt delivery; native confirmation follows separately |

`workDir` is an existing absolute local directory. Creation options permit model, reasoningEffort and instructionsAppend only. Models and efforts must be advertised by native Codex. Dewbow freezes the resolved creation model, effort, composed developer instructions and host-owned workspace sandbox/approval policy. It confirms identity, working directory and the managed settings on native resume. No member workspace profile or arbitrary native config input is accepted.

Question answers are `[{ questionId, answers: string[] }]`. Responses must match the current runtime, session, turn and pending callback. Stale responses fail. All cards and content use operator authority; this version has no agent/operator source separation.

## Identity, delivery and recovery

Discovery includes archived and child conversations, native parent/fork metadata and explicit per-provider results. Missing observations remain unknown. Reading list/history does not resume a native thread or start a model turn. Adoption is explicit and continues the same native ID; writer conflicts do not stop another runtime.

A mutation is journaled before native execution. Request IDs are scoped to the selected [state directory](operations.md#state-directory) and survive daemon restarts that reuse it. Identical operation/input retries return the original result; changed input under the same ID returns REQUEST_CONFLICT. User messages and answer bodies are not copied into management records; durable fingerprints establish identity. Deduplication does not guarantee exactly-once execution across an uncertain crash.

Operation status is accepted, delivered, error or unknown. Delivered means native command acceptance, not completed execution. Turn state is accepted, running, awaiting_approval, awaiting_input, completed, interrupted, error or unknown. One session permits one active or unresolved turn. Different sessions may execute independently.

Restart reconciles recorded native IDs and completed turns. Unconfirmed delivery remains unknown and blocks a new send. Terminated-runtime callbacks are invalidated. Identity/configuration mismatches require explicit recovery. Native messages and credentials remain in Codex storage.

## History, content and updates

Initial native history returns the latest 50 visible items in source order; limit is 1–500. Reasoning is excluded. Before/after cursors page saved items, while updateCursor tracks new or changed items. Commit a cursor only after merging its page, and drain hasMoreUpdates. An older-page read does not replace the update watermark. Event cursor is a separate nonnegative integer.

Native item IDs and update ordinals establish ordering and merge identity. Terminal metadata establishes completion; a final-answer label alone does not. Volatile liveMessages bridge native persistence delays. Read failures remain explicit and do not advance the corresponding cursor.

Tool output and diffs are read from native Codex items, without a durable Dewbow content copy. Question and approval details are runtime memory only and expire with their turn/runtime. References and byte cursors bind the conversation and an allowlisted content selector; callers cannot choose arbitrary file paths. limitBytes is 4–262144 (default 65536). Pages preserve UTF-8 boundaries. Nonempty completed native command output has unknown completeness because its aggregate can be truncated. A recorded diff describes the native change, not the current file. All history/activity/content reads leave Dewbow storage unchanged.

`GET /api/subscribeSessionUpdates?sessionId=...` uses the same operator cookie. It emits SSE `snapshot` and `update` events whose JSON data is a `SessionUpdates` object, and `streamError` events whose JSON data is a management error. These data payloads have no HTTP-style `result` or `error` wrapper. OpenAPI represents the framed response as `text/event-stream` and records the JSON payload schemas in the `x-sse-events` extension. See [subscriptions](session-updates.md) for cursor and reconnection behavior. Browser disconnection releases the stream and does not interrupt execution.

## Contract maintenance

Review the OpenAPI file against the Rust [HTTP handlers](../apps/daemon/src/server.rs), [operation validation and dispatch](../apps/daemon/src/service.rs) and [native observation projection](../apps/daemon/src/observation.rs). The retained TypeScript tool catalog is not the HTTP route validator and is not a substitute for checking these implementations. Preserve the distinction between byte limits, JSON Schema character limits and runtime callback constraints.

For an optional local syntax/reference check without adding workspace dependencies:

```sh
npm exec --yes --package=@redocly/cli@2.63.0 --call="redocly lint docs/openapi.yaml --extends=minimal"
```

The validator does not follow the custom `x-sse-events` payload references when finding unused components, so it may warn that `SessionUpdates` is unused. It is the schema for both snapshot and update data. Review those extension references and compare representative JSON and SSE payloads with the schemas; syntax validation alone does not establish implementation conformance.
