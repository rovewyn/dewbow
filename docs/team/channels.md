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

Final answers within the text-body budget are sent as one message. Longer Unicode text is split into bounded numbered messages, preferring paragraph, line, sentence and word boundaries in that order. Original text and whitespace are preserved; a passage without a suitable break inside the size limit is split at a Unicode code-point boundary. Outgoing messages are paced per connection. The pending reply body is fixed before sending. A failed reply does not rerun the agent. Unknown results require review in **Pending and failed deliveries**; retrying an uncertain platform reply can duplicate it, since exactly-once delivery is not promised. A restart reconciles original Core operations and resumes confirmed reply delivery. It does not replace an uncertain task with another task. Every content delivery checks Core's current authority again.

### Text limit, accounting and safety margin

DingTalk reports a **20,000-byte native message-body ceiling** when rejecting oversized text. Dewbow uses a **19,000-byte UTF-8 budget for the complete serialized native text body**, leaving 1,000 bytes (5%) below that reported ceiling. The budget includes the JSON envelope, JSON escaping and any `[index/total]` prefix. It is neither a 19,000-character limit nor a limit on the bare reply text. The earlier 1,500-byte bare-text split threshold is removed.

The accounting rule used by `getTextMessageBodyBytes` is:

```js
const getTextMessageBodyBytes = text => Buffer.byteLength(
  JSON.stringify({ msgtype: "text", text: { content: text } }),
  "utf8",
);
```

The empty compact envelope costs 40 bytes. JSON quotes, backslashes and control characters add escaping overhead; most CJK characters use three UTF-8 bytes and supplementary emoji use four. Numbered parts reserve the escaped prefix before choosing a boundary. Every final part, including its prefix, must fit the 19,000-byte serialized-body budget. Replies already within budget have no part prefix and remain intact.

For session webhooks this is the actual compact HTTP JSON body. For single-chat OpenAPI, the request still uses `msgKey: "sampleText"` and `msgParam: JSON.stringify({ content: text })`. Apply the same native text-body budget to its content. The outer OpenAPI wrapper contains the robot and recipient identifiers and another layer of JSON escaping; its HTTP byte length is a different quantity. An accepted quote-heavy OpenAPI probe had an outer request larger than 20,000 UTF-8 bytes while its equivalent native text body was exactly 20,000 bytes.

### Measured boundaries and scope

The following real integration observations were made on **2026-10-13**, with one enterprise internal application robot and one permitted single-chat recipient. Both the session webhook and `oToMessages/batchSend` produced the same results. These observations describe the tested application and text format; they are not a published, permanent DingTalk contract.

| Synthetic content | Accepted case | Rejected case |
| --- | --- | --- |
| ASCII with two newline markers | 19,958 text characters; 20,000 serialized native-body UTF-8 bytes | 19,959 text characters; 20,001 serialized native-body UTF-8 bytes |
| Supplementary emoji with ASCII markers | 20,000 serialized native-body UTF-8 bytes | 20,001 serialized native-body UTF-8 bytes |
| JSON-escaped quotes with ASCII markers | 20,000 serialized native-body UTF-8 bytes | 20,001 serialized native-body UTF-8 bytes |
| Repeated CJK text with ASCII markers | 10,000 text code points; 29,958 serialized native-body UTF-8 bytes | 10,001 text code points; 29,961 serialized native-body UTF-8 bytes |

The CJK difference is significant: the service accepted a 20,001-byte UTF-8 CJK body, so a strict 20,000-byte UTF-8 ceiling does not explain every observed platform boundary. The provider's internal encoding/counting implementation is unspecified. Dewbow defines its own conservative UTF-8 budget explicitly; all tested content classes accepted the 20,000-byte baseline, and production leaves the additional 5% margin. Do not infer a universal plain-character maximum or a provider encoding from the error wording alone.

Webhook size rejections returned `errcode: 460101` with `message too long, exceed 20000 bytes`. OpenAPI returned `invalidParameter.msgParam.tooLong` and an instruction to keep the body within `20000bytes`; substantially oversized parameters could also return `InvalidmsgParam`. A generic parameter error is not sufficient by itself to establish a size limit.

Platform acceptance and client display were verified separately. The recipient expanded and confirmed the matching `_END` markers for successful maximum ASCII, emoji and CJK probes on both transports. This establishes end-to-end visibility for those synthetic probes. It does not establish exactly-once delivery, read status or limits for other templates, cards, group robots or working-notification APIs.

### Repeat the length verification

1. Use a permitted test recipient and the same application, organization and staff-user mapping. Load credentials and the session webhook from private configuration. Verify the channel is idle and has no unresolved delivery. Keep existing Core sessions, workspaces and native state.
2. Send synthetic probes directly through the production `DingTalkSender`, without calling `sendMessage` or creating an agent turn. Use a valid webhook for one route and force the existing OpenAPI route by treating the webhook as expired for the other. Keep the real webhook intact.
3. Put a unique, non-sensitive `BEGIN` marker at the beginning and the matching `END` marker at the end. Record code-point count, UTF-16 length, raw UTF-8 length, serialized native-body UTF-8 length, and outer HTTP JSON length as separate quantities. Store only sanitized response metadata and counts in ignored private outputs.
4. Start with known accepted and rejected sizes, then narrow the boundary with paced binary probes. Use at least 3.3 seconds between attempts and only one probe process. Stop on an uncertain result, invalid recipient, permission failure or rate limit. Do not turn an uncertain webhook send into an OpenAPI fallback or repeat an accepted probe accidentally.
5. Confirm adjacent accepted/rejected cases for ASCII, emoji and JSON-escaped text. Test CJK separately rather than extrapolating from ASCII. A compact fixture for an exact native-body UTF-8 size is shown below; it does not send messages.
6. Check both HTTP status and the platform result. Webhook acceptance requires `errcode: 0`. OpenAPI acceptance requires a returned query identifier and no invalid or flow-controlled recipient. Then ask the recipient to expand the successful messages and check their `END` markers. Report client observations outside the bot chat so they do not start another agent turn.
7. Recheck that Core session IDs, native conversation IDs, workspace files and execution counts are unchanged. Adjust the production budget only after acceptance and client visibility are established, retaining a documented margin. Revalidate after relevant platform, template or serialization changes.

```js
const nativeBodyBytes = text => Buffer.byteLength(
  JSON.stringify({ msgtype: "text", text: { content: text } }), "utf8",
);
function makeByteProbe(targetBytes, character, marker) {
  const begin = `${marker}_BEGIN\n`, end = `\n${marker}_END`;
  const remaining = targetBytes - nativeBodyBytes(begin + end);
  const characterBytes = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
  if (remaining < 0 || !characterBytes) throw new Error("Invalid probe size.");
  const count = Math.floor(remaining / characterBytes);
  return begin + character.repeat(count)
    + "a".repeat(remaining - count * characterBytes) + end;
}
// Run both sides of the boundary with "a", "🙂" and '"'; test CJK separately.
const acceptedCandidate = makeByteProbe(20000, "a", "SYNTHETIC_BOUNDARY");
const rejectedCandidate = makeByteProbe(20001, "a", "SYNTHETIC_BOUNDARY_OVER");
```

Pending input/answer/reply bodies are stored only to recover the original operation. Confirmed bodies are cleared, and unresolved bodies expire after 24 hours. Question answers are cleared after confirmed submission or expire with their tokens. Operation metadata and deduplication IDs remain. Completed history is read from Core, not a second permanent Team message archive. Failed Core/history reads mean unavailable data, not an empty successful conversation. Logs contain status only, never private URLs, credentials, message text or raw platform exceptions.

## API and validation

Team's authenticated `v1` management API adds `createAgentSession`, `listWorkspaceProfiles`, `getChannels`, `createChatbot`, `updateChatbot`, `createChannelConnection`, `updateChannelConnection`, `bindChannelConversation` and `retryChannelDelivery`. `getChannels` omits secrets, reply addresses and retained bodies. It reports whether a failed delivery still has a retryable body.

Binding actions are `connectSessionBinding`, `retrySessionBindingCreation`, `sendBindingMessage`, `steerBindingTurn`, `answerBindingQuestions`, `interruptBindingTurn`, `readBindingHistory`, `getBindingActivity` and `readBindingContent`. They use `bindingId`; creation references belong to the binding rather than the current caller. Old member-action names are removed rather than aliased. The Core credential remains on Team's backend. IM callers cannot invoke Team management operations.

The Team database schema is obsolete after this change. Stop Team before replacing an old database using the documented state-reset procedure; preserve Core state, native conversations, credentials and user results. No migration is implemented. Validate with fresh synthetic databases first. Core contracts remain `v1` and retain the explicit-directory creation option alongside managed workspace profiles.

Run the repository build, typecheck, tests and diff/security checks. Synthetic acceptance covers workspace ownership, dirty-source preservation, duplicate inputs, steering, binding protection, ordinary questions, restricted content, Stream reconnects, uncertain delivery and restart reconciliation. Real acceptance additionally needs a configured application, two participating permitted users and a real daemon: create separate files, run commands, continue after reconnect, exercise controls/questions and verify unapproved writes outside the session do not succeed. Record observations privately; local simulations do not establish deployed or real DingTalk acceptance.

Protocol references: [DingTalk Stream](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/), [robot replies](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/), [single-chat OpenAPI](https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches). The initial transport follows the local DingTalk Echo implementation, with receipt decoupled from execution and reply delivery.
