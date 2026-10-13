# Agent chat channels

Channels is a Dewbow Team feature. A chatbot selects an agent definition and a default host/workspace profile. A DingTalk connection exposes that chatbot to people. Core continues to own the actual session, native execution, history, recovery and approval authority.

## Configure host workspaces

Copy `docs/examples/host-workspaces.example.json` to a private host configuration file and replace the synthetic paths. Set `DEWBOW_HOST_WORKSPACE_CONFIG` to that file in the daemon environment. Profiles are host-owned; Team receives their IDs, names and kinds, not their source repository paths.

`emptyDirectory` creates a separate directory. `gitWorktree` creates a separate checkout and branch from the configured local repository and base ref. The workspace root must be outside the source working tree. The daemon does not fetch, run setup hooks, initialize submodules, copy uncommitted source changes or reset the source repository. Configure a repository and base ref that already exist locally.

Core assigns the session ID before provisioning. The directory is `<workspaceRoot>/<sessionId>` and the Git branch is `dewbow/session-<sessionId>`. The daemon records the resolved source commit, branch and path before creating resources, and synchronizes preparation and completion state. Repeated requests retain those resources. Reconnection and daemon recovery verify the saved directory identity, path and Git ownership; missing, replaced or inconsistent resources require local repair, without replacing the native conversation.

Managed workspaces do not inherit additional writable roots or shared temporary-directory write exemptions. The host still owns network and approval policy. Separate worktrees share Git metadata; writes to that metadata can require Core approval. This provides working-directory isolation and native sandbox enforcement, not separate operating-system users, containers, filesystem read isolation, ports or credentials. Files and branches remain after turns and `/new`; no automatic cleanup is provided.

## Configure DingTalk

Use an enterprise internal application robot in Stream mode. Configure its application visibility in DingTalk separately. Run only one message consumer for that application: stop a reference echo process before switching the application to Channels. No public HTTP receiving endpoint is needed.

Copy `docs/examples/channel-credentials.example.json` to a private file. Supply `credentialRef`, `clientId`, `clientSecret`, `robotCode` and the permitted `corpId`. Set `DEWBOW_TEAM_CHANNEL_CREDENTIALS` to the file in the Team environment. Keep it in ignored private state with appropriate account permissions. Placeholder values fail configuration validation. Secrets are never returned by Team APIs or logged. An existing reference cannot silently change to another application or organization; use a new connection for another account.

Enable the application's robot single-chat message sending permission and use its staff user IDs for OpenAPI replies. Channels replies through a valid session webhook, and uses the same application's single-chat OpenAPI after the webhook expires. Token acquisition is bounded and cached. An uncertain webhook result does not trigger OpenAPI fallback. Platform acceptance is separate from whether a person has read the message.

In Team Web, open **Channels**, create a chatbot, choose its definition, host and isolated workspace profile, and select **Accept new messages**. Connect a configured DingTalk application and enable its connection. Both chatbot and connection must be enabled. All users in the configured organization who can access the application may use it; foreign organization identities and malformed sender IDs are rejected. Only direct text chat is supported. Group callbacks are ignored and unsupported direct message types receive a notice.

The Team backend owns the Stream lifecycle. Disabled connections stop accepting input and close their Stream; outstanding state remains retained. Shutdown cancels transports and polling before closing storage. A database lease prevents two Team processes from simultaneously owning its channel transports and deliveries. A crashed process's lease expires after 30 seconds.

## Sessions and identity

The mapping key is connection, organization ID, staff user ID and definition ID. Nicknames are not identities. The external conversation address is retained for replies. The first ordinary message automatically creates a Core session and freezes the definition revision/configuration. Later messages continue it, connecting the original session when needed. Definition revision edits affect future sessions only. Reassigning a chatbot to a different definition uses a different mapping.

**Sessions → New agent session** creates a Core session directly from a definition without any channel. Member sessions share the same binding service and workspace selection. A permitted channel conversation can be explicitly bound to a Team-managed session of the same definition. It must be idle, connected, have a ready managed workspace and agent-readable context. A session claimed by another external identity cannot be assigned to this one. Old sessions and their files remain available.

Startup and status reads observe Core; they do not create a session or dispatch fresh input. Accepted but unresolved input retains its original operation, request ID and body for an explicit retry. An incoming task can create or connect its session. While Core confirms an active turn, ordinary input steers that exact turn; when idle it starts a new turn. Unknown state blocks additional task submission. `/status` and `/stop` remain available to inspect or interrupt an existing turn.

## Commands and questions

| Input | Behavior |
| --- | --- |
| `/status` | Report the observed connection/execution state, including unknown state; do not create a session. |
| `/stop` | Interrupt the exact observed active turn. Report its terminal state only after Core confirms it. |
| `/new` | When there is no active or unresolved execution, create another isolated session and switch the mapping after readiness. Retain previous files. |
| `/answer <token> <number>` | Answer a current ordinary question with a displayed option number. Multiple choices use comma-separated numbers. |
| `/answer <token> text:<answer>` | Supply a custom answer when the question permits it. |

Question tokens are scoped to the identity, binding, turn, interaction and question and expire after 15 minutes. Multiple-question interactions collect every answer before submitting one structured response. Plain messages are never guessed to be question answers. Core remains the authority on origin, sensitivity and response permissions. Approval, secret and unsupported interactions direct the operator to Core. Operator-only context cannot be continued or exported through Channels.

## Delivery and recovery

Input receipt, command acceptance, native turn completion and reply acceptance have separate records. After durable input receipt, Channels immediately returns the documented robot callback ACK with `code: 200`, `message: "OK"` and the JSON-string payload `{"response":null}`; it does not wait for agent execution or reply delivery. This acknowledges transport receipt and does not guarantee a read marker in the DingTalk client. Stable IDs suppress repeated platform callbacks and associate each input with its original Core operation. Channels observes only turns initiated or steered from that channel. Independent Web-only turns are not automatically forwarded. Final messages are selected by native turn/message identity and completion metadata; tool output is not sent.

Unicode text is split into bounded numbered messages. Outgoing messages are paced per connection. The pending reply body is fixed before sending. A failed reply does not rerun the agent. Unknown results require review in **Pending and failed deliveries**; retrying an uncertain platform reply can duplicate it, since exactly-once delivery is not promised. A restart reconciles original Core operations and resumes confirmed reply delivery. It does not replace an uncertain task with another task. Every content delivery checks Core's current authority again.

Pending input/answer/reply bodies are stored only to recover the original operation. Confirmed bodies are cleared, and unresolved bodies expire after 24 hours. Question answers are cleared after confirmed submission or expire with their tokens. Operation metadata and deduplication IDs remain. Completed history is read from Core, not a second permanent Team message archive. Failed Core/history reads mean unavailable data, not an empty successful conversation. Logs contain status only, never private URLs, credentials, message text or raw platform exceptions.

## API and validation

Team's authenticated `v1` management API adds `createAgentSession`, `listWorkspaceProfiles`, `getChannels`, `createChatbot`, `updateChatbot`, `createChannelConnection`, `updateChannelConnection`, `bindChannelConversation` and `retryChannelDelivery`. `getChannels` omits secrets, reply addresses and retained bodies. It reports whether a failed delivery still has a retryable body.

Binding actions are `connectSessionBinding`, `retrySessionBindingCreation`, `sendBindingMessage`, `steerBindingTurn`, `answerBindingQuestions`, `interruptBindingTurn`, `readBindingHistory`, `getBindingActivity` and `readBindingContent`. They use `bindingId`; creation references belong to the binding rather than the current caller. Old member-action names are removed rather than aliased. The Core credential remains on Team's backend. IM callers cannot invoke Team management operations.

The Team database schema is obsolete after this change. Stop Team before replacing an old database using the documented state-reset procedure; preserve Core state, native conversations, credentials and user results. No migration is implemented. Validate with fresh synthetic databases first. Core contracts remain `v1` and retain the explicit-directory creation option alongside managed workspace profiles.

Run the repository build, typecheck, tests and diff/security checks. Synthetic acceptance covers workspace ownership, dirty-source preservation, duplicate inputs, steering, binding protection, ordinary questions, restricted content, Stream reconnects, uncertain delivery and restart reconciliation. Real acceptance additionally needs a configured application, two participating permitted users and a real daemon: create separate files, run commands, continue after reconnect, exercise controls/questions and verify unapproved writes outside the session do not succeed. Record observations privately; local simulations do not establish deployed or real DingTalk acceptance.

Protocol references: [DingTalk Stream](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/), [robot replies](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/), [single-chat OpenAPI](https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches). The initial transport follows the local DingTalk Echo implementation, with receipt decoupled from execution and reply delivery.
