# Dewbow daemon

The Rust daemon combines the local management service and Codex runtime owner. It is compiled into the `dewbow` executable. The current version manages one local host through Web; remote enrollment, routing, MCP and external agent access are deferred.

## Ownership and interfaces

Codex owns native conversations and saved messages. Dewbow's private journal owns managed session references, frozen creation configuration, turns, request fingerprints, interaction identities and metadata events. A separate private content database retains tool output, diffs and question details. It does not duplicate native user or assistant messages into the management journal.

The existing Web uses same-origin `POST /api/<operation>` with `{result}` or `{error}` envelopes and the `v1` camelCase contracts. Operations include inventory, creation and connection, native history, content reads, sends, steering, questions, approvals and interruption. `GET /api/subscribeSessionUpdates` emits `snapshot`, `update` and `streamError` events. Management-event and native-item cursors remain independent; reconnect with committed positions. `/mcp` and agent bearer authorization are not provided.

All Web calls have operator authority. `dewbow web` authenticates to a separate loopback control endpoint with a credential from private local configuration and issues a 60-second, one-use browser ticket. Web removes the ticket fragment before exchanging it for an HttpOnly, SameSite=Strict cookie. Cookies expire after twelve hours and are revoked by logout or daemon exit. Persistent control credentials never enter browser storage. Host and Origin checks reject other origins; all production listeners bind to `127.0.0.1`.

## Native discovery and execution

Discovery combines native app-server metadata, read-only native databases, rollout metadata headers and read-only CLI inspection. Unix process/socket discovery and macOS writer-lock observations are retained where available. Unavailable providers report their state; a missing observation never proves another runtime is idle. Files must be owned by the current account and private paths reject links and Windows reparse points. Version-sensitive native database access is isolated in the Rust SDK.

The owned runtime excludes the launching Desktop conversation's executor and thread context. Native credentials and ordinary user configuration remain local to Codex. On Windows it uses the documented `features.prefer_mxc=true` preference, honoring native managed requirements and the native legacy fallback. This does not edit the user's Codex configuration. Devices without MXC still need a functioning permitted legacy sandbox; Dewbow does not disable sandbox boundaries or provision OS accounts automatically.

Reading inventory and history does not resume threads or start turns. Connect explicitly to continue an existing native ID. A writer conflict never causes Dewbow to stop another runtime. Managed creation freezes the selected model, effort, developer instructions and host-owned sandbox/approval policy. Session-specific arbitrary native configuration is not accepted.

One conversation permits one active or unresolved turn. Management operations and native notifications serialize state updates for that conversation, so a fast completion cannot be overwritten by a start response. Separate conversations can run independently. Default and Plan modes use the confirmed native model. Steering, interruption and interaction responses target exact native thread/turn/callback identities. Approval uses only the advertised single-request decision; no session policy amendment is applied. Unsupported callbacks remain visible with an interruption path.

Request IDs are durable and scoped to this daemon. Repeating the same operation and input returns the original operation; different input with the same ID fails. Message bodies remain native or volatile; only their fingerprints are journaled. Delivery and native completion are separate. On restart, recorded conversations resume by ID and completed native turns reconcile; unresolved delivery stays unknown and blocks another send. Old callbacks are invalidated because they belong to a terminated runtime. A native thread created before its ID was saved, or an empty thread that cannot resume, requires explicit recovery; Dewbow does not create a replacement silently.

Tool deltas are appended as private database chunks. Content reads return bounded UTF-8 byte ranges, with conversation-scoped content IDs and cursors. Captured terminal output takes precedence over an incomplete native aggregate. Native history pages and in-place item updates retain reliable ordering; raw reasoning is excluded.

## State and operations

Private configuration, process records, journal/content databases and their WAL/SHM files belong to the selected state directory. POSIX directories use mode 0700; Windows uses a protected ACL granting the current account and SYSTEM access, while preserving the directory owner. Privileged OS administrators remain outside this isolation boundary.

Back up state while stopped. Existing TypeScript management databases are not imported, reset or migrated. Native credentials, conversations, working files and unrelated local results are preserved. See [CLI operations](cli.md) for setup and recovery.
