# Session update subscriptions

Core and Team expose authenticated Server-Sent Events (SSE) for selected conversations. Execution commands remain ordinary JSON HTTP operations. Subscribing reads state only: it does not connect or restore a native conversation, start a turn, resume execution, or make a reply eligible for an IM channel.

## Interfaces

| Service | GET path | Target |
| --- | --- | --- |
| Core | `/api/subscribeSessionUpdates?sessionId=...` | A managed or discovered Core session |
| Team | `/api/subscribeBindingUpdates?bindingId=...` | A Team-managed session binding |
| Team | `/api/subscribeChannelConversationUpdates?conversationId=...` | Channel history, binding, takeover, synchronization and delivery state |

All envelopes retain `contractVersion: "v1"`. Core accepts its existing operator cookie or management bearer credential. Team accepts its separate operator cookie or bearer credential. The browser connects to its own service; Team uses its private Core bearer credential on the backend. Credentials never appear in subscription URLs. Origin and content-authority checks match the existing HTTP interfaces.

Core envelopes contain `details` (the public session view) and `history` (the existing history page). Team binding envelopes contain binding `details` and, when Core provides a page, `history`. Channel envelopes also contain `conversation`, the existing conversation management view. A conversation without a binding can still stream its Team state.

The first frame is `snapshot`; later frames are `update`. The server registers for changes before reading the snapshot and coalesces changes while a read is in flight. It uses the existing bounded native history, event and context projections. Message text is accumulated by native message ID before publishing: clients receive the current text, phase and completion status, rather than concatenating raw token deltas. Changes are coalesced at approximately 100 ms; an idle session does not repeatedly read history. Native messages, tool activity, interaction metadata, operation results, pauses and context records retain their existing IDs and authority. Large output and diff bodies remain behind the content-read APIs.

## History and reconnects

Optional `cursor`, `updateCursor` and `contextCursor` query parameters retain the independent management-event, native-item and passive-context positions. Commit a position only after merging its page. Team also accepts `resumeSessionId`: it uses supplied positions only when that ID matches the binding's actual Core session. A channel binding switch starts with fresh positions.

The shared browser subscriber closes a failed connection and reconnects with its committed positions. The server sends a new snapshot and drains additional pages. Existing history merge rules protect completed messages and preserve older-page watermarks. `readSessionHistory` and `readBindingHistory` remain available for pagination, explicit refresh and non-streaming clients. SSE `id` values are connection-local sequence numbers, not history cursors; this interface does not provide token replay or a persistent SSE queue.

The owning daemon supplies immediate native events. Discovered conversations written by another runtime have no owned native notification stream: their updates depend on refreshed discovery observations, and may arrive later. The Core host/session inventory retains its separate ten-second discovery refresh. Subscriptions never adopt another writer to improve update speed.

## Permissions and lifecycle

Core filters every projection with the caller's existing authority, including a final check after asynchronous history reads. Team does not acquire Core operator access. Operator-only context clears the Team browser's cached bodies; delayed or buffered updates cannot restore restricted content. A Core operator can still read authorized private history.

Streams send keepalive comments every fifteen seconds and recheck authentication before writes and keepalives. `streamError` ends a failed or expired subscription; clients show reconnecting or sign-in state. Pending transport output and upstream frame queues are bounded. Slow or interrupted subscribers resynchronize from history rather than growing an unlimited queue.

Navigation and sign-out close the browser subscription and cancel page reads. The Channel workbench shares one conversation subscription with its embedded ChatView. Team closes its upstream Core subscription when the downstream page closes or the binding changes; server shutdown closes active streams. Losing a viewer never interrupts the native turn or Channel delivery worker. No message body is added to a durable Control Plane streaming log.

## Speaking authority

A Channel-owned binding is read-only for ordinary Team operator execution. Both the Channel workbench and ordinary Team session page hide the agent composer. The backend rejects operator `sendBindingMessage`, `steerBindingTurn` and `answerBindingQuestions`, including retries, with `CHANNEL_INPUT_REQUIRED`. Reading, explicit connection and exact-turn interruption remain available. During confirmed takeover, `sendChannelMessage` sends an operator message to the stored recipient and synchronizes it as passive context. Unclaimed Team sessions retain their ordinary chat behavior.

The Channel worker continues to observe its own watches and select completed authorized answers. SSE only changes observation in the Web interfaces. A Web-only turn does not gain DingTalk delivery eligibility, and the browser's connection lifetime does not affect reply delivery.
