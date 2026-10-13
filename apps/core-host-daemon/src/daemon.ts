import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
import { discoverSessions, readSessionHistory, readSessionItems, readSessionItem, readSessionToolOrigin, SessionHistoryError } from "@dewbow/core-sdk";
import type { DiscoverOptions, DiscoverySnapshot, ReadSessionHistoryOptions } from "@dewbow/core-sdk";
import { canonicalJson, fail, LiveReplies, ManagementError, maskPrivateMessages, maskPrivateActivity, maskPrivateEvents, now, terminal, validateInput } from "@dewbow/core-protocol";
import type { AgentRef, Interaction, Command, ContentPage, Event, EventHistory, ExecutionPause, SessionContext, HostQuery, HostReport, NativeHistory, NativeInventory, OperationResult, Session, SessionActivity, SessionOptions, Turn, ToHost, ToControlPlane } from "@dewbow/core-protocol";
import { Store } from "@dewbow/core-protocol/store";
import type { HostDaemonConfig } from "./config.js";
import { Runtime } from "./runtime.js";
import type { RpcMessage } from "./runtime.js";
import { checkSavedModel, confirmSessionConfig, resolveSessionConfig, sessionThreadOptions } from "./session-config.js";
import { SessionContent } from "./content.js";
import { projectItem } from "./history.js";
import {approvalResponse,builtinQuestion,createInteraction,interactionDetails,publicInteraction,validateAnswers,type NativeInteraction} from "./interactions.js";

import { Workspaces } from "./workspaces.js";
interface Journal { command: Command; fingerprint: string; result: OperationResult }
interface SavedContext { record: SessionContext; fingerprint: string; itemId: string; nativeText: string; confirmed: boolean; commandId: string }
export class HostDaemon {
  private store: Store | undefined;
  private contents: SessionContent | undefined;
  private readonly outputCapture = new Map<string,string>();
  private readonly runtimeId = randomUUID();
  private readonly toolOrigins = new Map<string,{name:string;namespace:string|null}|null>();
  private readonly modeSettings = new Map<string,{model:string;reasoningEffort:string|null}>();
  private readonly runtime = new Runtime();
  private socket: WebSocket | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private stopping = false;
  private ownsStore = false;
  onRuntimeFailure: () => void = () => {};
  private ready = false;
  private readonly liveReplies = new LiveReplies();
  private syncedCursors: Record<string, number> = {};
  private readonly inFlight = new Set<string>();
  private readonly contextWrites = new Map<string, Promise<void>>();
  private inventory: { expires: number; snapshot: Promise<DiscoverySnapshot> } | undefined;
  private readonly reads = new AbortController();
  constructor(readonly config: HostDaemonConfig) {}
  discoverSessions(options: Omit<DiscoverOptions, "codexHome"> = {}) { return discoverSessions({ ...options, ...(this.config.codexHome ? { codexHome: this.config.codexHome } : {}) }); }
  readSessionHistory(sessionId: string, options: Omit<ReadSessionHistoryOptions, "codexHome"> = {}) { return readSessionHistory(sessionId, { ...options, ...(this.config.codexHome ? { codexHome: this.config.codexHome } : {}) }); }
  async start(): Promise<void> {
    if (!this.config.token) throw new TypeError("DEWBOW_HOST_TOKEN is required.");
    this.store = new Store(this.config.statePath);
    try {
      const owner = this.store.get<{ daemonPid: number | null; runtimePid: number | null }>("meta", "owner");
      if (owner && (alive(owner.daemonPid) || (owner.runtimePid !== null && alive(owner.runtimePid)))) fail("RECOVERY_REQUIRED", "A recorded daemon or runtime is still alive. Verify and stop it locally before restarting.");
      this.contents = new SessionContent(`${this.config.statePath}.contents.sqlite`);
      this.runtime.onMessage = message => this.notification(message);
      this.runtime.onExit = () => this.runtimeClosed();
      this.runtime.onSpawn = pid => this.store!.put("meta", "owner", { daemonPid: process.pid, runtimePid: pid });
      this.ownsStore = true;
      this.store.put("meta", "owner", { daemonPid: process.pid, runtimePid: null });
      const pid = await this.runtime.start(this.config.codexExecutable, this.config.codexHome);
      this.store.put("meta", "owner", { daemonPid: process.pid, runtimePid: pid });
      await this.recover();
      this.connect();
    } catch (error) { await this.stop(); throw error; }
  }
  private session(id: string): Session {
    const session = this.store!.get<Session>("session", id) ?? fail("NOT_FOUND", "Managed session not found.", false, { sessionId: id });
    session.executionPause = this.store!.get<ExecutionPause>("pause",id) ?? null;
    return session;
  }
  private requireExecution(sessionId: string): void {
    if (this.store!.get("pause",sessionId)) fail("SESSION_PAUSED","Execution submissions are paused on this host daemon.",false,{sessionId});
    if (this.contextWrites.has(sessionId)) fail("SESSION_BUSY","Context append is still being confirmed.",true,{sessionId});
  }
  private emit(session: Session, type: string, payload: Record<string, unknown> = {}, turn?: Turn, observation = true): void {
    session.executionPause = this.store!.get<ExecutionPause>("pause",session.sessionId) ?? null;
    session.latestCursor = Math.max(session.latestCursor,this.store!.get<Session>("session",session.sessionId)?.latestCursor ?? 0);
    if (observation && session.runtimeState !== "unknown") { session.observedAt = now(); session.lastKnownState = session.runtimeState; session.lastKnownAt = session.observedAt; }
    session.latestCursor++;
    const event: Event = { eventId: `${session.sessionId}:${session.latestCursor}`, cursor: session.latestCursor, sessionId: session.sessionId,
      turnId: turn?.turnId ?? session.activeTurnId, timestamp: now(), type,
      payload: this.redact({ ...payload, session: { ...session }, ...(turn ? { turn: { ...turn } } : {}) }) as Record<string, unknown> };
    this.liveReplies.observe(event);
    this.store!.transaction(() => { this.store!.put("session", session.sessionId, session); if (turn) this.store!.put("turn", turn.turnId, turn); this.store!.append(event); });
    if (this.ready) this.send({ type: "event", event });
  }
  private redact(value: unknown): unknown {
    const secrets = [this.config.token, process.env.DEWBOW_MANAGEMENT_TOKEN, process.env.DEWBOW_OPERATOR_PASSWORD, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].filter((s): s is string => Boolean(s));
    const clean = (item: unknown): unknown => {
      if (typeof item === "string") { for (const secret of secrets) item = (item as string).split(secret).join("[redacted]"); return item; }
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, field]) => [key, clean(field)]));
      return item;
    };
    return clean(value);
  }
  private send(frame: ToControlPlane): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame)); }
  private report(): HostReport {
    return { sessions:this.store!.list<Session>("session").map(s=>this.session(s.sessionId)),turns:this.store!.list<Turn>("turn"),interactions:this.store!.list<NativeInteraction>("interaction").map(publicInteraction),operations:this.store!.list<Journal>("command").map(j=>j.result) };
  }
  private connect(): void {
    const url = new URL("/hosts/connect", this.config.controlPlaneUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: 10 * 1024 * 1024, handshakeTimeout: 10000 });
    let lastPing = Date.now();
    this.heartbeat = setInterval(() => { if (Date.now() - lastPing > 35000) socket.terminate(); }, 10000);
    socket.on("ping", () => { lastPing = Date.now(); });
    socket.on("error", () => {});
    socket.on("open", () => this.send({ type: "hello", hostId: this.config.hostId }));
    socket.on("message", raw => {
      try {
        const frame = JSON.parse(raw.toString()) as ToHost;
        if (frame.type === "sync") {
          for (const session of this.store!.list<Session>("session")) {
            let cursor = frame.cursors[session.sessionId] ?? 0;
            while (true) {
              const events = this.store!.history(session.sessionId, cursor, 100);
              if (!events.length) break;
              for (const event of events) this.send({ type: "event", event });
              cursor = events.at(-1)!.cursor;
            }
          }
          const report = this.report();
          this.syncedCursors = Object.fromEntries(report.sessions.map(s => [s.sessionId, s.latestCursor]));
          this.send({ type: "report", report });
        } else if (frame.type === "ready") {
          this.ready = true;
          for (const session of this.store!.list<Session>("session")) {
            let cursor = this.syncedCursors[session.sessionId] ?? 0;
            while (true) {
              const events = this.store!.history(session.sessionId, cursor, 100);
              if (!events.length) break;
              for (const event of events) this.send({ type: "event", event });
              cursor = events.at(-1)!.cursor;
            }
          }
          console.log(JSON.stringify({ component: "host-daemon", status: "connected" })); }
        else if (frame.type === "command" && this.ready) void this.command(frame.command);
        else if (frame.type === "query" && this.ready) void this.query(frame.query);
        else socket.close(1008, "Invalid control frame");
      } catch { socket.close(1008, "Invalid control frame"); }
    });
    socket.on("close", () => {
      this.ready = false; clearInterval(this.heartbeat);
      if (!this.stopping) { console.log(JSON.stringify({ component: "host-daemon", status: "disconnected" })); this.reconnect = setTimeout(() => this.connect(), 2000); }
    });
  }
  private async query(query: HostQuery): Promise<void> {
    try {
      let result: { profiles: import("@dewbow/core-protocol").WorkspaceProfile[] } | NativeInventory | NativeHistory | EventHistory | SessionActivity | ContentPage | {interactions:Interaction[]};
      if (query.operation === "listWorkspaceProfiles") { result = new Workspaces(this.config.workspaces).list(); } else if (query.operation === "discoverSessions") {
        if (!this.inventory || this.inventory.expires < Date.now()) {
          this.inventory = { expires: Date.now() + 10000, snapshot: this.discoverSessions({ codexExecutable: this.config.codexExecutable, signal: AbortSignal.any([this.reads.signal, AbortSignal.timeout(20000)]) }) };
        }
        const snapshot = await this.inventory.snapshot;
        if (snapshot.summary.sessions === null) fail("DISCOVERY_UNAVAILABLE", "Native conversation inventory is unavailable.", true);
        const cursor = query.input.cursor ?? 0, end = cursor + 500;
        const iso = (seconds: number | null) => seconds === null ? null : new Date(seconds * 1000).toISOString();
        result = { observedAt: snapshot.observedAt, nextCursor: end < snapshot.sessions.length ? end : null,
          sources: snapshot.sources.map(({ source, state, error }) => ({ source, state, error })),
          sessions: snapshot.sessions.slice(cursor, end).map(s => ({ id: s.id, codexHome: s.codexHome, name: s.name, workDir: s.workspace,
            createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt), archived: s.archived, kind: s.kind, parentId: s.parentId,
            forkedFromId: s.forkedFromId, runtimeStatus: s.runtimeStatus, hasActiveWriter: s.hasActiveWriter })) };
      } else if (query.operation === "readEvents") {
        const session = this.session(String(query.input.sessionId));
        const cursor = query.input.cursor ?? 0, limit = query.input.limit ?? 100;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail("INVALID_INPUT", "Invalid event history page.");
        const events = this.store!.history(session.sessionId, cursor, limit + 1);
        result = { events: query.authority === "operator" ? events.slice(0,limit) : maskPrivateEvents(events.slice(0,limit),this.privateTurns(session.codexThreadId!)), nextCursor: events.slice(0, limit).at(-1)?.cursor ?? cursor,
          hasMore: events.length > limit, liveMessages: query.authority === "operator" ? this.liveReplies.get(session.sessionId) : maskPrivateMessages(this.liveReplies.get(session.sessionId),this.privateTurns(session.codexThreadId!)) };
      } else if (query.operation === "readInteractions") {
        const session = this.session(String(query.input.sessionId)), scope = this.contentScope(session.codexHome!,session.codexThreadId!);
        const all = this.store!.list<NativeInteraction>("interaction").filter(item=>item.sessionId === session.sessionId);
        const selected = all.filter((item,index)=>index >= all.length-50 || ["pending","requested","delivered"].includes(item.status));
        if (selected.length>500) fail("LIMIT_EXCEEDED","Too many active interactions.");
        const privateSession=this.privateConversation(session.codexThreadId!);
        const details=new Map<string,import("@dewbow/core-protocol").InteractionDetails>();let budget=6*1024*1024;
        const active=(item:NativeInteraction)=>["pending","requested","delivered"].includes(item.status);
        for(const item of [...selected].sort((a,b)=>Number(active(b))-Number(active(a)))) {
          if((query.authority!=="operator" && privateSession) || (item.content.byteLength??1048577)>budget)continue;
          const value=interactionDetails(item,scope,this.contents!),bytes=Buffer.byteLength(JSON.stringify(value));
          if(bytes<=budget){details.set(item.interactionId,value);budget-=bytes;}
        }
        result = {interactions:selected.map(item=>({...publicInteraction(item),...(details.has(item.interactionId) ? {details:details.get(item.interactionId)!} : {})}))};
      } else if (query.operation === "getSessionActivity" || query.operation === "readSessionContent") {
        const home = await realpath(query.input.codexHome ?? this.config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(),".codex"));
        const scope = this.contentScope(home,query.input.codexThreadId!);
        if (query.operation === "getSessionActivity") {
          try {
            const record = await readSessionItem(query.input.codexThreadId!,query.input.itemId!,{codexHome:home,signal:this.reads.signal});
            const protectedTurn=this.privateConversation(query.input.codexThreadId!);
            const projected = projectItem(record,scope,this.contents!,false,protectedTurn ? "operator" : "agent");
            if (!projected.activity) fail("INVALID_INPUT","This native item is not an activity.");
            result = protectedTurn && query.authority!=="operator" ? maskPrivateActivity(projected.activity) : projected.activity;
          }
          catch (error) {
            if (!(error instanceof SessionHistoryError) || !["UNAVAILABLE","READ_FAILED","SESSION_NOT_FOUND","LIMIT_EXCEEDED"].includes(error.code)) throw error;
            const activity=this.contents!.getActivity(scope,query.input.itemId!);
            result = this.privateConversation(query.input.codexThreadId!) && query.authority!=="operator" ? maskPrivateActivity(activity) : activity;
          }
        } else {if(this.privateConversation(query.input.codexThreadId!) && query.authority!=="operator")fail("FORBIDDEN","This conversation contains private operator input.");result = this.contents!.read(scope,query.input.contentId!,query.input.contentCursor,query.input.limitBytes,query.authority);}
      } else if (query.operation === "readSessionHistory") {
        const queryHome = query.input.codexHome ? await realpath(query.input.codexHome).catch(() => query.input.codexHome!) : undefined;
        try {
          const page = await readSessionItems(query.input.codexThreadId!, { ...(queryHome ? { codexHome: queryHome } : this.config.codexHome ? { codexHome: this.config.codexHome } : {}),
            limit:query.input.limit ?? 50,signal:this.reads.signal,...(query.input.beforeCursor ? { beforeCursor:query.input.beforeCursor } : {}),...(query.input.afterCursor ? { afterCursor:query.input.afterCursor } : {}),...(query.input.updateCursor ? { updateCursor:query.input.updateCursor } : {}) });
          const protectedTurns=this.privateConversation(page.sessionId) ? new Set(page.items.map(item=>item.turnId)) : new Set<string>();
          const projected = page.items.map(item => projectItem(item,this.contentScope(page.codexHome,page.sessionId),this.contents!,false,protectedTurns.has(item.turnId) ? "operator" : "agent"));
          result = { observedAt:page.observedAt,beforeCursor:page.beforeCursor,afterCursor:page.afterCursor,updateCursor:page.updateCursor,hasMoreUpdates:page.hasMoreUpdates,
            messages:maskPrivateMessages(projected.flatMap(row=>row.message ? [row.message] : []),query.authority === "operator" ? new Set() : protectedTurns),activities:projected.flatMap(row=>row.activity ? [protectedTurns.has(row.activity.turnId) && query.authority!=="operator" ? maskPrivateActivity(row.activity) : row.activity] : []) };
        } catch (cause) {
          const session = this.store!.list<Session>("session").find(s => s.codexThreadId === query.input.codexThreadId
            && (!queryHome || (process.platform === "win32" ? s.codexHome?.toLowerCase() === queryHome.toLowerCase() : s.codexHome === queryHome)));
          // Codex may not index a newly created conversation until its first turn.
          const hasContext=session && this.store!.list<SavedContext>("context").some(c=>c.record.sessionId===session.sessionId && c.confirmed);
          if (cause instanceof SessionHistoryError && hasContext) {
            result = {observedAt:now(),beforeCursor:null,afterCursor:null,updateCursor:null,hasMoreUpdates:false,messages:[],activities:[],historyError:{code:cause.code,message:"Native turn history is unavailable; passive context is shown separately.",retryable:true}};
          } else {
          if (!(cause instanceof SessionHistoryError) || cause.code !== "SESSION_NOT_FOUND" || query.input.beforeCursor || query.input.afterCursor || query.input.updateCursor
            || !session?.sessionConfig?.resolved || session.connectionState !== "connected" || session.runtimeState !== "idle"
            || this.store!.list<Turn>("turn").some(turn => turn.sessionId === session.sessionId)) throw cause;
          result = { observedAt:now(),beforeCursor:null,afterCursor:null,updateCursor:null,hasMoreUpdates:false,messages:[],activities:[] };
          }
        }
      } else fail("INVALID_INPUT", "Unknown host query.");
      if (query.operation === "readSessionHistory") {
        const session = this.store!.list<Session>("session").find(s => s.codexThreadId === query.input.codexThreadId);
        if (session) {
          this.liveReplies.saved(session.sessionId, (result as NativeHistory).messages);
          const restricted = query.authority !== "operator" && this.privateConversation(session.codexThreadId!);
          const all = this.store!.list<SavedContext>("context").filter(c=>c.record.sessionId===session.sessionId && c.confirmed).map(c=>restricted ? {...c.record,text:"",availability:"restricted" as const} : c.record).sort((a,b)=>a.sequence-b.sequence);
          const forward=query.input.contextCursor!==undefined;
          const candidates=all.filter(record=>query.input.beforeContextCursor!==undefined ? record.sequence<query.input.beforeContextCursor : !forward || record.sequence>query.input.contextCursor!);
          const records:SessionContext[]=[];let bytes=0;
          for(const record of forward ? candidates : [...candidates].reverse()) {
            const size=Buffer.byteLength(JSON.stringify(record));if(records.length >= (query.input.limit??50) || bytes+size>2*1024*1024)break;
            records.push(record);bytes+=size;
          }
          records.sort((a,b)=>a.sequence-b.sequence);
          Object.assign(result,{contextRecords:records,contextCursor:records.at(-1)?.sequence??query.input.contextCursor??0,beforeContextCursor:records[0] && all.some(r=>r.sequence<records[0]!.sequence) ? records[0].sequence : null,hasMoreContexts:forward && candidates.length>records.length});
        }
      }
      const response={queryId:query.queryId,result:this.redact(result) as typeof result};
      if(Buffer.byteLength(JSON.stringify(response))>8*1024*1024)fail("LIMIT_EXCEEDED","Host read exceeds the response limit. Use a smaller page or separate content reads.");
      this.send({ type: "query_result", response });
    } catch (cause) {
      const code = cause instanceof ManagementError ? cause.detail.code : typeof (cause as { code?: unknown })?.code === "string" ? String((cause as { code: string }).code) : "READ_FAILED";
      this.send({ type: "query_result", response: { queryId: query.queryId, error: { code, message: query.operation === "discoverSessions" ? "Native conversation discovery failed." : query.operation === "readEvents" ? "Host event history could not be read." : "Native saved messages could not be read.", retryable: cause instanceof ManagementError ? cause.detail.retryable : true } } });
    }
  }
  private contentScope(home: string, threadId: string): string {
    return createHash("sha256").update(JSON.stringify([process.platform === "win32" ? home.toLowerCase() : home,threadId])).digest("hex");
  }
  private privateTurns(threadId:string):Set<string> {
    const sessionIds=new Set(this.store!.list<Session>("session").filter(session=>session.codexThreadId===threadId).map(session=>session.sessionId));
    return this.privateConversation(threadId) ? new Set(this.store!.list<Turn>("turn").filter(turn=>sessionIds.has(turn.sessionId) && turn.codexTurnId).map(turn=>turn.codexTurnId!)) : new Set();
  }
  private privateConversation(threadId:string):boolean {
    const ids=new Set(this.store!.list<Session>("session").filter(session=>session.codexThreadId===threadId).map(session=>session.sessionId));
    return this.store!.list<NativeInteraction>("interaction").some(item=>ids.has(item.sessionId) && item.sensitive);
  }
  private async command(command: Command): Promise<void> {
    const fingerprint = createHash("sha256").update(canonicalJson([command.operation,command.sessionId,command.turnId,command.input,command.authority])).digest("hex");
    const previous = this.store!.get<Journal>("command", command.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) this.send({ type: "result", result: { commandId: command.commandId, status: "error", error: { code: "REQUEST_CONFLICT", message: "Daemon command input conflict.", retryable: false } } });
      else if (!this.inFlight.has(command.commandId)) {
        if(previous.result.status === "unknown")await this.reconcileCommand(previous);
        this.send({ type: "result", result: previous.result });
      }
      return;
    }
    const { message:_message,answers:_answers,text:_text,...metadata } = command.input;
    const journal: Journal = { command: { ...command, input: metadata }, fingerprint, result: { commandId: command.commandId, status: "unknown", error: { code: "DELIVERY_UNCERTAIN", message: "Command has no confirmed result yet.", retryable: true, sessionId: command.sessionId } } };
    this.store!.put("command", command.commandId, journal); this.inFlight.add(command.commandId);
    try {
      await this.execute(command);
      journal.result = { commandId: command.commandId, status: "delivered", error: null };
    } catch (cause) {
      const error = cause instanceof ManagementError ? cause.detail : { code: "EXECUTION_FAILED", message: "Host operation failed.", retryable: false };
      journal.result = { commandId: command.commandId, status: error.code === "DELIVERY_UNCERTAIN" ? "unknown" : "error", error: { ...error, sessionId: command.sessionId, ...(command.turnId ? { turnId: command.turnId } : {}) } };
      const session = this.store!.get<Session>("session", command.sessionId);
      const ownedTurn = command.turnId ? this.store!.get<Turn>("turn", command.turnId) : undefined;
      if (session && (((command.operation === "createSession" || command.operation === "connectSession") && !session.activeTurnId) || (command.operation === "sendMessage" && ownedTurn && !terminal(ownedTurn.state) && session.activeTurnId === command.turnId))) {
        if (journal.result.status === "unknown" && command.operation === "sendMessage") session.runtimeState = "unknown";
        if (command.operation === "connectSession" || command.operation === "createSession") session.connectionState = journal.result.status === "unknown" ? "connecting" : "error";
        const turn = command.turnId ? this.store!.get<Turn>("turn", command.turnId) : undefined;
        if (turn) { turn.state = journal.result.status === "unknown" ? "unknown" : "error"; turn.error = journal.result.error; turn.observedAt = now(); if (terminal(turn.state)) session.activeTurnId = null; }
        this.emit(session, "operation_error", { commandId: command.commandId, operation: command.operation, error: journal.result.error }, turn, false);
      }
    } finally {
      this.inFlight.delete(command.commandId);
      this.store!.put("command", command.commandId, journal); this.send({ type: "result", result: journal.result });
    }
  }
  private async reconcileCommand(journal:Journal):Promise<void> {
    const command=journal.command,session=this.store!.get<Session>("session",command.sessionId);
    if(!session?.codexThreadId)return;
    let confirmed=false;
    if (["pauseSessionExecution","resumeSessionExecution"].includes(command.operation)) {
      confirmed = Boolean(this.store!.get("pauseResult",command.commandId));
    } else if(["sendMessage","steerTurn"].includes(command.operation)) {
      try {
        const page=await readSessionItems(session.codexThreadId,{codexHome:session.codexHome!,limit:500,signal:this.reads.signal});
        const item=page.items.find(record=>record.item.type === "userMessage" && record.item.clientId === command.commandId);
        confirmed=Boolean(item);
        const turn=command.turnId ? this.store!.get<Turn>("turn",command.turnId) : undefined;
        if(item && turn && !turn.codexTurnId){turn.codexTurnId=item.turnId;this.store!.put("turn",turn.turnId,turn);}
      } catch { /* Missing evidence keeps the original operation unknown; never resend it. */ }
    } else if(["answerQuestions","decideApproval"].includes(command.operation)) {
      const item=this.store!.get<NativeInteraction>("interaction",String(command.input.interactionId));
      confirmed=Boolean(item && item.requestId === command.input.requestId && ["delivered","resolved"].includes(item.status));
    } else if (command.operation === "appendSessionContext") {
      const saved = this.store!.get<SavedContext>("context",JSON.stringify([session.sessionId,command.input.contextId]));
      if (saved) {
        try {
          confirmed = saved.confirmed || await this.runtime.hasSessionContext(session.codexThreadId,session.codexHome!,saved.itemId,saved.nativeText);
          if (confirmed && !saved.confirmed) this.confirmContext(session,saved);
        } catch { /* An uncertain append is verified, never replayed. */ }
      }
    }
    if(confirmed){journal.result={commandId:command.commandId,status:"delivered",error:null};this.store!.put("command",command.commandId,journal);}
  }
  private async execute(command: Command): Promise<void> {
    command = {...command,input:validateInput(command.operation,command.input)};
    if (command.operation === "createSession") {
      const input = validateInput("createSession", command.input);
      if (command.input.hostId !== this.config.hostId) fail("INVALID_INPUT", "Session targets another host.");
      const timestamp = now();
      const session: Session = { sessionId: command.sessionId, hostId: this.config.hostId, workDir: typeof command.input.workDir === "string" ? command.input.workDir : null, codexThreadId: null,
        sessionConfig: { overrides: (input.sessionOptions ?? {}) as SessionOptions, resolved: null, ...(input.agentRef ? { agentRef: input.agentRef as AgentRef } : {}) },
        codexHome: await realpath(this.config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")),
        connectionState: "connecting", createdAt: timestamp, runtimeState: "unknown", observedAt: timestamp, lastKnownState: "unknown", lastKnownAt: timestamp, activeTurnId: null, latestCursor: 0 };
      this.store!.put("session", session.sessionId, session);
      if (input.workspaceProfileId) {
        session.workDir = await new Workspaces(this.config.workspaces).prepare(session, String(input.workspaceProfileId), () => this.emit(session, "workspace_updated", {}, undefined, false));
      }
      try {
        if (!session.workDir || !isAbsolute(session.workDir) || !(await stat(session.workDir)).isDirectory()) throw new Error("Invalid directory");
        await access(session.workDir, constants.R_OK | constants.W_OK | constants.X_OK); session.workDir = await realpath(session.workDir);
      } catch { fail("INVALID_WORKDIR", "Working directory must be an existing readable and writable absolute directory on this host."); }
      session.sessionConfig!.resolved = await resolveSessionConfig(this.runtime, session.workDir, session.sessionConfig!.overrides, this.config.model, Boolean(session.workspace));
      this.emit(session, "session_configured", {}, undefined, false);
      const result = await this.runtime.request("thread/start", { ...this.threadOptions(session),ephemeral:false,experimentalRawEvents:true });
      session.codexThreadId = result.thread.id; this.store!.put("session", session.sessionId, session);
      confirmSessionConfig(session.sessionConfig!.resolved!, result);
      this.rememberMode(session,result);
      if (result.cwd !== session.workDir) fail("RECOVERY_REQUIRED", "Codex did not retain the selected working directory.");
      session.runtimeState = "idle"; session.connectionState = "connected"; session.connectionConfirmedAt = now(); this.emit(session, "session_created"); return;
    }
    if (command.operation === "connectSession") {
      let session = this.store!.get<Session>("session", command.sessionId);
      if (session?.workspace) await new Workspaces(this.config.workspaces).verify(session);
      if (session?.activeTurnId) fail("SESSION_BUSY", "Session already has an active or unresolved turn.");
      if (session?.connectionState === "connected" && session.runtimeState !== "unknown") { this.emit(session, "session_connected"); return; }
      if (!session) {
        // Resolve the opaque management ID against fresh native metadata on this host.
        const snapshot = await this.discoverSessions({ sources: ["database"], signal: AbortSignal.timeout(20000) });
        const native = snapshot.sessions.find(s => `native:${createHash("sha256").update(JSON.stringify([this.config.hostId, s.codexHome, s.id])).digest("hex")}` === command.sessionId);
        if (!native?.workspace) fail("NOT_FOUND", "Native conversation or its working directory is unavailable.");
        const timestamp = now();
        session = { sessionId: command.sessionId, hostId: this.config.hostId, workDir: native.workspace, codexThreadId: native.id,
          sessionConfig: null,
          codexHome: native.codexHome, connectionState: "connecting", createdAt: native.createdAt === null ? timestamp : new Date(native.createdAt * 1000).toISOString(), runtimeState: "unknown",
          observedAt: timestamp, lastKnownState: "unknown", lastKnownAt: timestamp, activeTurnId: null, latestCursor: 0 };
        this.store!.put("session", session.sessionId, session);
      }
      const home = await realpath(this.config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
      if (session.codexHome !== home) fail("INVALID_INPUT", "Conversation belongs to a different Codex home.");
      if (session.sessionConfig?.resolved) await checkSavedModel(this.runtime, session.sessionConfig.resolved);
      const result = await this.runtime.connectSession(session.codexThreadId!, this.threadOptions(session));
      this.rememberMode(session,result);
      if (session.sessionConfig?.resolved) {
        confirmSessionConfig(session.sessionConfig.resolved, result);
        if (result.cwd !== session.workDir) fail("RECOVERY_REQUIRED", "Codex did not retain the saved working directory.");
      }
      if (result.thread.status?.type !== "idle") fail("SESSION_BUSY", "Codex conversation is not idle.");
      session.workDir = result.cwd; session.runtimeState = "idle"; session.connectionState = "connected"; session.connectionConfirmedAt = now();
      this.inventory = undefined; this.emit(session, "session_connected"); return;
    }
    const session = this.session(command.sessionId);
    if (command.operation === "pauseSessionExecution") {
      if (session.executionPause) fail("SESSION_PAUSED","The session already has an execution pause.");
      this.store!.transaction(()=>{
        this.store!.put("pause",session.sessionId,{pauseId:command.commandId,authority:command.authority,createdAt:now()} satisfies ExecutionPause);
        this.store!.put("pauseResult",command.commandId,true);
      });
      this.emit(session,"execution_paused"); return;
    }
    if (command.operation === "resumeSessionExecution") {
      const pause = session.executionPause;
      if (!pause || pause.pauseId !== command.input.pauseId) fail("STALE_PAUSE","The exact execution pause is no longer current.");
      if (command.input.force && command.authority !== "operator") fail("FORBIDDEN","Only the Core operator can force a resume.");
      if (pause.authority !== command.authority && !command.input.force) fail("FORBIDDEN","The pause belongs to a different authority class.");
      this.store!.transaction(()=>{this.store!.remove("pause",session.sessionId);this.store!.put("pauseResult",command.commandId,true);});
      this.emit(session,"execution_resumed"); return;
    }
    if (command.operation === "appendSessionContext") {
      const previous = this.contextWrites.get(session.sessionId) ?? Promise.resolve();
      const write = previous.catch(()=>{}).then(()=>this.appendContext(command));
      this.contextWrites.set(session.sessionId,write);
      try { await write; } finally { if (this.contextWrites.get(session.sessionId) === write) this.contextWrites.delete(session.sessionId); }
      return;
    }
    if (session.workspace && ["sendMessage", "steerTurn", "answerQuestions"].includes(command.operation)) await new Workspaces(this.config.workspaces).verify(session);
    if (!session.codexThreadId) fail("SESSION_NOT_READY", "Codex conversation has not been created.");
    if(command.authority!=="operator" && ["sendMessage","steerTurn","answerQuestions"].includes(command.operation) && this.privateConversation(session.codexThreadId))fail("FORBIDDEN","This conversation contains private operator input and requires the Core operator.");
    if (["sendMessage","steerTurn","answerQuestions","decideApproval"].includes(command.operation)) this.requireExecution(session.sessionId);
    if (command.operation === "sendMessage") {
      if (session.activeTurnId) fail("SESSION_BUSY", "Session already has an active or unresolved turn.");
      if (session.runtimeState === "unknown" || session.connectionState !== "connected") fail("RECOVERY_REQUIRED", "Conversation recovery is unresolved.");
      const turn: Turn = { turnId: command.turnId!, sessionId: session.sessionId, requestId: String(command.input.requestId), codexTurnId: null,
        mode:command.input.mode as Turn["mode"],state:"accepted",createdAt:now(),observedAt:now(),error:null };
      session.activeTurnId = turn.turnId;
      this.emit(session,"user_message",{text:String(command.input.message),clientId:command.commandId,requestId:command.input.requestId},turn,false);
      const settings = this.modeSettings.get(session.sessionId) ?? fail("RECOVERY_REQUIRED","The native model must be confirmed before starting a mode.");
      const result = await this.runtime.sendMessage(session.codexThreadId,String(command.input.message),{clientUserMessageId:command.commandId,collaborationMode:{mode:turn.mode,settings:{model:settings.model,reasoning_effort:settings.reasoningEffort,developer_instructions:null}}});
      const current = this.store!.get<Turn>("turn", turn.turnId)!;
      if (!terminal(current.state)) {
        const currentSession = this.session(session.sessionId);
        current.codexTurnId = result.turn.id;
        this.confirmTurnStarted(currentSession, current);
      }
    } else {
      if (session.activeTurnId !== command.turnId) fail("STALE_TURN", "Turn is no longer active.");
      const turn = this.store!.get<Turn>("turn", command.turnId!)!;
      if (!turn.codexTurnId) fail("DELIVERY_UNCERTAIN", "Codex turn reference is not confirmed.", true);
      if (command.operation === "interruptTurn") {
        await this.runtime.request("turn/interrupt", { threadId: session.codexThreadId, turnId: turn.codexTurnId });
        this.emit(this.session(session.sessionId), "interrupt_requested", {}, this.store!.get<Turn>("turn", turn.turnId)!);
      } else if (command.operation === "steerTurn") {
        const result = await this.runtime.steerTurn(session.codexThreadId,turn.codexTurnId,String(command.input.message),command.commandId);
        if (result.turnId !== turn.codexTurnId) fail("DELIVERY_UNCERTAIN","Native steering returned a different turn.",true);
        this.emit(this.session(session.sessionId),"user_message",{text:String(command.input.message),clientId:command.commandId,requestId:command.input.requestId,steering:true},this.store!.get<Turn>("turn",turn.turnId)!,false);
      } else if (command.operation === "decideApproval" || command.operation === "answerQuestions") {
        const interaction = this.store!.get<NativeInteraction>("interaction",String(command.input.interactionId));
        if (!interaction || interaction.sessionId !== session.sessionId || interaction.turnId !== turn.turnId || interaction.status !== "pending" || interaction.runtimeId !== this.runtimeId) fail("STALE_INTERACTION","Exact native interaction is no longer pending.");
        if (interaction.authority === "operator" && command.authority !== "operator") fail("FORBIDDEN","This native interaction requires the Core operator.");
        const scope=this.contentScope(session.codexHome!,session.codexThreadId),details=interactionDetails(interaction,scope,this.contents!);
        let response:unknown;
        if (command.operation === "answerQuestions") {
          if (interaction.kind !== "questions") fail("INVALID_INPUT","Interaction does not accept answers.");
          const answers=command.input.answers as import("@dewbow/core-protocol").QuestionAnswer[];validateAnswers(details,answers);
          response={answers:Object.fromEntries(answers.map(answer=>[answer.questionId,{answers:answer.answers}]))};
          const encoded=JSON.stringify({...details,answers});if(Buffer.byteLength(encoded)>1048576)fail("LIMIT_EXCEEDED","Answers exceed the private interaction limit.");
          if(interaction.authority === "operator"){interaction.sensitive=true;this.contents!.restrictScope(scope);}
          interaction.content=this.contents!.put(scope,interaction.interactionId,"output","Interaction details",encoded,"complete",interaction.sensitive ? "operator" : "agent");
        } else {
          if (interaction.kind !== "approval" || command.authority !== "operator") fail("FORBIDDEN","Only the Core operator can decide native approvals.");
          interaction.decision=command.input.decision as "allow"|"deny";response=approvalResponse(interaction,details,interaction.decision);
        }
        interaction.status="requested";interaction.requestId=String(command.input.requestId);interaction.observedAt=now();
        this.store!.put("interaction",interaction.interactionId,interaction);this.emit(session,"interaction_response_requested",{interaction:publicInteraction(interaction)},turn);
        this.runtime.respond(interaction.codexRequestId,response);
        const current=this.store!.get<NativeInteraction>("interaction",interaction.interactionId)!;
        if (!["resolved","invalidated"].includes(current.status)) {current.status="delivered";current.observedAt=now();this.store!.put("interaction",current.interactionId,current);}
        this.emit(this.session(session.sessionId),"interaction_response_delivered",{interaction:publicInteraction(current)},this.store!.get<Turn>("turn",turn.turnId)!);
      } else fail("INVALID_INPUT", "Unknown host command.");
    }
  }
  private confirmContext(session: Session, saved: SavedContext): void {
    saved.confirmed = true;
    this.store!.put("context",JSON.stringify([session.sessionId,saved.record.contextId]),saved);
    this.emit(this.session(session.sessionId),"context_appended",{contextId:saved.record.contextId,source:saved.record.source,segmentId:saved.record.segmentId});
  }
  private async appendContext(command: Command): Promise<void> {
    const session = this.session(command.sessionId);
    if (!session.codexThreadId || session.connectionState !== "connected" || session.runtimeState === "unknown") fail("SESSION_NOT_READY","Context append requires a connected, confirmed conversation.");
    if (session.activeTurnId) fail("SESSION_BUSY","Wait for the active turn to stop before appending context.");
    if (command.authority !== "operator" && this.privateConversation(session.codexThreadId)) fail("FORBIDDEN","This conversation requires the Core operator.");
    const {contextId,segmentId,source,text} = command.input;
    const key = JSON.stringify([session.sessionId,contextId]), fingerprint = canonicalJson([segmentId,source,text]);
    const existing = this.store!.get<SavedContext>("context",key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail("REQUEST_CONFLICT","Context ID was already used with different content.");
      if (existing.confirmed) return;
      if (await this.runtime.hasSessionContext(session.codexThreadId,session.codexHome!,existing.itemId,existing.nativeText)) { this.confirmContext(session,existing); return; }
      fail("DELIVERY_UNCERTAIN","The original context append has not been confirmed. Reconcile its original request.",true);
    }
    if (this.store!.list<SavedContext>("context").some(c=>c.record.sessionId===session.sessionId && !c.confirmed)) fail("DELIVERY_UNCERTAIN","Reconcile the earlier context append before adding another record.",true);
    const saved: SavedContext = {
      record:{contextId:String(contextId),sessionId:session.sessionId,segmentId:String(segmentId),source:source as SessionContext["source"],text:String(text),createdAt:now(),sequence:session.latestCursor+1,afterTurnId:this.store!.list<Turn>("turn").filter(t=>t.sessionId===session.sessionId && t.codexTurnId).at(-1)?.codexTurnId??null},
      fingerprint,itemId:`dewbow-context-${createHash("sha256").update(key).digest("hex")}`,
      nativeText:JSON.stringify({kind:"externalConversationHistory",contextId,segmentId,source,text}),confirmed:false,commandId:command.commandId,
    };
    const present = await this.runtime.hasSessionContext(session.codexThreadId,session.codexHome!,saved.itemId,saved.nativeText);
    if (!present) {
      if (this.session(session.sessionId).activeTurnId) fail("SESSION_BUSY","A turn started before context append.");
      this.store!.put("context",key,saved);
      await this.runtime.appendSessionContext(session.codexThreadId,saved.itemId,saved.nativeText);
    }
    if (!await this.runtime.hasSessionContext(session.codexThreadId,session.codexHome!,saved.itemId,saved.nativeText)) fail("DELIVERY_UNCERTAIN","Native context persistence has not been confirmed.",true);
    this.confirmContext(session,saved);
  }
  private rememberMode(session:Session,result:{model?:string;reasoningEffort?:string|null}):void {
    const saved=session.sessionConfig?.resolved,model=saved?.model??result.model,reasoningEffort=saved ? saved.reasoningEffort : result.reasoningEffort??null;
    if (!model) fail("RECOVERY_REQUIRED","Native model settings are unavailable.");
    this.modeSettings.set(session.sessionId,{model,reasoningEffort});
  }
  private threadOptions(session: Session): import("@dewbow/core-sdk").ConnectSessionOptions {
    if (session.sessionConfig === undefined || (session.sessionConfig !== null && !session.sessionConfig.resolved)) fail("RECOVERY_REQUIRED", "Session configuration snapshot is missing. Start with fresh Dewbow state.");
    if (session.sessionConfig) return sessionThreadOptions(session.workDir!, session.sessionConfig.resolved!);
    // Native adoption has no Team definition. Preserve its native model and instructions.
    return { cwd: session.workDir!, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" };
  }
  private confirmTurnStarted(session: Session, turn: Turn): void {
    // The RPC response and notification confirm the same start in either order.
    if (turn.state !== "accepted" && turn.state !== "unknown") {
      this.store!.put("turn", turn.turnId, turn); return;
    }
    turn.state = "running"; turn.observedAt = now(); session.runtimeState = "running";
    this.emit(session, "turn_started", {}, turn);
  }
  private notification(message: RpcMessage): void {
    if (!this.store || this.stopping) return;
    const params = message.params ?? {};
    const resolved = message.method === "serverRequest/resolved" ? this.store.list<NativeInteraction>("interaction").filter(item=>item.runtimeId === this.runtimeId && item.codexRequestId === params.requestId && (!params.threadId || this.store!.get<Session>("session",item.sessionId)?.codexThreadId === params.threadId)) : [];
    const session = this.store.list<Session>("session").find(s=>s.codexThreadId === params.threadId) ?? (resolved.length===1 ? this.store.get<Session>("session",resolved[0]!.sessionId) : undefined);
    if (!session) { if (message.id !== undefined) this.runtime.reject(message.id); return; }
    const turn = session.activeTurnId ? this.store.get<Turn>("turn", session.activeTurnId) : undefined;
    if (message.method === "serverRequest/resolved") {
      const interaction = resolved.length===1 ? resolved[0] : undefined;
      if (interaction && !["resolved","invalidated"].includes(interaction.status)) {
        interaction.status="resolved";interaction.observedAt=now();this.store.put("interaction",interaction.interactionId,interaction);
        if (turn && !terminal(turn.state)) this.waitingState(session,turn);
        this.emit(session,"interaction_resolved",{interaction:publicInteraction(interaction)},turn);
      }
      return;
    }
    if (!turn || terminal(turn.state)) { if (message.id !== undefined) this.runtime.reject(message.id); return; }
    const codexTurnId = params.turnId ?? params.turn?.id;
    if(!turn.codexTurnId && typeof codexTurnId === "string" && this.store.list<Turn>("turn").some(previous=>previous.sessionId===session.sessionId && previous.turnId!==turn.turnId && previous.codexTurnId===codexTurnId)) {
      if(message.id!==undefined)this.runtime.reject(message.id);return;
    }
    if (codexTurnId && turn.codexTurnId && turn.codexTurnId !== codexTurnId) return;
    if (codexTurnId && !turn.codexTurnId) turn.codexTurnId = String(codexTurnId);
    if (message.method === "rawResponseItem/completed") {
      const item=params.item;
      if(typeof params.turnId !== "string" || params.turnId!==turn.codexTurnId)return;
      if (item?.type === "function_call" && typeof item.call_id === "string") {
        const key=JSON.stringify([session.codexThreadId,turn.codexTurnId,item.call_id]),previous=this.toolOrigins.get(key);
        const next=typeof item.name === "string" && (item.namespace==null || typeof item.namespace === "string") ? {name:item.name,namespace:item.namespace??null} : null;
        const origin=this.toolOrigins.has(key) && (previous===null || !next || previous!.name!==next.name || previous!.namespace!==next.namespace) ? null : next;
        this.toolOrigins.set(key,origin);
        for(const question of this.store.list<NativeInteraction>("interaction").filter(value=>value.sessionId===session.sessionId && value.turnId===turn.turnId && value.itemId===item.call_id && value.kind === "questions" && value.status === "pending")) this.confirmQuestionOrigin(session,turn,question,origin);
      }
      return;
    }
    if (message.id !== undefined) {
      if(typeof params.turnId!=="string" || params.turnId!==turn.codexTurnId){this.runtime.reject(message.id);return;}
      const scope=this.contentScope(session.codexHome!,session.codexThreadId!),origin=this.toolOrigins.get(JSON.stringify([session.codexThreadId,turn.codexTurnId,params.itemId]));
      let interaction:NativeInteraction;
      try{interaction=createInteraction(session,turn,this.redact(message) as RpcMessage,scope,this.contents!,this.runtimeId,origin??undefined);}
      catch(error){if(!(error instanceof ManagementError) || error.detail.code!=="LIMIT_EXCEEDED")throw error;interaction=createInteraction(session,turn,{id:message.id,method:"unsupported/oversizedInteraction",params:{threadId:params.threadId,turnId:params.turnId,itemId:params.itemId}},scope,this.contents!,this.runtimeId);}
      this.store.put("interaction", interaction.interactionId, interaction);
      if(interaction.sensitive)this.contents!.restrictScope(scope);
      this.waitingState(session,turn);
      this.emit(session,"interaction_requested",{interaction:{...publicInteraction(interaction),details:interactionDetails(interaction,scope,this.contents!)}},turn);
      if (interaction.kind === "questions" && interaction.authority === "operator" && origin===undefined) void this.refreshQuestionOrigin(session,turn,interaction);
      return;
    }
    if (message.method === "turn/started") {
      this.confirmTurnStarted(session, turn);
    } else if (message.method === "turn/completed") {
      const status = params.turn?.status;
      if (!["completed", "interrupted", "failed"].includes(status)) return;
      turn.state = status === "failed" ? "error" : status; turn.observedAt = now();
      turn.error = status === "failed" ? { code: "EXECUTION_FAILED", message: "Codex reported a failed turn. Inspect local Codex configuration and retry after recovery.", retryable: false } : null;
      session.activeTurnId = null; session.runtimeState = turn.state === "completed" ? "idle" : turn.state as "error" | "interrupted";
      this.invalidate(turn); this.emit(session, "turn_completed", {}, turn);
    } else if (message.method === "item/agentMessage/delta") this.emit(session, "assistant_delta", { itemId: params.itemId, text: params.delta }, turn);
    else if (message.method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
      const key = JSON.stringify([session.sessionId,turn.turnId,params.itemId]);
      const id = this.outputCapture.get(key);
      if (id) this.contents!.appendCapture(this.contentScope(session.codexHome!,session.codexThreadId!),id,params.delta);
    }
    else if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item;
      if (!item || item.type === "userMessage" || item.type === "reasoning") return;
      const payload: Record<string, unknown> = { itemId: item.id, itemType: item.type, stage: message.method === "item/started" ? "started" : "completed" };
      if (item.type === "agentMessage") { payload.text = item.text; payload.phase = item.phase; }
      if (item.type === "commandExecution") { payload.command = item.command; payload.cwd = item.cwd; payload.status = item.status; payload.exitCode = item.exitCode; }
      if (item.type === "fileChange") { payload.status = item.status; payload.paths = item.changes?.map((c: { path: string }) => c.path); }
      if (item.type === "mcpToolCall") { payload.server = item.server; payload.tool = item.tool; payload.status = item.status; }
      if (item.type === "plan") payload.text = item.text;
      if (!["agentMessage","plan"].includes(item.type)) {
        const key = JSON.stringify([session.sessionId,turn.turnId,item.id]);
        const scope = this.contentScope(session.codexHome!,session.codexThreadId!);
        if (message.method === "item/started" && item.type === "commandExecution" && !this.outputCapture.has(key)) this.outputCapture.set(key,this.contents!.startCapture(scope,item.id).contentId!);
        const capture = this.outputCapture.get(key), finished = message.method === "item/completed" && ["completed","failed","declined"].includes(item.status);
        const protectedTurn=this.privateConversation(session.codexThreadId!);
        if(capture && protectedTurn)this.contents!.restrict(scope,capture);
        let capturedRef = capture ? this.contents!.captureRef(scope,capture) : undefined;
        if (capture && finished && (capturedRef!.byteLength! > 0 || item.aggregatedOutput === "")) capturedRef = this.contents!.finishCapture(scope,capture);
        const projected = projectItem({ id:item.id,turnId:turn.codexTurnId ?? "",ordinal:session.latestCursor+1,updatedOrdinal:session.latestCursor+1,completedAtMs:message.method === "item/completed" ? Date.now() : null,createdAtMs:Date.now(),turnStatus:turn.state,item,itemJson:JSON.stringify(item) },scope,this.contents!,true,protectedTurn ? "operator" : "agent");
        if (projected.activity) {
          projected.activity.ordinal = null;
          projected.activity.updatedOrdinal = null;
          if (capturedRef && (!finished || capturedRef.completeness === "complete")) projected.activity.contents = [capturedRef];
          payload.activity = this.contents!.saveActivity(scope,projected.activity);
        }
        if (finished) this.outputCapture.delete(key);
      }
      this.emit(session, item.type === "agentMessage" ? "assistant_message" : "tool_activity", payload, turn);
    } else if (message.method === "turn/plan/updated") this.emit(session, "progress", { plan: params.plan, explanation: params.explanation ?? null }, turn);
  }
  private waitingState(session:Session,turn:Turn):void {
    const pending=this.store!.list<NativeInteraction>("interaction").filter(item=>item.turnId===turn.turnId && item.blocking && !["resolved","invalidated"].includes(item.status));
    const state=pending.some(item=>item.kind!=="questions") ? "awaiting_approval" : pending.length ? "awaiting_input" : "running";
    turn.state=state;turn.observedAt=now();session.runtimeState=state;
  }
  private confirmQuestionOrigin(session:Session,turn:Turn,interaction:NativeInteraction,origin:{name:string;namespace:string|null}|null):void {
    const scope=this.contentScope(session.codexHome!,session.codexThreadId!),details=interactionDetails(interaction,scope,this.contents!);
    interaction.authority=builtinQuestion(origin) && !interaction.sensitive && details.questions?.length ? "agent" : "operator";interaction.observedAt=now();this.store!.put("interaction",interaction.interactionId,interaction);
    this.emit(session,"interaction_updated",{interaction:publicInteraction(interaction)},turn);
  }
  private async refreshQuestionOrigin(session:Session,turn:Turn,interaction:NativeInteraction):Promise<void> {
    try {
      // Rollout ownership is not provenance if the active sandbox may write it.
      const overlap=relative(session.workDir!,session.codexHome!);
      if((!isAbsolute(overlap) && overlap!==".." && !overlap.startsWith(`..${sep}`)) || !session.sessionConfig?.resolved || session.sessionConfig.resolved.sandbox.type!=="workspaceWrite" || session.sessionConfig.resolved.sandbox.writableRoots.length)return;
      const sandbox=session.sessionConfig.resolved.sandbox;
      for(const root of [...(!sandbox.excludeTmpdirEnvVar ? [tmpdir()] : []),...(!sandbox.excludeSlashTmp && process.platform!=="win32" ? ["/tmp"] : [])]) {
        const canonical=await realpath(root),path=relative(canonical,session.codexHome!);
        if(!isAbsolute(path) && path!==".." && !path.startsWith(`..${sep}`))return;
      }
      if(this.store!.list<NativeInteraction>("interaction").some(item=>item.turnId===turn.turnId && item.kind === "approval" && item.decision === "allow"))return;
      const origin=await readSessionToolOrigin(session.codexThreadId!,turn.codexTurnId!,interaction.itemId!,{codexHome:session.codexHome!,signal:this.reads.signal});
      if(!origin || !this.store || this.stopping)return;
      const current=this.store.get<NativeInteraction>("interaction",interaction.interactionId),active=this.store.get<Turn>("turn",turn.turnId);
      const key=JSON.stringify([session.codexThreadId,turn.codexTurnId,interaction.itemId]);
      const granted=this.store.list<NativeInteraction>("interaction").some(item=>item.turnId===turn.turnId && item.kind === "approval" && item.decision === "allow");
      if(!granted && !this.toolOrigins.has(key) && current?.status === "pending" && active && !terminal(active.state) && this.session(session.sessionId).activeTurnId===turn.turnId) this.confirmQuestionOrigin(this.session(session.sessionId),active,current,origin);
    } catch { /* An unverified native origin stays restricted to the Core operator. */ }
  }
  private invalidate(turn: Turn): void {
    for (const key of this.outputCapture.keys()) if (JSON.parse(key)[1] === turn.turnId) this.outputCapture.delete(key);
    for (const key of this.toolOrigins.keys()) if (JSON.parse(key)[1] === turn.codexTurnId) this.toolOrigins.delete(key);
    for (const interaction of this.store!.list<NativeInteraction>("interaction")) if (interaction.turnId === turn.turnId && interaction.status !== "resolved") {
      interaction.status = "invalidated"; this.store!.put("interaction", interaction.interactionId, interaction);
    }
  }
  private runtimeClosed(): void {
    if (!this.store || this.stopping) return;
    for (const session of this.store.list<Session>("session")) if (session.activeTurnId) {
      const turn = this.store.get<Turn>("turn", session.activeTurnId)!;
      turn.state = "unknown"; turn.observedAt = now(); session.runtimeState = "unknown";
      this.emit(session, "runtime_closed", { error: { code: "RECOVERY_REQUIRED", message: "Runtime closed. Restart the daemon after verifying its recorded process has stopped.", retryable: false } }, turn);
    }
    this.ready = false; this.socket?.terminate();
    this.stopping = true; clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    console.error(JSON.stringify({ component: "host-daemon", status: "runtime_closed" }));
    setImmediate(() => { this.onRuntimeFailure(); void this.stop(); });
  }
  private async recover(): Promise<void> {
    // A crash can occur after journaling a send but before recording its turn.
    for (const journal of this.store!.list<Journal>("command")) {
      const command = journal.command;
      if (journal.result.status !== "unknown" || command.operation !== "sendMessage" || !command.turnId || this.store!.get("turn", command.turnId)) continue;
      const session = this.session(command.sessionId);
      const turn: Turn = { turnId: command.turnId, sessionId: command.sessionId, requestId: String(command.input.requestId), codexTurnId: null,
        mode:command.input.mode as Turn["mode"],state:"unknown",createdAt:now(),observedAt:now(),error:null };
      this.store!.put("turn", turn.turnId, turn); session.activeTurnId = turn.turnId; session.runtimeState = "unknown";
      this.store!.put("session", session.sessionId, session);
    }
    for (const session of this.store!.list<Session>("session")) {
      if (session.hostId !== this.config.hostId) fail("RECOVERY_REQUIRED", "Host state belongs to a different configured identity.");
      if (!session.codexThreadId || (!session.connectionConfirmedAt && !session.activeTurnId)) continue;
      const active = session.activeTurnId ? this.store!.get<Turn>("turn", session.activeTurnId) : undefined;
      try {
        if (session.workspace) await new Workspaces(this.config.workspaces).verify(session);
        if (session.sessionConfig?.resolved) await checkSavedModel(this.runtime, session.sessionConfig.resolved);
        const result = await this.runtime.connectSession(session.codexThreadId, { ...this.threadOptions(session), excludeTurns: false });
        this.rememberMode(session,result);
        if (session.sessionConfig?.resolved) {
          confirmSessionConfig(session.sessionConfig.resolved, result);
          if (result.cwd !== session.workDir) fail("RECOVERY_REQUIRED", "Codex did not retain the saved working directory.");
        }
        const latest = result.thread.turns?.at(-1);
        if (result.thread.status?.type === "active") fail("RECOVERY_REQUIRED", "Codex still reports active execution.");
        session.connectionState = "connected"; session.connectionConfirmedAt = now();
        if (active) {
          if (latest?.id === active.codexTurnId && ["completed", "interrupted", "failed"].includes(latest.status)) {
            active.state = latest.status === "failed" ? "error" : latest.status as "completed" | "interrupted";
          } else active.state = "interrupted";
          active.observedAt = now(); active.error = active.state === "error" ? { code: "EXECUTION_FAILED", message: "Saved Codex turn failed.", retryable: false } : null;
          session.activeTurnId = null; session.runtimeState = active.state === "completed" ? "idle" : active.state as "error" | "interrupted";
          this.invalidate(active); this.emit(session, "recovery_confirmed", { reason: "Previous owned processes are stopped; conversation resumed without starting a turn." }, active);
        } else { session.runtimeState = "idle"; this.emit(session, "conversation_restored"); }
      } catch {
        session.runtimeState = "unknown";
        if (session.connectionState) session.connectionState = "error";
        if (active) { active.state = "unknown"; active.observedAt = now(); this.invalidate(active); }
        this.emit(session, "recovery_required", { error: { code: "RECOVERY_REQUIRED", message: "Saved Codex conversation could not be restored. Inspect it locally before continuing.", retryable: false } }, active);
      }
    }
  }
  async stop(): Promise<void> {
    this.reads.abort();
    this.stopping = true; this.ready = false; clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    this.socket?.terminate();
    await this.runtime.stop();
    this.contents?.close(); this.contents = undefined; this.outputCapture.clear();
    if (this.store) {
      if (this.ownsStore) this.store.put("meta", "owner", { daemonPid: null, runtimePid: null });
      this.store.close(); this.store = undefined;
    }
  }
}
function alive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
