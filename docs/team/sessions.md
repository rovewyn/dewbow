# Session bindings and Dewbow Core

Team connects to one configured Core Control Plane. Core discovers and manages hosts; Team reads `listHosts` rather than maintaining host rows. `DEWBOW_CORE_URL` and `DEWBOW_CORE_TOKEN` are backend configuration. The browser receives no Core credential. The Team operator credential grants Team administration, not Core approval authority; pending execution approvals must be handled in the Core operator interface.

## Creating and binding

`createMemberSession` accepts `memberId`, `hostId`, `requestId`, and either an absolute host-side `workDir` or `workspaceProfileId`. `createAgentSession` accepts `definitionId`, `hostId`, `workspaceProfileId` and `requestId` without a member. Both use the same binding service. Overrides come only from the selected definition. Member creation rejects archived members or teams. Creation atomically records a binding and the exact Core creation input before the network request, including a generated Core request ID, `agentRef`, and `sessionOptions`. Default uses `{ id: "default", revision: "1" }` with empty options.

The result is `{ binding, operation, error }`. A new binding may have `sessionId: null` until Core's response is received. An accepted operation is not readiness or task completion. Poll `getSessionBinding` to read Core's connection state, runtime state, actual configuration snapshot, turns, interactions, and operations. One member may own several bindings; a Core session ID is unique in Team storage.

## Recovery and uncertainty

Binding reads do not dispatch commands, resume sessions, or create replacements. Channels reconciles its original delivery records after restart; see [Channels](channels.md). Reads never execute recovery. `connectSessionBinding` is explicit and forwards only the existing Core session ID and the recorded Core request ID. Core resumes using its original configuration snapshot. Team does not re-resolve a definition or append instructions during recovery. Definition edits, deletion after member reassignment, and archival leave existing bindings intact.

Identical retries reuse both the Team and Core request IDs. `retrySessionBindingCreation` accepts `bindingId` and uses the original creation request; it never resolves the current member definition. Changed input under an existing request ID fails with `REQUEST_CONFLICT`. Concurrent identical submissions share one in-process dispatch. Core deduplication remains responsible for cross-process delivery; this does not guarantee exactly-once execution.

Network, timeout, malformed-response, or redirect failures during a write produce `DELIVERY_UNCERTAIN` with the retained binding. Inspect state or retry the original request. Do not generate a new ID to work around uncertainty. A binding and its requests retain the configured Core endpoint; a different endpoint fails with `CORE_TARGET_CHANGED` rather than routing an old session to another Control Plane.

`sendBindingMessage` requires the original message and request ID for retry. Team stores a SHA-256 input fingerprint and command metadata, not the message body. Pending message text is not recoverable from Team storage. The client must retain it or ask the operator to supply the original message. Completed command results do not mean the turn completed; observe Core's turn state separately. Interruptions require the exact active `turnId`.

## API

| Operation | Input | Result |
| --- | --- | --- |
| `getServiceInfo` | `{}` | `{ contractVersion, coreConfigured, coreUrl }` |
| `listHosts` | `{}` | Core `{ hosts }` |
| `listWorkspaceProfiles` | `hostId` | Host-owned profile IDs, names and kinds |
| `createAgentSession` | `definitionId`, `hostId`, `workspaceProfileId`, `requestId` | `{ binding, operation, error }` |
| `createMemberSession` | `memberId`, `hostId`, `requestId`, one of `workDir` or `workspaceProfileId` | `{ binding, operation, error }` |
| `retrySessionBindingCreation` | `bindingId` | Original creation result, updated by the retry |
| `listSessionBindings` | optional `teamId`, `memberId` | `{ bindings }` |
| `getSessionBinding` | `bindingId` | `{ binding, requestedOptions, requests, core, coreError }` |
| `connectSessionBinding` | `bindingId`, `requestId` | `{ binding, operation, error }` |
| `sendBindingMessage` | `bindingId`, `message`, `requestId`, optional `mode` (`default` or `plan`, default `default`) | `{ binding, operation, error }` |
| `steerBindingTurn` | `bindingId`, exact active `turnId`, `message`, `requestId` | Append instructions with the current mode |
| `answerBindingQuestions` | `bindingId`, exact `turnId`, `interactionId`, `requestId`, structured `answers` | Respond to ordinary questions; Core enforces authority |
| `interruptBindingTurn` | `bindingId`, exact `turnId`, `requestId` | `{ binding, operation, error }` |
| `readBindingHistory` | `bindingId`, optional `cursor`, one of `beforeCursor`, `afterCursor`, `updateCursor`, `limit` | Core event, message and activity history |
| `getBindingActivity` | `bindingId`, native `itemId` | Core activity and private content references |
| `readBindingContent` | `bindingId`, `contentId`, optional `contentCursor`, `limitBytes` | Transient Core content chunk |

`getSessionBinding` keeps local binding and requested configuration information available when Core cannot be read. It reports `coreError` and leaves `core` null. Request records expose command results and errors, without credentials or message bodies. Successful Core reads reconcile their operation results into Team's request journal.

Steering and answers preserve the page request ID to Core request ID mapping, operation, turn, interaction and mode. Their body fingerprints persist; message and answer bodies do not enter Team's request journal. Retry the exact original operation, ID and input after uncertainty. The browser retains pending input in memory; a refresh can require the original message to be supplied again. An ordinary question's retained answer may be read from its host-private details for an original-response retry. Unknown-origin, approval and secret interactions require the Core operator. A conversation that received private operator input cannot be continued or read through Team because subsequent native context may repeat that input. Restricted messages/content explicitly link back to Core.

History stays in native Codex and host-private storage. Reads resolve the binding's original authenticated Core target. Management events, older/newer native pages and native updates have independent cursors. Initial history returns the latest 50 items; poll the update watermark for changes to existing IDs and preserve it when loading older history. Merge by native ID, source version and completion state. A delayed older-page response must not lower the event cursor or replace a newer live snapshot. Full output and recorded diffs pass through Team only for the requested chunk and never enter its durable records. History errors mean unavailable history, not an empty conversation. No history read reconnects the session.
