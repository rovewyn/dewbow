# Session update subscriptions

The Rust daemon exposes operator-authenticated SSE at `GET /api/subscribeSessionUpdates?sessionId=...`. Execution commands remain ordinary JSON HTTP operations. Subscribing only reads state; it does not connect a native conversation or start a turn.

Credentials never appear in subscription URLs. Host and supplied Origin checks match the Web API. Envelopes contain `contractVersion: "v1"`, details and bounded history.

## Snapshots and reconnects

The first envelope is snapshot; subsequent envelopes are update. Each envelope includes the current daemon `instanceId`. Optional cursor and updateCursor query parameters retain separate volatile management-event and native-item positions. The first snapshot replays the bounded memory event buffer; Web resets volatile events when the instance changes. Commit each position only after merging the returned batch. Reconnects drain bounded native pages rather than replaying raw token deltas. Management events are not persisted and cannot restore a previous runtime's notifications.

The service wakes on native/journal changes and also checks saved native history once per second to observe persistence updates. Native read failures remain visible with streamError and the corresponding cursor stays unchanged. Completed native messages outrank partial live snapshots; both preserve source identity and ordering.

## Lifetime

All content uses operator authority. Navigation and sign-out close the browser stream and cancel page reads. Server shutdown closes active streams. Losing a viewer never interrupts a native turn. Message bodies are not copied into a durable streaming log.
