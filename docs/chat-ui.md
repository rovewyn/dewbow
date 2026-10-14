# Shared chat UI

`packages/ui` supplies browser-safe controlled chat contracts, pure model functions, the existing shadcn/ui Base Nova primitives and their neutral theme. The operator Web consumes this package through its authenticated management client. The view follows the session sidebar pattern: hosts project data and provide callbacks; presentation owns only transient visual state.

## Public entry points

| Entry | Purpose |
| --- | --- |
| `@dewbow/ui/chat` | `ChatView`, `ChatViewProps` and presentation model types |
| `@dewbow/ui/chat/model` | `buildChatModel`, history merging, saved/live message projection and activity merging |
| `@dewbow/ui/chat/updates` | Browser SSE subscription with committed-cursor reconnect and teardown |
| `@dewbow/ui/ui` | Shared shadcn Button, Input, Textarea, NativeSelect, Card, Badge, Alert and `cn` |
| `@dewbow/ui/theme.css` | Light/dark design tokens and Tailwind theme mapping |
| `@dewbow/ui/styles.css` | Theme, chat styles and utilities, with package output included in Tailwind scanning |

Build the package after Dewbow protocol and before Web. All dependencies retain the repository's pinned versions and single root lockfile. Web uses the Tailwind Vite plugin. Dewbow keeps its existing application preflight; the shared stylesheet leaves application-wide resets to the host. Shared components use theme variables, so hosts can override tokens within their chat container.

## Model and ordering

History keeps native messages, volatile replies, native activities and management events separate until projection. Event cursors, native update watermarks and older-history cursors advance independently. Older pages preserve newer live snapshots. Native IDs and source update positions determine merging; completed saved items retain precedence over temporary replies. Restricted placeholders remain restricted through delayed reads.

`buildChatModel` associates management turns with native turns using exact identities. Duplicate associations display native content in a separate group with a notice. User client IDs reconcile host observations with saved user messages. Later user messages in the same turn are instructions. Native final-answer and completed Plan-output ordinals already represent completion positions. Completed native `plan` messages render as final replies; unfinished plans remain progress. Exact item/client event associations place additional observed instructions relative to known items. Missing associations or positions set `orderIncomplete`; input slots remain stable where sources cannot be compared reliably. History gaps remain visible. The model does not infer associations from matching text or wall-clock timestamps.

Each turn exposes messages, progress, activities, activity positions, interactions and an ordered entry projection. Live tools retain their first reliable event cursor until native ordering is available. Exact final-event anchors also preserve observations after a final reply. Request delivery remains in a separate list. Native resolution and turn completion can arrive before an operation response; hosts project both independently. Approvals and questions retain their interaction identity and authority. Host permission checks remain authoritative even if a UI action is enabled.

Agent hosts apply `restrictHistory` when Dewbow reports operator-only context. That state scrubs all cached message, progress and activity bodies and remains restrictive through delayed or partial pages. `buildChatModel` also accepts a restrictive context signal. Operator hosts may display their authorized private content. Activity `availability` describes restricted metadata explicitly; content references retain their enforced read authority.

## Controlled interface

`ChatViewProps` accepts the model, draft, composer state, history state, content states, interaction-loading state and explicit interaction/content permission predicates, current submission readiness and content-read availability. Its callbacks cover new messages, steering, structured answers, approval decisions, interruption, original-request retry, original-text resubmission, older history and private content/detail reads. The host generates and retains request IDs before I/O. Callbacks carry the exact management turn and interaction IDs where required. Retry uses the host's original operation and input. ChatView itself creates no network client, service credential or recovery policy. Its host controller can use the shared SSE subscriber and continues to own history merging, authorization and execution callbacks. See [Session update subscriptions](session-updates.md).

Draft text and new-turn mode belong to the host, keyed by session ID. The selected mode defaults to Default. An active turn fixes its own mode for steering. Content state is keyed by content ID inside the selected session's cache; hosts release or abort reads when selection or authentication changes. Content loads use Dewbow's chunk limits and explicit completeness.

Request rows use a host-owned identity key distinct from the displayed `requestId`. Dewbow uses the server `commandId`, or a session/operation/request tuple before a response. Dewbow Web retries only operator-originated requests; an uncertain agent request must be retried through its original client. Terminal results release retained inputs even when the selected view has closed. Read-only content needs an online host, while mutations also require an execution connection.

`projectHistoryWindow` limits replayed messages and tools to loaded native turns and the active turn, preserving global gap notices and exact observed associations. It prevents old completed task fragments from appearing before their native history page has loaded. Expanding tools or loading content pauses automatic following; older pagination retains the visible entry and restores keyboard focus to the history region.

Web uses ChatView through its session controller. Messages and intervening activity runs retain their projected positions; tool runs default to collapsed. Pending interactions stay visible and an attention shortcut reveals the first current card. Recorded interaction history is separate. The view preserves a visible-entry anchor when older history arrives, stops following after a user scrolls away, and provides Jump to latest. Full content loads use explicit chunk and completeness states; large diffs retain their complete text with a bounded highlighted-line count.