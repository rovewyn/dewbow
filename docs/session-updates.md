# Session update subscriptions

The Rust daemon exposes operator-authenticated SSE at `GET /api/v1/sessions/{sessionId}/updates`. Optional `cursor` and `updateCursor` remain query parameters; the session identity belongs only in the path. Repeated or unknown query parameters are rejected. Execution commands remain ordinary JSON HTTP operations. Subscribing only reads state; it does not connect a native conversation or start a turn. Responses use `Cache-Control: no-store`.

Credentials never appear in subscription URLs. Host and supplied Origin checks match the [Web API](interfaces.md). SSE `snapshot` and `update` events carry JSON objects containing `contractVersion: "v1"`, `instanceId`, details and bounded history; these payloads have no `result` wrapper. `streamError` carries a management error directly, without an `error` wrapper. See the [OpenAPI contract](openapi.yaml) for framing, query parameters and payload schemas.

## Snapshots and reconnects

The first envelope is snapshot; subsequent envelopes are update. Each envelope includes the current daemon `instanceId`. Optional cursor and updateCursor query parameters retain separate volatile management-event and native-item positions. The first snapshot replays the bounded memory event buffer; Web resets volatile events when the instance changes. Commit each position only after merging the returned batch. Reconnects drain bounded native pages rather than replaying raw token deltas. Management events are not persisted and cannot restore a previous runtime's notifications.

The service wakes on native/journal changes and also checks saved native history once per second to observe persistence updates. Native history read failures appear in `history.historyError` within the snapshot/update, while a failure to assemble an update emits `streamError`. The corresponding native cursor stays unchanged on a failed read. Authentication expiry emits `streamError` with `UNAUTHORIZED`; Web closes the stream and requires a new login. Completed native messages outrank partial live snapshots; both preserve source identity and ordering. The stream does not emit event IDs or implement `Last-Event-ID` replay; reconnect using the separate query cursors and daemon instance identity.

## Remote subscriptions

`GET /api/v1/networks/{networkId}/hosts/{hostId}/sessions/{sessionId}/updates`
uses the entry's operator cookie and a direct authenticated connection to the
selected target. Query parameters and `Last-Event-ID` are rejected. Peer SSE uses
the bounded start/chunk/end framing; only a complete validated logical event reaches
the browser as `snapshot` or `update`. Data contains the remote identity envelope
and the existing `SessionUpdates` in `payload`, as defined in [interfaces](interfaces.md#network-reads).

Each reconnect starts with a new subscription ID, event ID 1 and current snapshot.
Native history pagination is available through the remote history resource. Native
and volatile event positions stay independent. Instance identity belongs to the
target's owned native process. Target restart requires a fresh snapshot and discards
old runtime notifications. No durable replay log or content copy exists.

Both ends recheck authority and history throughout delivery. Any accepted membership
history change invalidates that subscription; reconcile and resubscribe after
`SYNC_REQUIRED`. Removed callers and inactive targets lose Network access when the
change is accepted locally. Network partitions cannot provide instantaneous global
revocation. Slow consumers use bounded memory and transport backpressure; exhaustion
ends delivery explicitly. Viewer cancellation, logout and shutdown release the stream
without interrupting the target's native task.

## Lifetime

All content uses operator authority. Navigation and sign-out close the browser stream and cancel page reads. Server shutdown closes active streams. Losing a viewer never interrupts a native turn. Message bodies are not copied into a durable streaming log.
