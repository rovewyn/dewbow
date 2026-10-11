export type SourceName = "database" | "app-server" | "cli" | "lineage" | "writers" | "processes";
export type SourceState = "success" | "partial" | "unavailable" | "error" | "disabled";
export type RuntimeStatus = "unknown" | "notLoaded" | "idle" | "active" | "systemError";
export type SessionKind = "session" | "child_session" | "review_session" | "unknown";

export interface DiscoverOptions {
  /** Defaults to CODEX_HOME or ~/.codex. Additional homes are explicit, not a disk-wide scan. */
  codexHome?: string;
  additionalHomes?: readonly string[];
  /** Existing Unix WebSocket endpoints. No daemon is started. */
  sockets?: readonly string[];
  /** Defaults to all sources. Sources run independently of each other's outcomes. */
  sources?: readonly SourceName[];
  codexExecutable?: string;
  signal?: AbortSignal;
  limits?: { maxSessions?: number; commandTimeoutMs?: number; sourceBudgetMs?: number };
}

export interface ReadSessionHistoryOptions {
  /** Defaults to CODEX_HOME or ~/.codex. Reads this home's history database only. */
  codexHome?: string;
  /** Messages per page, from 1 to 1,000. Defaults to 100. */
  limit?: number;
  /** Opaque cursor from a previous page for the same home, session, and direction. */
  cursor?: string;
  /** Defaults to ascending saved message order. */
  sortDirection?: "asc" | "desc";
  signal?: AbortSignal;
}

/** Saved input parts, including text and attachment references. Referenced files are not read. */
export interface SessionMessageContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface SessionMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  /** Text parts joined with a newline. Original parts remain in content. */
  text: string;
  content: SessionMessageContent[];
  /** Saved assistant phase, such as commentary or final_answer; null for user messages. */
  phase: string | null;
  createdAtMs: number;
  /** Saved turn status; null when the corresponding turn record is absent. */
  turnStatus: string | null;
}

export interface SessionHistoryPage {
  sessionId: string;
  codexHome: string;
  source: "database";
  observedAt: string;
  messages: SessionMessage[];
  nextCursor: string | null;
}

export type SessionHistoryErrorCode = "UNAVAILABLE" | "SESSION_NOT_FOUND" | "UNSUPPORTED_SCHEMA"
  | "INVALID_HISTORY" | "LIMIT_EXCEEDED" | "READ_FAILED";

export interface SourceReport {
  source: SourceName;
  state: SourceState;
  codexHome: string | null;
  observedAt: string;
  error: string | null;
  counts: Record<string, number | null>;
}

export interface RuntimeSessionReport {
  runtimeId: string;
  loaded: boolean;
  status: RuntimeStatus;
  activeFlags: string[];
  pids: number[];
}

export interface CodexSession {
  id: string;
  codexHome: string;
  name: string;
  title: string | null;
  nickname: string | null;
  kind: SessionKind;
  parentId: string | null;
  forkedFromId: string | null;
  workspace: string | null;
  model: string | null;
  modelProvider: string | null;
  role: string | null;
  reasoningEffort: string | null;
  source: string | null;
  originator: string | null;
  cliVersion: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean | null;
  archivedAt: number | null;
  pinned: boolean | null;
  tokensUsed: number | null;
  ephemeral: boolean | null;
  runtimeStatus: RuntimeStatus;
  activeFlags: string[];
  /** Runtime PIDs associated through OS socket ownership and a successful API snapshot. */
  pids: number[];
  runtimeReports: RuntimeSessionReport[];
  hasActiveWriter: boolean | null;
  /** Confirmed kernel-reported owner only. Never inferred from an open-file PID. */
  writerPid: number | null;
  /** Processes with the lock file open. These are not confirmed lock owners. */
  writerOpenPids: number[] | null;
  writerObservedAt: string | null;
  writerOpenPidSource: "os-open-files" | null;
  lineageObservedAt: string | null;
  cliInspectionStates: string[];
  sources: SourceName[];
  fieldSources: Partial<Record<keyof CodexSession, SourceName>>;
}

export interface CodexProcess {
  pid: number;
  parentPid: number;
  executable: string;
  mode: "app-server" | "supervisor" | "transport-proxy" | "execution-helper" | "exec" | "mcp-server" | "unclassified";
  controlSockets: string[];
}

export interface RuntimeReport {
  id: string;
  endpoint: string | null;
  pids: number[];
  state: "connected" | "unavailable" | "error";
  error: string | null;
  codexHome: string | null;
  loadedSessions: number | null;
  listedSessions: number | null;
}

export interface DiscoverySnapshot {
  observedAt: string;
  sessions: CodexSession[];
  processes: CodexProcess[];
  runtimes: RuntimeReport[];
  sources: SourceReport[];
  warnings: string[];
  summary: {
    sessions: number | null;
    archived: number | null;
    childSessions: number | null;
    parentRelationships: number;
    forkRelationships: number;
    loadedSessions: number | null;
    activeSessions: number | null;
    activeWriters: number | null;
    unknownWriters: number;
    connectedRuntimes: number;
  };
}
