export type SessionState = "idle" | "running" | "awaiting_approval" | "awaiting_input" | "interrupted" | "error" | "unknown";
export type TurnMode = "default" | "plan";
export type TurnState = "accepted" | "running" | "awaiting_approval" | "awaiting_input" | "completed" | "interrupted" | "error" | "unknown";
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
export interface WorkspaceProfile { profileId: string; name: string; kind: "emptyDirectory" | "gitWorktree" }
export interface SessionWorkspace { profileId: string; kind: WorkspaceProfile["kind"]; workDir: string; directoryIdentity: string | null; repository: string | null; baseCommit: string | null; branch: string | null; status: "preparing" | "ready" | "error" }
export interface ExecutionPause { pauseId: string; authority: "agent" | "operator"; createdAt: string }
export interface SessionContext {
  contextId: string; sessionId: string; segmentId: string; source: "takeoverStart" | "user" | "operator" | "takeoverEnd";
  text: string; createdAt: string; sequence: number; afterTurnId?: string | null; availability?: "available" | "restricted";
}
export interface Session {
  sessionId: string; hostId: string; workDir: string | null; workspace?: SessionWorkspace; codexThreadId: string | null;
  /** Null for native conversations connected without an agent definition. */
  sessionConfig: SessionConfig | null;
  codexHome?: string; connectionState: "disconnected" | "connecting" | "connected" | "error";
  connectionConfirmedAt?: string;
  createdAt: string; runtimeState: SessionState; observedAt: string; lastKnownState: SessionState;
  lastKnownAt: string; activeTurnId: string | null; latestCursor: number;
  executionPause?: ExecutionPause | null;
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
  clientId?: string | null;
  availability?: "available" | "restricted";
}
export interface ContentRef {
  contentId: string | null; kind: "output" | "diff"; label: string; byteLength: number | null;
  availability: "available" | "partial" | "unavailable"; completeness: "complete" | "partial" | "unknown";
  authority: "agent" | "operator";
}
export interface SessionActivity {
  id: string; turnId: string; ordinal: number | null; createdAt: string; type: string; title: string;
  availability?: "available" | "restricted";
  status: string | null; command?: string; paths?: string[]; contents: ContentRef[];
  updatedOrdinal: number | null; itemComplete: boolean;
}
export interface ContentPage {
  contentId: string; text: string; byteOffset: number; nextCursor: string | null; byteLength: number;
  completeness: ContentRef["completeness"]; availability: ContentRef["availability"];
}
export interface NativeHistory {
  messages: NativeMessage[]; activities: SessionActivity[]; beforeCursor: string | null; afterCursor: string | null;
  contextRecords?: SessionContext[];
  contextCursor?: number; beforeContextCursor?: number | null; hasMoreContexts?: boolean;
  historyError?: ManagementErrorData;
  updateCursor: string | null; hasMoreUpdates: boolean; observedAt: string;
}
/** Protect a secret-bearing native turn across saved and volatile reads. */
export function maskPrivateMessages(messages: NativeMessage[], turns: Set<string>): NativeMessage[] {
  return messages.map(message=>turns.has(message.turnId) ? {...message,text:"",availability:"restricted"} : message);
}
export function maskPrivateActivity(activity: SessionActivity): SessionActivity {
  const {command:_command,paths:_paths,...metadata}=activity;
  return {...metadata,availability:"restricted",title:"Restricted activity",contents:activity.contents.map(ref=>({...ref,label:"Restricted content",authority:"operator"}))};
}
export function maskPrivateEvents(events: Event[], turns: Set<string>): Event[] {
  return events.map(event=>{
    const nativeTurn=(event.payload.turn as Turn|undefined)?.codexTurnId;
    if(!turns.has(event.turnId??"") && !turns.has(nativeTurn??""))return event;
    const payload={...event.payload};
    for(const key of ["text","plan","explanation","command","cwd","paths","tool","server"])delete payload[key];
    if(payload.activity)payload.activity=maskPrivateActivity(payload.activity as SessionActivity);
    if(payload.interaction){const {details:_details,...metadata}=payload.interaction as Interaction;payload.interaction=metadata;}
    return {...event,payload};
  });
}
export interface NativeInventory {
  sessions: NativeSession[]; observedAt: string;
  sources: { source: string; state: string; error: string | null }[];
  nextCursor: number | null;
}
export interface EventHistory { events: Event[]; nextCursor: number; hasMore: boolean; liveMessages: NativeMessage[] }
export interface SessionDetails {
  host?: Host;
  session: SessionSummary; contextAuthority: "agent" | "operator"; turns: Turn[];
  interactions: Interaction[]; interactionsError: ManagementErrorData | null;
  operations: Omit<Operation, "caller" | "fingerprint" | "input">[];
}
export interface SessionHistory extends EventHistory, Omit<NativeHistory, "observedAt" | "historyError"> {
  historyError: ManagementErrorData | null; eventsError?: ManagementErrorData | null;
}
export interface HistoryPosition { cursor?: number | undefined; updateCursor?: string | undefined; contextCursor?: number | undefined; resumeSessionId?: string | undefined }
export interface SessionUpdates { contractVersion: "v1"; details: SessionDetails; history: SessionHistory }
export interface HostQuery {
  queryId: string; operation: "listWorkspaceProfiles" | "discoverSessions" | "readSessionHistory" | "readEvents" | "getSessionActivity" | "readSessionContent" | "readInteractions";
  input: { sessionId?: string; cursor?: number; contextCursor?:number; beforeContextCursor?:number; codexThreadId?: string; codexHome?: string; beforeCursor?: string; afterCursor?: string; updateCursor?: string; limit?: number; itemId?: string; contentId?: string; contentCursor?: string; limitBytes?: number };
  authority: "agent" | "operator";
}
export interface InteractionPage { interactions: Interaction[] }
export interface HostQueryResult { queryId: string; result?: { profiles: WorkspaceProfile[] } | NativeInventory | NativeHistory | EventHistory | SessionActivity | ContentPage | InteractionPage; error?: ManagementErrorData }
export interface Turn {
  turnId: string; sessionId: string; requestId: string; codexTurnId: string | null;
  state: TurnState; createdAt: string; observedAt: string; error: ManagementErrorData | null;
  mode: TurnMode;
}
export interface Event {
  eventId: string; cursor: number; sessionId: string; turnId: string | null;
  timestamp: string; type: string; payload: Record<string, unknown>;
}
export interface UserQuestion {
  questionId: string; header: string; prompt: string; options: { label: string; description: string }[] | null;
  allowCustom: boolean; secret: boolean;
}
export interface QuestionAnswer { questionId: string; answers: string[] }
export interface InteractionDetails { questions?: UserQuestion[]; action?: Record<string,unknown>; answers?: QuestionAnswer[] }
export interface Interaction {
  interactionId: string; sessionId: string; turnId: string; itemId: string | null;
  kind: "approval" | "questions" | "unsupported"; authority: "operator" | "agent"; blocking: boolean;
  status: "pending" | "requested" | "delivered" | "resolved" | "invalidated";
  createdAt: string; observedAt: string; decision: "allow" | "deny" | null; requestId: string | null;
  content: ContentRef; details?: InteractionDetails;
  sensitive: boolean;
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
  commandId: string; operation: "createSession" | "connectSession" | "sendMessage" | "steerTurn" | "answerQuestions" | "interruptTurn" | "decideApproval" | "pauseSessionExecution" | "resumeSessionExecution" | "appendSessionContext";
  sessionId: string; turnId: string | null; input: Record<string, unknown>;
  authority: "operator" | "agent";
}
export interface Operation extends Command {
  caller: string; requestId: string; fingerprint: string; status: OperationStatus; createdAt: string;
  error: ManagementErrorData | null;
}
export interface HostReport {
  sessions: Session[]; turns: Turn[]; interactions: Interaction[]; operations: OperationResult[];
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
  tool("listWorkspaceProfiles", "List host-owned workspace profiles without local source paths.", { hostId: text }, ["hostId"]),
  tool("listSessions", "List SDK-discovered Codex conversations with optional managed execution metadata.", { hostId: text }, []),
  tool("createSession", "Create a session with optional agent overrides frozen for recovery. Poll getSession for readiness.", { hostId: text, workDir: text, workspaceProfileId: request, requestId: request, agentRef, sessionOptions }, ["hostId", "requestId"]),
  tool("connectSession", "Connect an SDK-discovered native conversation without creating a new thread. Poll getSession for readiness.", { sessionId: text, requestId: request }, ["sessionId", "requestId"]),
  tool("pauseSessionExecution", "Pause execution submissions through this host daemon without interrupting the active turn.", { sessionId:text,requestId:request }, ["sessionId","requestId"]),
  tool("resumeSessionExecution", "Release an exact pause without starting execution. Force requires Core operator authority.", { sessionId:text,pauseId:request,force:{type:"boolean"},requestId:request }, ["sessionId","pauseId","requestId"]),
  tool("appendSessionContext", "Persist external conversation context without starting a turn. Reuse the original request and context IDs after an uncertain result.", { sessionId:text,contextId:request,segmentId:request,source:{type:"string",enum:["takeoverStart","user","operator","takeoverEnd"]},text:{type:"string",minLength:0,maxLength:100000},requestId:request }, ["sessionId","contextId","segmentId","source","text","requestId"]),
  tool("getSession", "Read state, turns, requests, and unified interactions. Delivery is separate from turn completion.", { sessionId: text }, ["sessionId"]),
  tool("readSessionHistory", "Read the latest 50 native items and host events. Page with beforeCursor/afterCursor; poll changed items with updateCursor.", { sessionId:text,cursor:{ type:"integer",minimum:0 },contextCursor:{type:"integer",minimum:0},beforeContextCursor:{type:"integer",minimum:1},beforeCursor:text,afterCursor:text,updateCursor:text,limit:{ type:"integer",minimum:1,maximum:500 } },["sessionId"]),
  tool("getSessionActivity", "Read activity metadata and private content references for an exact conversation item.", { sessionId: text, itemId: text }, ["sessionId", "itemId"]),
  tool("readSessionContent", "Read a UTF-8 chunk from host-private output or diff content. The default chunk is 64 KiB.", { sessionId: text, contentId: text, contentCursor: text, limitBytes: { type: "integer", minimum: 4, maximum: 262144 } }, ["sessionId", "contentId"]),
  tool("sendMessage", "Record a new Default or Plan turn. Default is used when mode is omitted.", { sessionId: text, message: { ...text, maxLength: 100000 }, requestId: request, mode:{ type:"string",enum:["default","plan"] } }, ["sessionId", "message", "requestId"]),
  tool("steerTurn", "Append instructions to the exact active turn without changing its mode.", { sessionId:text,turnId:text,message:{...text,maxLength:100000},requestId:request },["sessionId","turnId","message","requestId"]),
  tool("answerQuestions", "Answer an exact pending interaction. Ordinary questions permit agents; other questions require the Core operator.", { sessionId:text,turnId:text,interactionId:text,requestId:request,answers:{type:"array",minItems:1,maxItems:20,items:{type:"object",properties:{questionId:request,answers:{type:"array",minItems:1,maxItems:20,items:{type:"string",minLength:0,maxLength:100000}}},required:["questionId","answers"],additionalProperties:false}} },["sessionId","turnId","interactionId","requestId","answers"]),
  tool("interruptTurn", "Request interruption of the exact active turn. Poll final state separately.", { sessionId: text, turnId: text, requestId: request }, ["sessionId", "turnId", "requestId"]),
] as const;
const approvalTool = tool("decideApproval", "Decide an exact pending approval; operator authority required.", { sessionId:text,turnId:text,interactionId:text,requestId:request,decision:{type:"string",enum:["allow","deny"]} },["sessionId","turnId","interactionId","requestId","decision"]);
export type ToolName = Command["operation"] | "listHosts" | "listWorkspaceProfiles" | "listSessions" | "getSession" | "readSessionHistory" | "getSessionActivity" | "readSessionContent";
export function validateInput(name: string, input: unknown): Record<string, unknown> {
  const schema = [...tools, approvalTool].find(t => t.name === name)?.inputSchema;
  if (!schema) fail("INVALID_INPUT", "Unknown operation.");
  const validated = validateField(schema, input, "input") as Record<string, unknown>;
  if (name === "createSession" && Boolean(validated.workDir) === Boolean(validated.workspaceProfileId)) fail("INVALID_INPUT", "Choose exactly one workDir or workspaceProfileId.");
  if (name === "sendMessage") validated.mode ??= "default";
  return validated;
}

interface InputSchema {
  type: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; enum?: string[];
  properties?: Record<string, unknown>; required?: string[];
  items?: InputSchema; minItems?: number; maxItems?: number;
}
function validateField(schema: InputSchema, value: unknown, path: string): unknown {
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 500)) fail("INVALID_INPUT",`Invalid ${path}.`);
    return value.map((item,index)=>validateField(schema.items!,item,`${path}[${index}]`));
  }
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
  if (schema.type === "boolean" && typeof value !== "boolean") fail("INVALID_INPUT", `Invalid ${path}.`);
  return value;
}
/** Stable fingerprints include nested configuration without depending on object key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export { LiveReplies } from "./live.js";
