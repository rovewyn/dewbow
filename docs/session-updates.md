# Session update subscriptions

The Rust daemon exposes operator-authenticated SSE at `GET /api/subscribeSessionUpdates?sessionId=...`. Execution commands remain ordinary JSON HTTP operations. Subscribing only reads state; it does not connect a native conversation or start a turn.

Credentials never appear in subscription URLs. Host and supplied Origin checks match the [Web API](interfaces.md). SSE `snapshot` and `update` events carry JSON objects containing `contractVersion: "v1"`, `instanceId`, details and bounded history; these payloads have no `result` wrapper. `streamError` carries a management error directly, without an `error` wrapper. See the [OpenAPI contract](openapi.yaml) for framing, query parameters and payload schemas.

## Snapshots and reconnects

The first envelope is snapshot; subsequent envelopes are update. Each envelope includes the current daemon `instanceId`. Optional cursor and updateCursor query parameters retain separate volatile management-event and native-item positions. The first snapshot replays the bounded memory event buffer; Web resets volatile events when the instance changes. Commit each position only after merging the returned batch. Reconnects drain bounded native pages rather than replaying raw token deltas. Management events are not persisted and cannot restore a previous runtime's notifications.

The service wakes on native/journal changes and also checks saved native history once per second to observe persistence updates. Native history read failures appear in `history.historyError` within the snapshot/update, while a failure to assemble an update emits `streamError`. The corresponding native cursor stays unchanged on a failed read. Authentication expiry emits `streamError` with `UNAUTHORIZED`; Web closes the stream and requires a new login. Completed native messages outrank partial live snapshots; both preserve source identity and ordering. The stream does not emit event IDs or implement `Last-Event-ID` replay; reconnect using the separate query cursors and daemon instance identity.

## Lifetime

All content uses operator authority. Navigation and sign-out close the browser stream and cancel page reads. Server shutdown closes active streams. Losing a viewer never interrupts a native turn. Message bodies are not copied into a durable streaming log.
