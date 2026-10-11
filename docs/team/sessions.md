# Member sessions and Dewbow Core

Team connects to one configured Core Control Plane. Core discovers and manages hosts; Team reads `listHosts` rather than maintaining host rows. `DEWBOW_CORE_URL` and `DEWBOW_CORE_TOKEN` are backend configuration. The browser receives no Core credential. The Team operator credential grants Team administration, not Core approval authority; pending execution approvals must be handled in the Core operator interface.

## Creating and binding

`createMemberSession` accepts `memberId`, `hostId`, absolute host-side `workDir`, and `requestId`. Overrides come only from the member's selected definition. It rejects archived members or teams. It atomically records a binding and the exact Core creation input before the network request, including a generated Core request ID, `agentRef`, and `sessionOptions`. Default uses `{ id: "default", revision: "1" }` with empty options.

The result is `{ binding, operation, error }`. A new binding may have `sessionId: null` until Core's response is received. An accepted operation is not readiness or task completion. Poll `getSessionBinding` to read Core's connection state, runtime state, actual configuration snapshot, turns, approvals, and operations. One member may own several bindings; a Core session ID is unique in Team storage.

## Recovery and uncertainty

Team restarts do not dispatch commands, resume sessions, or create replacements. Reads never execute recovery. `connectMemberSession` is explicit and forwards only the existing Core session ID and the recorded Core request ID. Core resumes using its original configuration snapshot. Team does not re-resolve a definition or append instructions during recovery. Definition edits, deletion after member reassignment, and archival leave existing bindings intact.

Identical retries reuse both the Team and Core request IDs. `retryMemberSessionCreation` accepts `bindingId` and uses the original creation request; it never resolves the current member definition. Changed input under an existing request ID fails with `REQUEST_CONFLICT`. Concurrent identical submissions share one in-process dispatch. Core deduplication remains responsible for cross-process delivery; this does not guarantee exactly-once execution.

Network, timeout, malformed-response, or redirect failures during a write produce `DELIVERY_UNCERTAIN` with the retained binding. Inspect state or retry the original request. Do not generate a new ID to work around uncertainty. A binding and its requests retain the configured Core endpoint; a different endpoint fails with `CORE_TARGET_CHANGED` rather than routing an old session to another Control Plane.

`sendMemberMessage` requires the original message and request ID for retry. Team stores a SHA-256 input fingerprint and command metadata, not the message body. Pending message text is not recoverable from Team storage. The client must retain it or ask the operator to supply the original message. Completed command results do not mean the turn completed; observe Core's turn state separately. Interruptions require the exact active `turnId`.

## API

| Operation | Input | Result |
| --- | --- | --- |
| `getServiceInfo` | `{}` | `{ contractVersion, coreConfigured, coreUrl }` |
| `listHosts` | `{}` | Core `{ hosts }` |
| `createMemberSession` | `memberId`, `hostId`, `workDir`, `requestId` | `{ binding, operation, error }` |
| `retryMemberSessionCreation` | `bindingId` | Original creation result, updated by the retry |
| `listSessionBindings` | optional `teamId`, `memberId` | `{ bindings }` |
| `getSessionBinding` | `bindingId` | `{ binding, requestedOptions, requests, core, coreError }` |
| `connectMemberSession` | `bindingId`, `requestId` | `{ binding, operation, error }` |
| `sendMemberMessage` | `bindingId`, `message`, `requestId` | `{ binding, operation, error }` |
| `interruptMemberTurn` | `bindingId`, exact `turnId`, `requestId` | `{ binding, operation, error }` |
| `readMemberSessionHistory` | `bindingId`, optional `cursor`, `messageCursor`, `limit` | Core event/message history |

`getSessionBinding` keeps local binding and requested configuration information available when Core cannot be read. It reports `coreError` and leaves `core` null. Request records expose command results and errors, without credentials or message bodies. Successful Core reads reconcile their operation results into Team's request journal.

History stays in Core/native Codex storage. The management-event cursor and native-message cursor are independent; clients page each separately. Re-read the final native page during polling and replace messages by native item ID because active messages can change. Merge temporary live output by ID until saved messages catch up. History errors mean unavailable history, not an empty conversation. No history read reconnects the session.
