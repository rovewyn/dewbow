# Dewbow Core operator Web interface

`@dewbow/core-web` uses React, TypeScript, Vite, Tailwind and shadcn/ui with Base UI primitives. It is a browser client of the authenticated Control Plane. It imports only shared record types, never server implementations or the SDK. All assets are local.

## Workflow

Sign in with the separate operator password. A protected cookie authenticates requests; no agent, daemon, or native Codex credential is stored in browser storage. The session navigator groups conversations under permitted hosts and displays the native parent/child hierarchy. Hosts show connection state; session rows show titles and scoped runtime or connection status. Hovering a row exposes its full title, IDs, working directory and management metadata. The selected-session summary shows the host and the confirmed connection status and runtime observation. Archived conversations and managed sessions still being created or recovered remain visible. Select a native-only conversation and click Connect conversation. After connection is confirmed, the composer sends follow-ups in the same native conversation. A writer conflict appears in the operation status; release the conversation in its original runtime, then retry connection.

Hosts initially expand and session branches initially collapse. Restoring or selecting a session reveals its ancestor path once. Polling preserves user expansion choices; collapsing the selected branch does not close its conversation. Expansion lasts for the current page mount. Search matches names, directories and management/native IDs. Results contain only matches and their ancestors, and result paths expand automatically. Search expansion is separate from normal expansion, so clearing search restores the earlier tree state. Searching does not change selection or the conversation panel. Matching counts exclude ancestor-only rows.

Use Up/Down and Home/End to move through visible tree items, Right to expand or enter a branch, Left to collapse or move to its parent, and Enter/Space to select a session or toggle a host. The tree has one tab stop. Expand buttons and session titles are separate pointer targets. Titles truncate on narrow screens; states and keyboard focus remain visible. Escape in search clears the query.

Selecting a session keeps the conversation panel's previous height while its replacement loads, then releases that minimum height when the new content arrives. The loading panel exposes no actions from the previous session. Pointer selection and expansion focus the tree item without scrolling the page or tree; keyboard navigation can still scroll the focused item into view. Conversation history follows new entries within its own scroll area.

Lineage resolves native parent IDs within the same host and Codex home. Fork origins are supplementary metadata and do not create parent links. Missing, ambiguous or cyclic parent relationships remain visible under the host with a warning. Host and session order follows the received inventory.

Select a session to read native saved messages. Managed sessions also show tool metadata, turn state and pending approvals. Native-only sessions expose no send or interrupt controls. Send creates a new turn in the same conversation. Approval Allow/Deny targets the exact active callback. Interrupt requests stopping; its delivery status and the eventual terminal turn state remain separate. Controls are disabled when the host is unavailable or the target is no longer actionable. Unknown runtime states show their last known observation and reject follow-ups pending recovery.

The optional create form selects a connected host and an existing absolute work directory on that machine. MCP is the primary creation and management entry point; Web uses the same operations. Busy, pending, uncertain and failed requests remain visible. Transport failures offer a retry with the original request ID and input. Delivery details are available in the conversation's request list.

The composer selects Default or Plan for a new turn. During confirmed running/input/approval states it appends an instruction to the exact active turn and displays that turn's fixed mode. Question cards show native options and permitted custom input; approvals retain separate Allow/Deny actions and request IDs. Unsupported callbacks expose an interruption path. Pending bodies remain in page memory through accepted/unknown delivery and can be retried with the original operation and ID. They are released on a definite result or sign-out. Drafts do not survive refresh.

The page polls every 1.5 seconds with one serialized polling loop. The initial native page contains the latest 50 items; Load older history fetches preceding items and preserves the conversation scroll position. History, native updates and daemon event cursors remain independent. Update polling observes changes to existing IDs, and advances only after committing the returned batch. Completed native messages take precedence over partial snapshots and retain reliable source order. History unavailable errors remain visible and event cursors do not advance on failure. A selected session ID is in the URL fragment, so refresh restores the same conversation when the host is available. Closing the browser releases polling requests without interrupting daemon execution. Poll timers and fetches are cancelled on teardown or selection change. Rich activity metadata and private content reads are available in the API; the shared chat view will provide their expanded presentation.

## Build and local use

From the repository root:

```sh
npm ci
npm run build
npm run core:control-plane
```

Configure the Control Plane and daemon using their guides. The built Web is served at the Control Plane origin, normally `http://127.0.0.1:3000`. It requires no separate Web service or browser-visible environment secrets. Same-origin service hosting is the reproducible local deployment path.

For UI development against the default local Control Plane:

```sh
npm run core:web
```

Vite binds to `http://127.0.0.1:5173`. Its development-only `/api` and `/auth` proxies target `http://127.0.0.1:3000` and forward that service's Host and Origin. These proxies are not included in production assets. `npm run core:web -- --port 5174` selects another free development port. Production service origin checks remain unchanged.

`npm run core:web:preview` serves static assets alone at `http://127.0.0.1:4173`; it has no management proxy and is only useful for static inspection. Use the Control Plane for full integration. Stop development/preview with Ctrl+C. The built service is stopped through the Control Plane command.

## UI foundation

`components.json` records shadcn CLI 4.21.4's `base-nova` style. Existing component source stays under `src/components/ui/`, with the shared class utility in `src/lib/utils.ts` and theme tokens in `src/ui.css`. Button, Input, Textarea, NativeSelect, Badge, Card and Alert are generated from the official shadcn registry with CLI 4.21.4. The select uses Lucide for its local chevron. Application CSS handles layout and state colors; component source handles controls and focus styles. The application needs no external font, theme switcher, desktop wrapper, or new routing library.

`src/components/session-tree/SessionTreeView.tsx` is an independent view built with the existing shadcn Button and Input, inside the page's Card. It accepts a view model, search value and callbacks; it owns only expansion and keyboard focus. `model.ts` supplies pure tree-building and search-projection functions. `App.tsx` retains the single host/session inventory, polling, selection and URL synchronization. The view has no API client, additional poller or browser-persisted session data.

## Validation

```sh
npm run build
npm run typecheck
npm test
git diff --check
```

The small history-projection test protects streamed/completed reply deduplication while preserving tool activity and visible history gaps. Tree-model tests protect scoped lineage, retained orphan/cyclic nodes and search ancestor paths. Manually inspect desktop and narrow viewports, tree keyboard navigation, expansion across polls, search/clear, selected-child restoration, empty and disconnected states, login/logout, skip navigation, session selection, refresh, human Allow/Deny, message sending and interruption. Check errors and disabled controls during disconnects. Automated checks with synthetic data do not establish native Codex or two-machine acceptance; keep actual local screenshots and traces in ignored output directories.

The shared `core-ui` package supplies shadcn primitives, theme tokens and native message merging. Build it before the Web workspace on a clean checkout. See [Shared chat UI](chat-ui.md) for package entry points and the controlled chat interface.
