# Dewbow operator Web interface

`@dewbow/web` uses React, TypeScript, Vite, Tailwind and shadcn/ui with Base UI primitives. It is the operator client of the Rust daemon. It imports shared UI, public record types and browser-safe protocol helpers. Server implementations and the SDK stay outside the browser. All assets are embedded locally in Dewbow.

## Workflow

Run `dewbow web` for a one-use CLI login link. Web clears the ticket fragment before exchanging it for an operator cookie; no daemon or native credential is stored in browser storage. Direct unauthenticated visits show CLI instructions. The session navigator groups conversations under the local host and displays the native parent/child hierarchy. Rows expose titles, IDs, directories and runtime/connection states. Archived conversations and managed sessions being created or recovered remain visible. Select a native-only conversation and click Connect conversation to resume its existing native ID. A writer conflict appears in operation status; release the conversation in its original runtime before retrying.

Hosts initially expand and session branches initially collapse. Restoring or selecting a session reveals its ancestor path once. Polling preserves user expansion choices; collapsing the selected branch does not close its conversation. Expansion lasts for the current page mount. Search matches names, directories and management/native IDs. Results contain only matches and their ancestors, and result paths expand automatically. Search expansion is separate from normal expansion, so clearing search restores the earlier tree state. Searching does not change selection or the conversation panel. Matching counts exclude ancestor-only rows.

Use Up/Down and Home/End to move through visible tree items, Right to expand or enter a branch, Left to collapse or move to its parent, and Enter/Space to select a session or toggle a host. The tree has one tab stop. Expand buttons and session titles are separate pointer targets. Titles truncate on narrow screens; states and keyboard focus remain visible. Escape in search clears the query.

Selecting a session keeps the conversation panel's previous height while its replacement loads, then releases that minimum height when the new content arrives. The loading panel exposes no actions from the previous session. Pointer selection and expansion focus the tree item without scrolling the page or tree; keyboard navigation can still scroll the focused item into view. Conversation history follows new entries within its own scroll area.

Lineage resolves native parent IDs within the same host and Codex home. Fork origins are supplementary metadata and do not create parent links. Missing, ambiguous or cyclic parent relationships remain visible under the host with a warning. Host and session order follows the received inventory.

Select a session to read native saved messages. Managed sessions also show tool metadata, turn state and pending approvals. Native-only sessions keep sending disabled until connection is confirmed. Send creates a new turn in the same conversation. Approval Allow/Deny targets the exact active callback. Interrupt requests stopping; its delivery status and the eventual terminal turn state remain separate. Controls are disabled when the host is unavailable or the target is no longer actionable. Unknown runtime states show their last known observation and reject follow-ups pending recovery.

The create form selects the local host and an existing absolute working directory. Web uses operator-authorized management operations. Busy, pending, uncertain and failed requests remain visible. Transport failures offer a retry with the original request ID and input. Delivery details are available in the conversation's request list.

The composer selects Default or Plan for a new turn. During confirmed running/input/approval states it appends an instruction to the exact active turn and displays that turn's fixed mode. Question cards show native options and permitted custom input; approvals retain separate Allow/Deny actions and request IDs. Unsupported callbacks expose an interruption path. Pending bodies remain in page memory through accepted/unknown delivery and can be retried with the original operation and ID. They are released on a definite result or sign-out. Composer text and new-turn mode remain in memory for each session across selection changes. Refresh and sign-out clear drafts. Ctrl/Command + Enter submits a message; plain Enter inserts a line break.

The host/session catalog refreshes every ten seconds. The selected conversation uses the authenticated Dewbow SSE subscription; see [Session update subscriptions](session-updates.md). The initial native page contains the latest 50 items; Load older history fetches preceding items and preserves the conversation scroll position. History, native updates and daemon event cursors remain independent. Subscription pages include changes to existing IDs and advance positions only after committing each batch. Completed native messages take precedence over partial snapshots and retain reliable source order. History unavailable errors remain visible and event cursors do not advance on failure. A selected session ID is in the URL fragment, so refresh restores the same conversation when the host is available. Closing the browser releases its subscription without interrupting daemon execution. Inventory timers, subscriptions and page reads are cancelled on teardown or selection change. The shared ChatView renders message-first turn entries. Consecutive tool activities collapse in their source positions; pending approvals and questions stay outside tool disclosures and expose an attention shortcut. Completed interactions have a separate history disclosure. Expanded activities load complete output or recorded diff in 64 KiB chunks, with explicit completeness and Load more controls. Content reads are transient and cancelled on selection change. Older pages preserve a visible entry anchor; scrolling away from the latest message stops automatic following until Jump to latest.

## Build and local use

From the repository root:

```sh
npm ci
npm run build
cargo build --bin dewbow
dewbow web
```

Initialize native Codex using the [CLI guide](cli.md). The embedded Web is served at the daemon origin, normally `http://127.0.0.1:3000`. It requires no separate Web service or browser-visible environment secrets. Use the compiled executable path if it is not on PATH.

For UI development against the default local daemon:

```sh
npm run web
```

Vite binds to `http://127.0.0.1:5173`. Its development-only `/api` and `/auth` proxies target `http://127.0.0.1:3000` and forward the daemon's Host and Origin. Open with CLI first, then use the same browser at Vite: the loopback cookie applies to the same host across ports. These proxies are excluded from production assets. `npm run web -- --port 5174` selects another available port. Production origin checks remain strict.

`npm run web:preview` serves static assets alone at `http://127.0.0.1:4173`; it has no management proxy and is useful for static inspection. Use the Rust daemon for full integration. Stop development/preview with Ctrl+C and the daemon with `dewbow daemon stop`.

## UI foundation

`components.json` records shadcn CLI 4.21.4's `base-nova` style. Component source and class utilities now live in `packages/ui/src/ui/`, with theme tokens and chat styles in that package. `src/ui.css` retains Dewbow application preflight. Button, Input, Textarea, NativeSelect, Badge, Card and Alert are generated from the official shadcn registry with CLI 4.21.4. The select uses Lucide for its local chevron. Application CSS handles layout and state colors; component source handles controls and focus styles. The application needs no external font, theme switcher, desktop wrapper, or new routing library.

`src/components/session-tree/SessionTreeView.tsx` is an independent view built with the existing shadcn Button and Input, inside the page's Card. It accepts a view model, search value and callbacks; it owns only expansion and keyboard focus. `model.ts` supplies pure tree-building and search-projection functions. `App.tsx` retains the single host/session inventory, polling, selection and URL synchronization. The view has no API client, additional poller or browser-persisted session data.

## Validation

```sh
npm run build
npm run typecheck
npm test
git diff --check
```

Shared chat-model tests protect completion, identity, source-order, privacy and history cursor behavior. Tree-model tests protect scoped lineage, retained orphan/cyclic nodes and search ancestor paths. Manually inspect desktop and narrow viewports, tree keyboard navigation, expansion across polls, search/clear, selected-child restoration, empty and disconnected states, login/logout, skip navigation, session selection, refresh, human Allow/Deny, message sending and interruption. Check errors and disabled controls during disconnects. Automated checks with synthetic data do not establish native Codex or two-machine acceptance; keep actual local screenshots and traces in ignored output directories.

The shared `ui` package supplies ChatView, shadcn primitives, theme tokens and conversation projection. `Chat.tsx` supplies Dewbow reads, request IDs, original-input retries and session drafts; `useHistory.ts` owns independent history cursors. Browser transport failures remain visible even before Dewbow has returned a request record. A message retry after refresh asks for the exact original text and preserves its operation, turn and mode. Build it before the Web workspace on a clean checkout. See [Shared chat UI](chat-ui.md) for package entry points and the controlled chat interface.
