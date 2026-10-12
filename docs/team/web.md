# Dewbow Team operator Web interface

Build the workspace and start the Team backend as described in [Workspace development](workspace.md). The backend serves the built Web interface and API from the same origin. Sign in with `DEWBOW_TEAM_OPERATOR_TOKEN`. The token is used for authentication; browser persistence contains an HttpOnly session cookie, not the token. The Core credential stays on the backend.

## Definitions and teams

The Definitions page includes the read-only built-in Default Codex definition. Create a custom definition to override `model`, `reasoningEffort`, or `instructionsAppend`. Empty fields inherit the host baseline. Custom edits use the displayed revision; a conflict requires reloading the current definition. Referenced definitions cannot be deleted.

Create a team, add members, and select a definition for each member. An empty selection uses Default Codex. Changes affect new sessions. Archive a team or member to prevent new sessions while retaining its existing bindings and history.

## Sessions

Choose New session on a member, select a connected Core host, and enter an absolute working directory on that host. This starts a new native conversation. Open an existing session to return to earlier work. Session configuration shows both the frozen requested overrides and Core's resolved snapshot. Definition edits do not change existing sessions.

Opening a session polls binding details and history without connecting it. Connection state and runtime state appear separately. Select Connect session explicitly to resume the original Core session. Interruption targets the observed active turn. Approval decisions remain in Core; the interface provides a link to Core when a turn needs approval.

The conversation combines saved native messages and current streamed messages by native message ID, source version and completion state. The initial page contains the latest 50 native items; Load older history preserves the conversation scroll position. Native update polling observes both new items and changes to existing IDs, without replacing its watermark on older-page reads. Host-event cursors remain independent and monotonic, so a delayed page cannot replace newer streamed content. Failed reads retain saved history and label Core state unknown. A cached configuration is marked as the last observed snapshot. The shared chat view will expand the activity and private-content metadata already available through Team's binding APIs.

## Uncertain requests

Mutation retries reuse the original request ID and payload. Definition and team forms freeze after an uncertain result and provide Retry same request. The Requests tab distinguishes command delivery from turn completion and exposes unresolved session requests.

An unresolved send blocks a new send until its outcome is known. While the page remains open, original text is kept only in component memory for an exact retry. After leaving the page or refreshing it, restore an unresolved message and enter its exact original text. The backend checks the request fingerprint and rejects changed text. It does not copy message bodies into its request journal or browser storage.

When Core is unavailable, definition and team management remain available. A session preserves its binding and displayed history, shows unknown connection/runtime state, and disables actions that require an observed Core session. Refreshing the workspace reloads Team metadata. Signing out invalidates the operator cookie.

## Development and validation

`npm run team:web` starts the Vite development server on port 5174 with the documented API proxy. Use the Team backend on port 3100 for a production-build preview; this exercises its authentication, static-file handling, and content security policy together. `npm run team:web:preview` serves static assets only and does not provide the Team API.

The Web interface supports desktop and narrow mobile viewports, labeled native forms, keyboard focus indicators, modal dialogs, and separate conversation/configuration/request views. Automated history tests protect independent cursors, retained final-page polling, message deduplication, terminal-message precedence, and failed-read preservation. Validate mutations and connection recovery with synthetic local data before using real hosts.
