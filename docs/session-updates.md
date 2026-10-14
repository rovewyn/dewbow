# Session update subscriptions

Dewbow exposes authenticated Server-Sent Events (SSE) for a selected conversation at `GET /api/subscribeSessionUpdates?sessionId=...`. Execution commands remain ordinary JSON HTTP operations. Subscribing reads state only; it does not connect a native conversation or start a turn.

The endpoint accepts an operator cookie or management bearer credential. Credentials never appear in subscription URLs. Origin and content-authority checks match the ordinary HTTP interfaces. Envelopes contain `contractVersion: "v1"`, `details` (the public session view), and `history` (the existing bounded history page).

## Snapshots and reconnects

The first envelope is `snapshot`; later envelopes are `update`. Optional `cursor` and `updateCursor` query parameters retain independent management-event and native-item positions. Commit a position only after merging its page. Reconnects drain bounded pages rather than replaying raw token deltas. A history or event read failure leaves its corresponding position unchanged and reports the existing structured error.

Notifications follow journal changes and native history updates. Idle subscriptions do not poll native history. Snapshot and incremental pages use the same source identities, completeness metadata, restricted placeholders, and source ordering as ordinary reads.

## Authority and lifetime

Every projection uses the caller's existing authority, including a final check after asynchronous history reads. A conversation containing private operator input remains restricted to the operator. Delayed snapshots and buffered updates cannot disclose private messages or activities to a management client.

Navigation and sign-out close the browser subscription and cancel page reads. A disconnected client cannot start a subscription after a pending preflight read completes. Server shutdown closes active streams. Losing a viewer never interrupts a native turn. No message body is added to a durable Control Plane streaming log.
