import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
import { discoverSessions, readSessionHistory, SessionHistoryError } from "@dewbow/core-sdk";
import type { DiscoverOptions, DiscoverySnapshot, ReadSessionHistoryOptions } from "@dewbow/core-sdk";
import { canonicalJson, fail, LiveReplies, ManagementError, now, terminal, validateInput } from "@dewbow/core-protocol";
import type { AgentRef, Approval, Command, Event, EventHistory, HostQuery, HostReport, NativeHistory, NativeInventory, OperationResult, Session, SessionOptions, Turn, ToHost, ToControlPlane } from "@dewbow/core-protocol";
import { Store } from "@dewbow/core-protocol/store";
import type { HostDaemonConfig } from "./config.js";
import { Runtime } from "./runtime.js";
import type { RpcMessage } from "./runtime.js";
import { checkSavedModel, confirmSessionConfig, resolveSessionConfig, sessionThreadOptions } from "./session-config.js";

interface Journal { command: Command; fingerprint: string; result: OperationResult }
export class HostDaemon {
  private store: Store | undefined;
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
  private session(id: string): Session { return this.store!.get<Session>("session", id) ?? fail("NOT_FOUND", "Managed session not found.", false, { sessionId: id }); }
  private emit(session: Session, type: string, payload: Record<string, unknown> = {}, turn?: Turn, observation = true): void {
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
    return { sessions: this.store!.list<Session>("session"), turns: this.store!.list<Turn>("turn"), approvals: this.store!.list<Approval>("approval"), operations: this.store!.list<Journal>("command").map(j => j.result) };
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
      let result: NativeInventory | NativeHistory | EventHistory;
      if (query.operation === "discoverSessions") {
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
        result = { events: events.slice(0, limit), nextCursor: events.slice(0, limit).at(-1)?.cursor ?? cursor,
          hasMore: events.length > limit, liveMessages: this.liveReplies.get(session.sessionId) };
      } else if (query.operation === "readSessionHistory") {
        const queryHome = query.input.codexHome ? await realpath(query.input.codexHome).catch(() => query.input.codexHome!) : undefined;
        try {
          const page = await readSessionHistory(query.input.codexThreadId!, { ...(queryHome ? { codexHome: queryHome } : this.config.codexHome ? { codexHome: this.config.codexHome } : {}),
            limit: query.input.limit ?? 100, ...(query.input.messageCursor ? { cursor: query.input.messageCursor } : {}) });
          result = { observedAt: page.observedAt, nextCursor: page.nextCursor, messages: page.messages.map(m => ({ id: m.id, turnId: m.turnId,
            role: m.role, text: m.text, phase: m.phase, createdAt: new Date(m.createdAtMs).toISOString(), turnStatus: m.turnStatus })) };
        } catch (cause) {
          const session = this.store!.list<Session>("session").find(s => s.codexThreadId === query.input.codexThreadId
            && (!queryHome || (process.platform === "win32" ? s.codexHome?.toLowerCase() === queryHome.toLowerCase() : s.codexHome === queryHome)));
          // Codex may not index a newly created conversation until its first turn.
          if (!(cause instanceof SessionHistoryError) || cause.code !== "SESSION_NOT_FOUND" || query.input.messageCursor
            || !session?.sessionConfig?.resolved || session.connectionState !== "connected" || session.runtimeState !== "idle"
            || this.store!.list<Turn>("turn").some(turn => turn.sessionId === session.sessionId)) throw cause;
          result = { observedAt: now(), nextCursor: null, messages: [] };
        }
      } else fail("INVALID_INPUT", "Unknown host query.");
      if (query.operation === "readSessionHistory") {
        const session = this.store!.list<Session>("session").find(s => s.codexThreadId === query.input.codexThreadId);
        if (session) this.liveReplies.saved(session.sessionId, (result as NativeHistory).messages);
      }
      this.send({ type: "query_result", response: { queryId: query.queryId, result: this.redact(result) as NativeInventory | NativeHistory | EventHistory } });
    } catch (cause) {
      const code = cause instanceof ManagementError ? cause.detail.code : typeof (cause as { code?: unknown })?.code === "string" ? String((cause as { code: string }).code) : "READ_FAILED";
      this.send({ type: "query_result", response: { queryId: query.queryId, error: { code, message: query.operation === "discoverSessions" ? "Native conversation discovery failed." : query.operation === "readEvents" ? "Host event history could not be read." : "Native saved messages could not be read.", retryable: true } } });
    }
  }
  private async command(command: Command): Promise<void> {
    const fingerprint = createHash("sha256").update(canonicalJson([command.operation, command.sessionId, command.turnId, command.input])).digest("hex");
    const previous = this.store!.get<Journal>("command", command.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) this.send({ type: "result", result: { commandId: command.commandId, status: "error", error: { code: "REQUEST_CONFLICT", message: "Daemon command input conflict.", retryable: false } } });
      else if (!this.inFlight.has(command.commandId)) this.send({ type: "result", result: previous.result });
      return;
    }
    const { message: _message, ...metadata } = command.input;
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
  private async execute(command: Command): Promise<void> {
    if (command.operation === "createSession") {
      const input = validateInput("createSession", command.input);
      if (command.input.hostId !== this.config.hostId) fail("INVALID_INPUT", "Session targets another host.");
      const timestamp = now();
      const session: Session = { sessionId: command.sessionId, hostId: this.config.hostId, workDir: String(command.input.workDir), codexThreadId: null,
        sessionConfig: { overrides: (input.sessionOptions ?? {}) as SessionOptions, resolved: null, ...(input.agentRef ? { agentRef: input.agentRef as AgentRef } : {}) },
        codexHome: await realpath(this.config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")),
        connectionState: "connecting", createdAt: timestamp, runtimeState: "unknown", observedAt: timestamp, lastKnownState: "unknown", lastKnownAt: timestamp, activeTurnId: null, latestCursor: 0 };
      this.store!.put("session", session.sessionId, session);
      try {
        if (!isAbsolute(session.workDir) || !(await stat(session.workDir)).isDirectory()) throw new Error("Invalid directory");
        await access(session.workDir, constants.R_OK | constants.W_OK | constants.X_OK); session.workDir = await realpath(session.workDir);
      } catch { fail("INVALID_WORKDIR", "Working directory must be an existing readable and writable absolute directory on this host."); }
      session.sessionConfig!.resolved = await resolveSessionConfig(this.runtime, session.workDir, session.sessionConfig!.overrides, this.config.model);
      this.emit(session, "session_configured", {}, undefined, false);
      const result = await this.runtime.request("thread/start", { ...this.threadOptions(session), ephemeral: false });
      session.codexThreadId = result.thread.id; this.store!.put("session", session.sessionId, session);
      confirmSessionConfig(session.sessionConfig!.resolved!, result);
      if (result.cwd !== session.workDir) fail("RECOVERY_REQUIRED", "Codex did not retain the selected working directory.");
      session.runtimeState = "idle"; session.connectionState = "connected"; session.connectionConfirmedAt = now(); this.emit(session, "session_created"); return;
    }
    if (command.operation === "connectSession") {
      let session = this.store!.get<Session>("session", command.sessionId);
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
      if (session.sessionConfig?.resolved) {
        confirmSessionConfig(session.sessionConfig.resolved, result);
        if (result.cwd !== session.workDir) fail("RECOVERY_REQUIRED", "Codex did not retain the saved working directory.");
      }
      if (result.thread.status?.type !== "idle") fail("SESSION_BUSY", "Codex conversation is not idle.");
      session.workDir = result.cwd; session.runtimeState = "idle"; session.connectionState = "connected"; session.connectionConfirmedAt = now();
      this.inventory = undefined; this.emit(session, "session_connected"); return;
    }
    const session = this.session(command.sessionId);
    if (!session.codexThreadId) fail("SESSION_NOT_READY", "Codex conversation has not been created.");
    if (command.operation === "sendMessage") {
      if (session.activeTurnId) fail("SESSION_BUSY", "Session already has an active or unresolved turn.");
      if (session.runtimeState === "unknown" || session.connectionState !== "connected") fail("RECOVERY_REQUIRED", "Conversation recovery is unresolved.");
      const turn: Turn = { turnId: command.turnId!, sessionId: session.sessionId, requestId: String(command.input.requestId), codexTurnId: null,
        state: "accepted", createdAt: now(), observedAt: now(), error: null };
      session.activeTurnId = turn.turnId;
      this.emit(session, "user_message", { text: String(command.input.message) }, turn, false);
      const result = await this.runtime.sendMessage(session.codexThreadId, String(command.input.message));
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
      } else if (command.operation === "decideApproval") {
        const approval = this.store!.get<Approval>("approval", String(command.input.approvalId));
        if (!approval || approval.sessionId !== session.sessionId || approval.turnId !== turn.turnId || approval.status !== "pending") fail("STALE_APPROVAL", "Exact approval request is no longer pending.");
        approval.decision = command.input.decision as "allow" | "deny"; approval.decidedAt = now(); approval.status = "requested";
        this.store!.put("approval", approval.approvalId, approval); this.emit(session, "approval_decision_requested", { approval }, turn);
        this.runtime.respond(approval.codexRequestId, { decision: approval.decision === "allow" ? "accept" : "decline" });
        approval.status = "delivered"; this.store!.put("approval", approval.approvalId, approval);
        this.emit(this.session(session.sessionId), "approval_decision_delivered", { approval }, this.store!.get<Turn>("turn", turn.turnId)!);
      } else fail("INVALID_INPUT", "Unknown host command.");
    }
  }
  private threadOptions(session: Session): import("@dewbow/core-sdk").ConnectSessionOptions {
    if (session.sessionConfig === undefined || (session.sessionConfig !== null && !session.sessionConfig.resolved)) fail("RECOVERY_REQUIRED", "Session configuration snapshot is missing. Start with fresh Dewbow state.");
    if (session.sessionConfig) return sessionThreadOptions(session.workDir, session.sessionConfig.resolved!);
    // Native adoption has no Team definition. Preserve its native model and instructions.
    return { cwd: session.workDir, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" };
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
    const session = this.store.list<Session>("session").find(s => s.codexThreadId === params.threadId);
    if (!session) { if (message.id !== undefined) this.runtime.reject(message.id); return; }
    const turn = session.activeTurnId ? this.store.get<Turn>("turn", session.activeTurnId) : undefined;
    if (message.method === "serverRequest/resolved") {
      const approval = this.store.list<Approval>("approval").find(a => a.sessionId === session.sessionId && a.codexRequestId === params.requestId && (a.status === "pending" || a.status === "delivered" || a.status === "requested"));
      if (approval) {
        approval.status = "resolved"; this.store.put("approval", approval.approvalId, approval);
        if (turn && !terminal(turn.state)) { turn.state = "running"; turn.observedAt = now(); session.runtimeState = "running"; }
        this.emit(session, "approval_resolved", { approval }, turn);
      }
      return;
    }
    if (!turn || terminal(turn.state)) { if (message.id !== undefined) this.runtime.reject(message.id); return; }
    const codexTurnId = params.turnId ?? params.turn?.id;
    if (codexTurnId && turn.codexTurnId && turn.codexTurnId !== codexTurnId) return;
    if (codexTurnId && !turn.codexTurnId) turn.codexTurnId = String(codexTurnId);
    if (message.id !== undefined) {
      if (message.method !== "item/commandExecution/requestApproval" && message.method !== "item/fileChange/requestApproval") {
        this.runtime.reject(message.id); this.emit(session, "unsupported_request", { method: message.method }, turn); return;
      }
      const action = this.redact({ kind: message.method, command: params.command ?? null, cwd: params.cwd ?? session.workDir, reason: params.reason ?? null,
        itemId: params.itemId, grantRoot: params.grantRoot ?? null }) as Record<string, unknown>;
      const approval: Approval = { approvalId: randomUUID(), sessionId: session.sessionId, turnId: turn.turnId, codexRequestId: message.id,
        action, status: "pending", decision: null, decidedAt: null };
      this.store.put("approval", approval.approvalId, approval);
      turn.state = "awaiting_approval"; turn.observedAt = now(); session.runtimeState = "awaiting_approval";
      this.emit(session, "approval_requested", { approval }, turn); return;
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
    else if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item;
      if (!item || item.type === "userMessage" || item.type === "reasoning") return;
      const payload: Record<string, unknown> = { itemId: item.id, itemType: item.type, stage: message.method === "item/started" ? "started" : "completed" };
      if (item.type === "agentMessage") { payload.text = item.text; payload.phase = item.phase; }
      if (item.type === "commandExecution") { payload.command = item.command; payload.cwd = item.cwd; payload.status = item.status; payload.exitCode = item.exitCode; }
      if (item.type === "fileChange") { payload.status = item.status; payload.paths = item.changes?.map((c: { path: string }) => c.path); }
      if (item.type === "mcpToolCall") { payload.server = item.server; payload.tool = item.tool; payload.status = item.status; }
      if (item.type === "plan") payload.text = item.text;
      this.emit(session, item.type === "agentMessage" ? "assistant_message" : "tool_activity", payload, turn);
    } else if (message.method === "turn/plan/updated") this.emit(session, "progress", { plan: params.plan, explanation: params.explanation ?? null }, turn);
  }
  private invalidate(turn: Turn): void {
    for (const approval of this.store!.list<Approval>("approval")) if (approval.turnId === turn.turnId && approval.status !== "resolved") {
      approval.status = "invalidated"; this.store!.put("approval", approval.approvalId, approval);
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
        state: "unknown", createdAt: now(), observedAt: now(), error: null };
      this.store!.put("turn", turn.turnId, turn); session.activeTurnId = turn.turnId; session.runtimeState = "unknown";
      this.store!.put("session", session.sessionId, session);
    }
    for (const session of this.store!.list<Session>("session")) {
      if (session.hostId !== this.config.hostId) fail("RECOVERY_REQUIRED", "Host state belongs to a different configured identity.");
      if (!session.codexThreadId || (!session.connectionConfirmedAt && !session.activeTurnId)) continue;
      const active = session.activeTurnId ? this.store!.get<Turn>("turn", session.activeTurnId) : undefined;
      try {
        if (session.sessionConfig?.resolved) await checkSavedModel(this.runtime, session.sessionConfig.resolved);
        const result = await this.runtime.connectSession(session.codexThreadId, { ...this.threadOptions(session), excludeTurns: false });
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
