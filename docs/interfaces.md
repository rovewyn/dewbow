# Dewbow Web API

The Rust daemon exposes loopback Web operations using the shared `v1` camelCase contract. `POST /api/<operation>` accepts a JSON object and returns `{ result: ... }` or `{ error: { code, message, retryable } }`. Browser operations require the operator cookie and the daemon's exact Host and Origin. No MCP endpoint or external agent bearer access is provided.

`dewbow web` requests a 60-second one-use ticket through a separate protected local control endpoint. Web removes the URL fragment ticket before `POST /auth/login`, then uses an HttpOnly SameSite=Strict cookie. `POST /auth/logout` revokes it. Tickets and cookies expire in memory and are invalidated when the daemon exits. Never expose the private control credential in browser storage or URLs.

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

A mutation is journaled before native execution. Request IDs are scoped to this daemon. Identical operation/input retries return the original result; changed input under the same ID returns REQUEST_CONFLICT. User messages and answer bodies are not copied into management records; durable fingerprints establish identity. Deduplication does not guarantee exactly-once execution across an uncertain crash.

Operation status is accepted, delivered, error or unknown. Delivered means native command acceptance, not completed execution. Turn state is accepted, running, awaiting_approval, awaiting_input, completed, interrupted, error or unknown. One session permits one active or unresolved turn. Different sessions may execute independently.

Restart reconciles recorded native IDs and completed turns. Unconfirmed delivery remains unknown and blocks a new send. Terminated-runtime callbacks are invalidated. Identity/configuration mismatches require explicit recovery. Native messages and credentials remain in Codex storage.

## History, content and updates

Initial native history returns the latest 50 visible items in source order; limit is 1–500. Reasoning is excluded. Before/after cursors page saved items, while updateCursor tracks new or changed items. Commit a cursor only after merging its page, and drain hasMoreUpdates. An older-page read does not replace the update watermark. Event cursor is a separate nonnegative integer.

Native item IDs and update ordinals establish ordering and merge identity. Terminal metadata establishes completion; a final-answer label alone does not. Volatile liveMessages bridge native persistence delays. Read failures remain explicit and do not advance the corresponding cursor.

Tool output, diffs and question details live in a separate private content database. References and byte cursors bind the conversation; callers cannot choose arbitrary file paths. limitBytes is 4–262144 (default 65536). Chunks preserve UTF-8 boundaries. Terminal captured output takes precedence over truncated native aggregate output; incomplete/interrupted output retains explicit completeness. A recorded diff describes the native change, not the current file.

`GET /api/subscribeSessionUpdates?sessionId=...` uses the same operator cookie and emits snapshot, update and streamError envelopes. See [subscriptions](session-updates.md). Browser disconnection releases the stream and does not interrupt execution.
