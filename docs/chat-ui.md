# Shared chat UI

`packages/core-ui` supplies browser-safe controlled chat contracts, pure model functions, the existing shadcn/ui Base Nova primitives and their neutral theme. Core and Team consume the same package while retaining their own authentication, service startup, navigation and HTTP clients. The view follows the session sidebar pattern: hosts project data and provide callbacks; presentation owns only transient visual state.

## Public entry points

| Entry | Purpose |
| --- | --- |
| `@dewbow/core-ui/chat` | `ChatViewProps` and presentation model types; the chat view is added in the Core integration stage |
| `@dewbow/core-ui/chat/model` | `buildChatModel`, history merging, saved/live message projection and activity merging |
| `@dewbow/core-ui/ui` | Shared shadcn Button, Input, Textarea, NativeSelect, Card, Badge, Alert and `cn` |
| `@dewbow/core-ui/theme.css` | Light/dark design tokens and Tailwind theme mapping |
| `@dewbow/core-ui/styles.css` | Theme and utilities, with package output included in Tailwind scanning |

Build the package after Core protocol and before either Web client. All dependencies retain the repository's pinned versions and single root lockfile. Both clients use the Tailwind Vite plugin. Core keeps its existing application preflight; the shared stylesheet leaves application-wide resets to the host. Team imports shared styles before its existing application styles. Shared components use theme variables, so hosts can override tokens within their chat container.

## Model and ordering

History keeps native messages, volatile replies, native activities and management events separate until projection. Event cursors, native update watermarks and older-history cursors advance independently. Older pages preserve newer live snapshots. Native IDs and source update positions determine merging; completed saved items retain precedence over temporary replies. Restricted placeholders remain restricted through delayed reads.

`buildChatModel` associates management turns with native turns using exact identities. Duplicate associations display native content in a separate group with a notice. User client IDs reconcile host observations with saved user messages. Later user messages in the same turn are instructions. Native final-answer ordinals already represent completion positions. Exact item/client event associations place additional observed instructions relative to known items. Missing associations or positions set `orderIncomplete`; input slots remain stable where sources cannot be compared reliably. History gaps remain visible. The model does not infer associations from matching text or wall-clock timestamps.

Each turn exposes messages, progress, activities, activity positions and interactions. Live tools retain their first reliable event cursor until native ordering is available. Exact final-event anchors also preserve observations after a final reply. Request delivery remains in a separate list. Native resolution and turn completion can arrive before an operation response; hosts project both independently. Approvals and questions retain their interaction identity and authority. Host permission checks remain authoritative even if a UI action is enabled.

Agent hosts apply `restrictHistory` when Core reports operator-only context. That state scrubs all cached message, progress and activity bodies and remains restrictive through delayed or partial pages. Team applies it before reading further history. `buildChatModel` also accepts a restrictive context signal. Operator hosts may display their authorized private content. Activity `availability` describes restricted metadata explicitly; content references retain their enforced read authority.

## Controlled interface

`ChatViewProps` accepts the model, draft, composer state, history state, content states, interaction-loading state and explicit interaction/content permission predicates. Its callbacks cover new messages, steering, structured answers, approval decisions, interruption, original-request retry, older history and private content/detail reads. The host generates and retains request IDs before I/O. Callbacks carry the exact management turn and interaction IDs where required. Retry uses the host's original operation and input. The package creates no network client, service credential or recovery policy.

Draft text and new-turn mode belong to the host, keyed by Core session ID or Team binding ID. The selected mode defaults to Default. An active turn fixes its own mode for steering. Content state is keyed by content ID inside the selected session's cache; hosts release or abort reads when selection or authentication changes. Content loads use Core's chunk limits and explicit completeness. Operator-only interactions in Team route to Core.

The Core and Team chat-view integration stages replace their temporary conversation rendering and complete message-first layout, per-turn activity disclosure, interaction cards, content/diff views and in-memory session draft retention.
