export type SessionState = "idle" | "running" | "awaiting_approval" | "interrupted" | "error" | "unknown";
export type TurnState = "accepted" | "running" | "awaiting_approval" | "completed" | "interrupted" | "error" | "unknown";
export type OperationStatus = "accepted" | "delivered" | "error" | "unknown";
export interface Host {
  hostId: string; name: string; status: "connected" | "disconnected" | "revoked"; lastSeenAt: string | null;
}
export interface AgentRef { id: string; revision: string }
export interface SessionOptions { model?: string; reasoningEffort?: string; instructionsAppend?: string }
export interface WorkspaceSandbox {
  type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean;
  excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean;
}
export interface ResolvedSessionConfig {
  model: string; modelProvider: string; reasoningEffort: string | null; developerInstructions: string;
  approvalPolicy: "on-request"; approvalsReviewer: "user"; sandbox: WorkspaceSandbox;
}
export interface SessionConfig {
  agentRef?: AgentRef; overrides: SessionOptions; resolved: ResolvedSessionConfig | null;
}
export interface Session {
  sessionId: string; hostId: string; workDir: string; codexThreadId: string | null;
  /** Null for native conversations connected without an agent definition. */
  sessionConfig: SessionConfig | null;
  codexHome?: string; connectionState: "disconnected" | "connecting" | "connected" | "error";
  connectionConfirmedAt?: string;
  createdAt: string; runtimeState: SessionState; observedAt: string; lastKnownState: SessionState;
  lastKnownAt: string; activeTurnId: string | null; latestCursor: number;
}
/** Read-only native metadata. Discovered conversations are not execution-owned. */
export interface NativeSession {
  id: string; codexHome: string; name: string; workDir: string | null;
  createdAt: string | null; updatedAt: string | null; archived: boolean | null;
  kind: string; parentId: string | null; forkedFromId: string | null;
  runtimeStatus: string; hasActiveWriter: boolean | null;
}
export interface SessionSummary extends Omit<Session, "workDir" | "createdAt"> {
  workDir: string | null; createdAt: string | null; managed: boolean; name: string;
  native: NativeSession | null;
}
export interface NativeMessage {
  id: string; turnId: string; role: "user" | "assistant"; text: string;
  phase: string | null; createdAt: string; turnStatus: string | null;
  ordinal?: number;
  itemComplete?: boolean;
  updatedOrdinal?: number;
}
export interface ContentRef {
  contentId: string | null; kind: "output" | "diff"; label: string; byteLength: number | null;
  availability: "available" | "partial" | "unavailable"; completeness: "complete" | "partial" | "unknown";
}
export interface SessionActivity {
  id: string; turnId: string; ordinal: number | null; createdAt: string; type: string; title: string;
  status: string | null; command?: string; paths?: string[]; contents: ContentRef[];
  updatedOrdinal: number | null; itemComplete: boolean;
}
export interface ContentPage {
  contentId: string; text: string; byteOffset: number; nextCursor: string | null; byteLength: number;
  completeness: ContentRef["completeness"]; availability: ContentRef["availability"];
}
export interface NativeHistory {
  messages: NativeMessage[]; activities: SessionActivity[]; beforeCursor: string | null; afterCursor: string | null;
  updateCursor: string | null; hasMoreUpdates: boolean; observedAt: string;
}
export interface NativeInventory {
  sessions: NativeSession[]; observedAt: string;
  sources: { source: string; state: string; error: string | null }[];
  nextCursor: number | null;
}
export interface EventHistory { events: Event[]; nextCursor: number; hasMore: boolean; liveMessages: NativeMessage[] }
export interface HostQuery {
  queryId: string; operation: "discoverSessions" | "readSessionHistory" | "readEvents" | "getSessionActivity" | "readSessionContent";
  input: { sessionId?: string; cursor?: number; codexThreadId?: string; codexHome?: string; beforeCursor?: string; afterCursor?: string; updateCursor?: string; limit?: number; itemId?: string; contentId?: string; contentCursor?: string; limitBytes?: number };
}
export interface HostQueryResult { queryId: string; result?: NativeInventory | NativeHistory | EventHistory | SessionActivity | ContentPage; error?: ManagementErrorData }
export interface Turn {
  turnId: string; sessionId: string; requestId: string; codexTurnId: string | null;
  state: TurnState; createdAt: string; observedAt: string; error: ManagementErrorData | null;
}
export interface Event {
  eventId: string; cursor: number; sessionId: string; turnId: string | null;
  timestamp: string; type: string; payload: Record<string, unknown>;
}
export interface Approval {
  approvalId: string; sessionId: string; turnId: string; codexRequestId: string | number;
  action: Record<string, unknown>; status: "pending" | "requested" | "delivered" | "resolved" | "invalidated";
  decision: "allow" | "deny" | null; decidedAt: string | null;
}
export interface ManagementErrorData {
  code: string; message: string; retryable: boolean; sessionId?: string; turnId?: string;
}
export class ManagementError extends Error {
  constructor(readonly detail: ManagementErrorData) { super(detail.message); this.name = "ManagementError"; }
}
export function fail(code: string, message: string, retryable = false, refs: { sessionId?: string; turnId?: string } = {}): never {
  throw new ManagementError({ code, message, retryable, ...refs });
}
export interface Command {
  commandId: string; operation: "createSession" | "connectSession" | "sendMessage" | "interruptTurn" | "decideApproval";
  sessionId: string; turnId: string | null; input: Record<string, unknown>;
}
export interface Operation extends Command {
  caller: string; requestId: string; fingerprint: string; status: OperationStatus; createdAt: string;
  error: ManagementErrorData | null;
}
export interface HostReport {
  sessions: Session[]; turns: Turn[]; approvals: Approval[]; operations: OperationResult[];
}
export interface OperationResult { commandId: string; status: "delivered" | "error" | "unknown"; error: ManagementErrorData | null }
export type ToHost = { type: "sync"; cursors: Record<string, number> } | { type: "ready" } | { type: "command"; command: Command } | { type: "query"; query: HostQuery };
export type ToControlPlane = { type: "hello"; hostId: string } | { type: "event"; event: Event }
  | { type: "report"; report: HostReport } | { type: "result"; result: OperationResult } | { type: "query_result"; response: HostQueryResult };
export const terminal = (state: TurnState): state is "completed" | "interrupted" | "error" => state === "completed" || state === "interrupted" || state === "error";
export const now = (): string => new Date().toISOString();

const text = { type: "string", minLength: 1, maxLength: 4096 };
const request = { type: "string", minLength: 1, maxLength: 200 };
const sessionOptions = { type: "object", properties: {
  model: request, reasoningEffort: request,
  instructionsAppend: { type: "string", minLength: 0, maxLength: 100000 },
}, required: [], additionalProperties: false };
const agentRef = { type: "object", properties: { id: request, revision: request }, required: ["id", "revision"], additionalProperties: false };
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
export const tools = [
  tool("listHosts", "List configured hosts and observed connection state.", {}, []),
  tool("listSessions", "List SDK-discovered Codex conversations with optional managed execution metadata.", { hostId: text }, []),
  tool("createSession", "Create a session with optional agent overrides frozen for recovery. Poll getSession for readiness.", { hostId: text, workDir: text, requestId: request, agentRef, sessionOptions }, ["hostId", "workDir", "requestId"]),
  tool("connectSession", "Connect an SDK-discovered native conversation without creating a new thread. Poll getSession for readiness.", { sessionId: text, requestId: request }, ["sessionId", "requestId"]),
  tool("getSession", "Read current and last known state, turns, operations, and pending approvals.", { sessionId: text }, ["sessionId"]),
  tool("readSessionHistory", "Read the latest 50 native items and host events. Page with beforeCursor/afterCursor; poll changed items with updateCursor.", { sessionId:text,cursor:{ type:"integer",minimum:0 },beforeCursor:text,afterCursor:text,updateCursor:text,limit:{ type:"integer",minimum:1,maximum:500 } },["sessionId"]),
  tool("getSessionActivity", "Read activity metadata and private content references for an exact conversation item.", { sessionId: text, itemId: text }, ["sessionId", "itemId"]),
  tool("readSessionContent", "Read a UTF-8 chunk from host-private output or diff content. The default chunk is 64 KiB.", { sessionId: text, contentId: text, contentCursor: text, limitBytes: { type: "integer", minimum: 4, maximum: 262144 } }, ["sessionId", "contentId"]),
  tool("sendMessage", "Record a new turn in the existing conversation. Acceptance does not mean execution has started.", { sessionId: text, message: { ...text, maxLength: 100000 }, requestId: request }, ["sessionId", "message", "requestId"]),
  tool("interruptTurn", "Request interruption of the exact active turn. Poll final state separately.", { sessionId: text, turnId: text, requestId: request }, ["sessionId", "turnId", "requestId"]),
] as const;
const approvalTool = tool("decideApproval", "Decide an exact pending approval; operator authority required.", { sessionId: text, turnId: text, approvalId: text, decision: { type: "string", enum: ["allow", "deny"] } }, ["sessionId", "turnId", "approvalId", "decision"]);
export type ToolName = "listHosts" | "listSessions" | "createSession" | "connectSession" | "getSession" | "readSessionHistory" | "getSessionActivity" | "readSessionContent" | "sendMessage" | "interruptTurn" | "decideApproval";
export function validateInput(name: string, input: unknown): Record<string, unknown> {
  const schema = [...tools, approvalTool].find(t => t.name === name)?.inputSchema;
  if (!schema) fail("INVALID_INPUT", "Unknown operation.");
  return validateField(schema, input, "input") as Record<string, unknown>;
}

interface InputSchema {
  type: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; enum?: string[];
  properties?: Record<string, unknown>; required?: string[];
}
function validateField(schema: InputSchema, value: unknown, path: string): unknown {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT", `${path} must be an object.`);
    const values = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(values, key)) fail("INVALID_INPUT", `${path}.${key} is required.`);
    return Object.fromEntries(Object.entries(values).map(([key, item]) => {
      const field = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] as InputSchema : undefined;
      if (!field) fail("INVALID_INPUT", `Unknown field: ${path}.${key}.`);
      return [key, validateField(field, item, `${path}.${key}`)];
    }));
  }
  if (schema.type === "string" && (typeof value !== "string" || ((schema.minLength ?? 1) > 0 && !value.trim()) || value.length < (schema.minLength ?? 0) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.enum && !schema.enum.includes(value)))) fail("INVALID_INPUT", `Invalid ${path}.`);
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < schema.minimum! || (schema.maximum !== undefined && value > schema.maximum))) fail("INVALID_INPUT", `Invalid ${path}.`);
  return value;
}
/** Stable fingerprints include nested configuration without depending on object key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export { LiveReplies } from "./live.js";
