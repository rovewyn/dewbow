# Dewbow Core SDK guide

`@dewbow/core-sdk` is a TypeScript SDK for local Codex session discovery, saved history, and conversation execution in Node.js. Its source, tests, and examples are in `packages/core-sdk/`. A session is a saved conversation. It is distinct from a Codex process or an agent.

The SDK returns session metadata, archive state, parent and fork relationships, runtime observations, and writer lock observations. Each discovery source has an explicit outcome. Missing information stays unknown. A separate history API reads saved chat messages for one session.

## Setup and local demo

Requires Node.js 24.15 or newer. Development uses Node.js 24.21.0, npm 12.2.0, and the committed lockfile. See [Workspace development](workspace.md#development) for version setup. Local storage and owned stdio execution support Windows, macOS, and Linux. External process discovery supports macOS and Linux; writer lock inspection supports only 64-bit macOS. Windows external runtimes, Unix sockets, and writer locks remain unavailable or unknown. Missing observations never establish that a conversation is idle.

```sh
npm ci
npm run build --workspace @dewbow/core-sdk
npm run core:demo
```

The demo prints summary counts and source outcomes. It starts no HTTP server. The SDK does not require Python. `node:sqlite` reads the database; Koffi supplies native macOS lock queries and Windows file owner SID checks. POSIX files must belong to the current UID. Windows files must belong to the current account and be ordinary files; an elevated token's default Administrators owner is also accepted. Other group owners are rejected. Lineage paths cannot escape their selected home through junctions or links.

This package is currently private and unpublished. To use it in another local project:

```sh
npm pack --workspace @dewbow/core-sdk --pack-destination /path/to/packages
# In the consuming project:
npm install /path/to/packages/dewbow-core-sdk-0.1.0.tgz
```

Packing builds the SDK and includes compiled JavaScript, TypeScript declarations, and the package README. Repository documentation remains in the root `docs/` directory. The tarball excludes the host daemon, tests, examples, and local Codex data. Consumers import `@dewbow/core-sdk`.

## API

```ts
import { discoverSessions, getParentSession, getForkSourceSession } from "@dewbow/core-sdk";

const snapshot = await discoverSessions();
for (const session of snapshot.sessions) {
  console.log(session.name, session.archived, session.hasActiveWriter);
  const parent = getParentSession(snapshot, session);
  const forkSource = getForkSourceSession(snapshot, session);
  // parent and forkSource are separate relationships. Either can be null.
}
```

`discoverSessions()` returns a one-shot `DiscoverySnapshot` containing:

- `sessions`: typed `CodexSession` metadata and observations.
- `processes`: OS process and socket observations.
- `runtimes`: endpoint connection results and associated process IDs.
- `sources`: `success`, `partial`, `unavailable`, `error`, or `disabled` reports.
- `warnings`: generic failure descriptions without raw command or RPC diagnostics.
- `summary`: counts with `null` when the source cannot establish a result.

Session identity consists of `codexHome` and `id`. Duplicate UUIDs in different homes remain distinct. Relationship helpers resolve within the same home and return `null` when the related session is absent. `name` uses saved metadata when available and a UUID placeholder otherwise. `sources` and `fieldSources` identify the observations used for each session and field. Creation and update timestamps use Unix seconds; observation timestamps use ISO strings.

Summary counts describe observed records. They can cover only part of the inventory when sources fail or individual fields remain unknown. Check source reports and per-session values before treating them as totals.

```ts
const snapshot = await discoverSessions({
  codexHome: "/path/to/codex-home",
  additionalHomes: ["/path/to/another-home"],
  sources: ["database", "lineage", "writers"],
  limits: { maxSessions: 10000, sourceBudgetMs: 5000 },
  signal: AbortSignal.timeout(15000),
});
```

All sources are enabled by default. `sources: []` disables discovery. `codexHome` defaults to `CODEX_HOME`, then `~/.codex`. Additional homes must be supplied explicitly. Successful APIs can report another home. The SDK does not search the entire disk or infer homes from private process arguments.

`codexExecutable` selects the CLI executable; the default is `codex` on `PATH`. Node entry points run through the current Node executable, allowing direct synthetic app-server fixtures on all platforms. For Windows native execution, select the actual `codex.exe`: the official npm `codex.js` wrapper is rejected because killing its Node process does not verify native child exit. Do not use a `.cmd` shim. Processes use no shell and hide Windows console windows. Owned runtime shutdown waits for process exit with a five-second deadline and kills only its own child. `sockets` selects existing Unix WebSocket endpoints. Without explicit endpoints, process discovery selects a runtime's sole named Unix socket. Missing or ambiguous endpoints are reported unavailable. Explicit endpoints work without process discovery; their PID association then remains unknown. No daemon is started.

The default limits are 50,000 distinct sessions, 30 seconds per command, and 3 seconds per database iteration, lineage scan, or writer query pass. Their maximum configurable values are 50,000, 30,000 ms, and 20,000 ms. CLI output and API messages are bounded to 8 MiB; lineage headers to 64 KiB. API snapshots have a separate 20-second budget, a 3-second idle timeout, and a 200-page limit per list. These limits are independent, not a whole-call deadline. Use an `AbortSignal` for cancellation. SQLite queries are synchronous, so cancellation is checked between bounded queries and rows rather than during an executing SQLite statement. Open-file PID lookup has its own bounded command time.

Invalid options, combined inventory overflow, and cancellation reject the promise. Provider failures normally return source reports while other enabled providers continue their scheduled work. A failed API does not trigger a retry through another method. Local providers run because they were enabled, regardless of API success or failure. A failed inventory provider discards its incomplete results. Lineage and writer providers can report partial observations.

## Read a session's chat history

```ts
import { readSessionHistory } from "@dewbow/core-sdk";

const sessionId = "00000000-0000-4000-8000-000000000001";
let cursor: string | undefined;
do {
  const page = await readSessionHistory(sessionId, {
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  for (const message of page.messages) {
    console.log(message.role, message.text);
  }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

`readSessionHistory(sessionId, options)` reads only the requested session from the highest-version `thread_history_N.sqlite` in `codexHome`. The home defaults to `CODEX_HOME`, then `~/.codex`. It uses a read-only SQLite transaction and includes WAL data. It does not connect to an app-server, launch Codex, resume a session, or fall back to rollout files or older databases.

The returned `SessionHistoryPage` contains `sessionId`, `codexHome`, `source: "database"`, `observedAt`, `messages`, and `nextCursor`. Messages include user input and assistant replies, including commentary and final answers. Tool calls, command output, reasoning records, and compaction events are excluded.

Each `SessionMessage` has `id`, `turnId`, `role`, `text`, `content`, `phase`, `createdAtMs`, and `turnStatus`. `text` joins saved text parts with a newline, without trimming or truncating them. `content` preserves original user input parts, including text annotations and attachment references; assistant text is represented as one text part. Referenced files and images are not opened. `createdAtMs` is a Unix timestamp in milliseconds. `turnStatus` is the saved status, such as `completed`, `inProgress`, or `interrupted`; it can be `null` when the turn record is absent. It does not establish current writer activity.

Options are `codexHome`, `limit` (default 100, maximum 1,000), `cursor`, `sortDirection` (`asc` by default, or `desc` for newest first), and `signal`. Ordering uses the saved rollout ordinal. A cursor is valid only for the same home, session, and direction. `nextCursor: null` means no further matching messages were present in that page's database snapshot. Pages read at different times are separate snapshots; active sessions can add or update messages between calls.

Pages are limited to 8 MiB of saved message JSON. Oversized or malformed pages reject without returning partial content. Invalid options or cursors reject with `TypeError` or `RangeError`; cancellation rejects with `AbortError`. Storage failures reject with `SessionHistoryError` and one of these codes:

| Code | Meaning |
| --- | --- |
| `UNAVAILABLE` | No history database, or an unsupported file such as a symlink |
| `SESSION_NOT_FOUND` | The session is absent from this history store |
| `UNSUPPORTED_SCHEMA` | Required history tables or columns are missing |
| `INVALID_HISTORY` | A saved chat message is malformed or inconsistent |
| `LIMIT_EXCEEDED` | Saved message JSON exceeds the page size limit |
| `READ_FAILED` | SQLite could not open or read the selected database |

An indexed session with no chat messages returns an empty page. An absent session rejects; it is not presented as an empty conversation. This API returns what the selected history database has persisted. It does not claim to reconstruct missing, deleted, or unindexed history.

After building, run `node packages/core-sdk/examples/history.mjs <session-id> [limit] [asc|desc]` from the repository root, or `npm run core:demo:history -- <session-id> 20 desc`. This command explicitly prints conversation content. Keep its output local and out of commits or shared logs. Discovery remains metadata-only.

## Connect and continue an existing conversation

```ts
import { CodexRuntime } from "@dewbow/core-sdk";

const runtime = new CodexRuntime();
const completed = new Promise<void>(resolve => {
  runtime.onMessage = message => {
    if (message.method === "turn/completed" && message.params?.threadId === sessionId) resolve();
    // Route approval callbacks to the operator and reply with runtime.respond().
  };
});
try {
  await runtime.start("codex"); // Optional second argument selects CODEX_HOME.
  await runtime.connectSession(sessionId, {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  const { turn } = await runtime.sendMessage(sessionId, "Continue the previous task.");
  // turn.id identifies acceptance. Wait for the terminal notification.
  await completed;
} finally {
  await runtime.stop();
}
```

`CodexRuntime` starts an owned `codex app-server --listen stdio://` process. `connectSession(id, options)` calls `thread/resume` with that exact saved ID. It creates no fork and starts no model turn. Native Codex loads its saved context and obtains its writer lock. If another runtime holds the lock, the SDK reports `SESSION_IN_USE`; release the conversation in that runtime before retrying. Connecting does not interrupt or stop another process.

The connection result contains the native `thread.id`, `cwd`, runtime status, and turns, plus top-level `cwd` for the effective configuration. Turns are excluded by default; set `excludeTurns: false` when needed for recovery. Optional native overrides are `cwd`, `model`, `modelProvider`, `developerInstructions`, `config`, `approvalPolicy`, `approvalsReviewer`, and `sandbox`. `developerInstructions` sets the complete additional developer instruction value; it does not implement append semantics. `config` uses native Codex configuration keys, such as `model_reasoning_effort`. These low-level SDK parameters are separate from Dewbow's restricted management `sessionOptions`; the host daemon composes and freezes the management overrides. Omitted settings use Codex's saved or configured defaults. `sendMessage` calls `turn/start` on the same ID. `request` exposes other installed app-server operations, including `turn/interrupt`. Match those parameters to the installed Codex bindings. `respond` replies to a native callback; `reject` rejects unsupported callbacks. Callers must handle approvals and notifications through `onMessage`. The daemon supplies that handling for Web/API/MCP clients.

`CodexRuntimeError.code` is `SESSION_IN_USE`, `EXECUTION_FAILED`, or `DELIVERY_UNCERTAIN`. Native diagnostics are replaced with generic messages. A timed-out or closed request can already have taken effect; reconcile it before sending again. RPC requests have a 15-second timeout. `onSpawn` reports the owned PID and `onExit` reports closure. `stop` waits for that process to exit, with a five-second termination deadline. No other process is killed. Conversation content remains in native Codex storage; this SDK adds no message database. The integration uses the protocol generated by Codex CLI 0.162.1.

## Sources and information boundaries

| Source | Provides | Operation |
| --- | --- | --- |
| `database` | Saved titles/names, model, workspace, archive state, parent edges, token counts where available | Read-only `state_N.sqlite`, highest version only; supports WAL |
| `app-server` | Public thread metadata, loaded sessions, runtime status and flags, supported relationships | `initialize`, `thread/list`, `thread/loaded/list`, `thread/read` with `includeTurns: false` |
| `cli` | Additional session IDs and storage inspection states | `codex migrate-rollouts --json`, without `--apply` |
| `lineage` | Parent and fork origin IDs missing from other metadata | First `session_meta` record in local rollout files |
| `writers` | Whether a lock is held, kernel owner when available, independent open-file PID observations | macOS `F_GETLK` and `lsof` |
| `processes` | Current user's Codex PIDs, process roles, named Unix sockets | `ps` and `lsof` |

Metadata prefers successful public API observations, then saved database metadata; lineage fills missing relationship IDs. CLI states and runtime observations are retained separately. These observations are taken at different times and do not form an atomic snapshot across providers.

Discovery and history reads do not start model turns, resume sessions, acquire writer locks, migrate storage, or subscribe to notifications. Execution requires an explicit `CodexRuntime` call. API lists use `useStateDbOnly: true`; loaded threads are read without turns. Discovery database queries select bounded, allowlisted columns. Discovery excludes prompt content, rollout paths, previews, policy blobs, and arbitrary source JSON. Chat content is returned only by the explicit history API. Lineage reads stop at the first newline and extract only validated UUID relationships; later records are not parsed or retained. Files must be regular files owned by the current user; database files, lineage files, and lock files reject symlinks. Local results can contain private conversation text, titles, attachment references, workspace paths, IDs, and socket paths. Review results before sharing them.

`archived` and `hasActiveWriter` use `true`, `false`, or `null`. `null` means unknown. `runtimeStatus` can be `unknown`, `notLoaded`, `idle`, `active`, or `systemError`. A held writer lock does not establish that a model turn is active. Runtime observations apply only to the queried endpoints; they do not establish activity across every Desktop process.

`pids` identifies successfully queried runtimes that report the session loaded and have an OS socket ownership association. `writerPid` is a confirmed kernel owner only. macOS may report a held `flock` lock without an owner PID; in that case it remains `null`. `writerOpenPids` lists processes with the file open and does not establish ownership, even when only one PID is present. An empty array means the open-file lookup found none; `null` means the lookup was unavailable. No PID is inferred from session timestamps or lock-file existence.

Local database schema, rollout headers, writer locks, and the CLI inspection format are implementation details and can change with Codex versions. The CLI inspection mode was verified with Codex CLI 0.162.1. See the [public app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Node.js SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

## Validation

```sh
npm run typecheck
npm test
npm pack --workspace @dewbow/core-sdk --dry-run
git diff --check
```

The small test suite covers only critical behavior: read-only WAL access, metadata filtering, history isolation and pagination, failure semantics, bounded lineage reads, inspection-only CLI calls, public API reads and cancellation, and macOS writer lock ownership distinctions. Tests use synthetic temporary data and do not modify real Codex storage. Follow the [contributor guide](../CONTRIBUTING.md) for commit hooks and security checks.
