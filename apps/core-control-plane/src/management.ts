import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, fail, LiveReplies, ManagementError, now, terminal, validateInput } from "@dewbow-core/protocol";
import type { AgentRef, Approval, Command, Event, EventHistory, Host, HostQuery, HostReport, ManagementErrorData, NativeHistory, NativeInventory, NativeSession, Operation, OperationResult, Session, SessionOptions, SessionSummary, Turn } from "@dewbow-core/protocol";
import { Store } from "@dewbow-core/protocol/store";

export interface Caller { id: string; operator: boolean }
export class Management {
  dispatch: (hostId: string, command: Command) => void = () => {};
  query: (hostId: string, operation: HostQuery["operation"], input: HostQuery["input"]) => Promise<unknown> = async () => fail("HOST_UNAVAILABLE", "Host reads are unavailable.", true);
  private readonly inventories = new Map<string, NativeInventory>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly discoveryErrors = new Map<string, ManagementErrorData>();
  private readonly pendingInputs = new Map<string, Record<string, unknown>>();
  private readonly liveReplies = new LiveReplies();
  constructor(readonly store: Store) {
    for (const host of store.list<Host>("host")) this.disconnect(host.hostId);
    for (const op of store.list<Operation>("operation")) if (op.status === "accepted") this.uncertain(op);
  }
  session(id: string): Session { return this.store.get<Session>("session", id) ?? fail("NOT_FOUND", "Session not found.", false, { sessionId: id }); }
  available(hostId: string): void {
    if (this.store.get<Host>("host", hostId)?.status !== "connected") fail("HOST_UNAVAILABLE", "Host is unavailable. Reconnect and reconcile before sending commands.", true);
  }
  call(name: string, raw: unknown, caller: Caller): unknown {
    const input = validateInput(name, raw);
    if (name === "listHosts") return { hosts: this.store.list<Host>("host") };
    if (name === "listSessions") return this.list(input.hostId as string | undefined);
    if (name === "getSession") return this.get(String(input.sessionId));
    if (name === "readSessionHistory") return this.history(input);
    if (name === "connectSession") return this.connect(input, caller);
    return this.mutate(name, input, caller);
  }
  private mutate(name: string, input: Record<string, unknown>, caller: Caller, source?: SessionSummary): unknown {
    if (name === "decideApproval" && !caller.operator) fail("FORBIDDEN", "Only the Web operator can decide approvals.");
    if (name !== "connectSession" && typeof input.sessionId === "string" && input.sessionId.startsWith("native:") && !this.store.get("session", input.sessionId)) fail("SESSION_NOT_CONNECTED", "Connect this native conversation before sending commands.");
    const requestId = String(input.requestId ?? input.approvalId);
    const commandId = hash(JSON.stringify([caller.id, name, requestId]));
    const fingerprint = hash(canonicalJson(input));
    const existing = this.store.get<Operation>("operation", commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail("REQUEST_CONFLICT", "Request ID was already used with different input.", false, { sessionId: existing.sessionId, ...(existing.turnId ? { turnId: existing.turnId } : {}) });
      if (existing.operation === "sendMessage" && (existing.status === "unknown" || existing.status === "accepted")) {
        const session = this.session(existing.sessionId);
        this.available(session.hostId);
        this.pendingInputs.set(commandId, input);
        if (!session.activeTurnId && existing.turnId && !terminal(this.store.get<Turn>("turn", existing.turnId)!.state)) {
          session.activeTurnId = existing.turnId; session.runtimeState = "unknown";
          this.store.put("session", session.sessionId, session);
        }
        this.dispatch(session.hostId, { ...existing, input });
      }
      return publicOperation(existing);
    }
    let session: Session;
    let turnId: string | null = null;
    if (name === "connectSession" && source) {
      this.available(source.hostId);
      const timestamp = now();
      session = { sessionId: source.sessionId, hostId: source.hostId, workDir: source.workDir!, codexThreadId: source.codexThreadId,
        sessionConfig: null,
        codexHome: source.native!.codexHome, connectionState: "connecting", createdAt: source.createdAt ?? timestamp, runtimeState: source.runtimeState, observedAt: source.observedAt,
        lastKnownState: source.lastKnownState, lastKnownAt: source.lastKnownAt, activeTurnId: null, latestCursor: 0 };
    } else if (name === "createSession") {
      this.available(String(input.hostId));
      const timestamp = now();
      session = { sessionId: randomUUID(), hostId: String(input.hostId), workDir: String(input.workDir), codexThreadId: null,
        sessionConfig: { overrides: (input.sessionOptions ?? {}) as SessionOptions, resolved: null, ...(input.agentRef ? { agentRef: input.agentRef as AgentRef } : {}) },
        connectionState: "connecting", createdAt: timestamp, runtimeState: "unknown", observedAt: timestamp, lastKnownState: "unknown", lastKnownAt: timestamp, activeTurnId: null, latestCursor: 0 };
    } else {
      session = this.session(String(input.sessionId));
      this.available(session.hostId);
      if (name === "connectSession") {
        if (session.activeTurnId) fail("SESSION_BUSY", "Session has an active or unresolved turn.");
        if (this.store.list<Operation>("operation").some(o => o.sessionId === session.sessionId && o.operation === "connectSession" && ["accepted", "unknown"].includes(o.status))) fail("SESSION_NOT_READY", "The previous connection request is unresolved. Inspect it or retry its original request ID.", true);
        session.connectionState = "connecting";
      }
      if (name === "sendMessage") {
        if (session.activeTurnId) fail("SESSION_BUSY", "Session has an active or unresolved turn.", false, { sessionId: session.sessionId, turnId: session.activeTurnId });
        if (!session.codexThreadId || (session.runtimeState === "unknown" || session.connectionState !== "connected")) fail("SESSION_NOT_READY", "Conversation is not ready. Inspect its creation or recovery state.", true, { sessionId: session.sessionId });
        turnId = randomUUID();
      } else if (name === "interruptTurn" || name === "decideApproval") {
        turnId = String(input.turnId);
        if (session.activeTurnId !== turnId) fail("STALE_TURN", "Turn is no longer active.", false, { sessionId: session.sessionId, turnId });
        if (name === "decideApproval") {
          const approval = this.store.get<Approval>("approval", String(input.approvalId));
          if (!approval || approval.sessionId !== session.sessionId || approval.turnId !== turnId || approval.status !== "pending") fail("STALE_APPROVAL", "Approval is not pending for this session and turn.");
        }
      }
    }
    const operation: Operation = { commandId, operation: name as Command["operation"], sessionId: session.sessionId, turnId,
      input, caller: caller.id, requestId, fingerprint, status: "accepted", createdAt: now(), error: null };
    this.store.transaction(() => {
      if (name === "sendMessage") {
        session.activeTurnId = turnId;
        this.store.put("turn", turnId!, { turnId: turnId!, sessionId: session.sessionId, requestId, codexTurnId: null,
          state: "accepted", createdAt: operation.createdAt, observedAt: operation.createdAt, error: null } satisfies Turn);
      }
      if (name === "decideApproval") {
        const approval = this.store.get<Approval>("approval", String(input.approvalId))!;
        approval.status = "requested"; approval.decision = input.decision as "allow" | "deny"; approval.decidedAt = now();
        this.store.put("approval", approval.approvalId, approval);
      }
      this.store.put("session", session.sessionId, session);
      this.store.put("operation", commandId, operation);
    });
    if (name === "sendMessage") this.pendingInputs.set(commandId, input);
    this.dispatch(session.hostId, operation);
    return publicOperation(operation);
  }
  private async connect(input: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const id = String(input.sessionId);
    if (this.store.get("session", id)) return this.mutate("connectSession", input, caller);
    const source = await this.view(id);
    if (!source.native || !source.codexThreadId || !source.workDir) fail("SESSION_NOT_READY", "This native conversation has no saved working directory or thread reference.");
    return this.mutate("connectSession", input, caller, this.store.get("session", id) ? undefined : source);
  }
  private async refresh(hostId: string): Promise<void> {
    if (this.store.get<Host>("host", hostId)?.status !== "connected") return;
    const saved = this.inventories.get(hostId);
    if (saved && Date.now() - Date.parse(saved.observedAt) < 10000) return;
    if (this.refreshes.has(hostId)) return this.refreshes.get(hostId);
    const refresh = (async () => {
      try {
        const sessions: NativeSession[] = [];
        let cursor = 0, page: NativeInventory;
        do {
          page = await this.query(hostId, "discoverSessions", { cursor }) as NativeInventory;
          sessions.push(...page.sessions); cursor = page.nextCursor ?? 0;
        } while (page.nextCursor !== null);
        this.inventories.set(hostId, { ...page, sessions }); this.discoveryErrors.delete(hostId);
      } catch (cause) {
        this.discoveryErrors.set(hostId, cause instanceof ManagementError ? cause.detail : { code: "READ_FAILED", message: "Native inventory could not be read.", retryable: true });
      } finally { this.refreshes.delete(hostId); }
    })();
    this.refreshes.set(hostId, refresh); return refresh;
  }
  private summaries(hostId: string): SessionSummary[] {
    const managed = this.store.list<Session>("session").filter(s => s.hostId === hostId);
    const native = this.inventories.get(hostId)?.sessions ?? [];
    const connected = this.store.get<Host>("host", hostId)?.status === "connected";
    const rows: SessionSummary[] = managed.map(s => {
      const matches = native.filter(n => n.id === s.codexThreadId && (!s.codexHome || n.codexHome === s.codexHome));
      const source = matches.length === 1 ? matches[0]! : null;
      const observation = source && s.connectionState !== "connected" && !s.activeTurnId
        ? { runtimeState: connected && source.runtimeStatus === "active" ? "running" as const : connected && source.runtimeStatus === "idle" ? "idle" as const : "unknown" as const,
            observedAt: this.inventories.get(hostId)!.observedAt } : {};
      return { ...s, ...observation, managed: true, name: source?.name ?? s.workDir.split(/[\\/]/).filter(Boolean).at(-1) ?? s.sessionId, native: source };
    });
    for (const n of native) if (!rows.some(s => s.managed && s.native === n)) {
      const state = connected && n.runtimeStatus === "active" ? "running" : connected && n.runtimeStatus === "idle" ? "idle" : "unknown";
      rows.push({ sessionId: `native:${hash(JSON.stringify([hostId, n.codexHome, n.id]))}`, hostId, codexThreadId: n.id,
        sessionConfig: null,
        name: n.name, workDir: n.workDir, createdAt: n.createdAt, managed: false, native: n,
        runtimeState: state, connectionState: "disconnected", observedAt: this.inventories.get(hostId)!.observedAt, lastKnownState: state,
        lastKnownAt: this.inventories.get(hostId)!.observedAt, activeTurnId: null, latestCursor: 0 });
    }
    return rows;
  }
  private async list(hostId?: string) {
    const hosts = this.store.list<Host>("host").filter(h => !hostId || h.hostId === hostId);
    await Promise.all(hosts.map(h => this.refresh(h.hostId)));
    return { sessions: hosts.flatMap(h => this.summaries(h.hostId)), discovery: hosts.map(h => ({ hostId: h.hostId,
      observedAt: this.inventories.get(h.hostId)?.observedAt ?? null, sources: this.inventories.get(h.hostId)?.sources ?? [],
      error: this.discoveryErrors.get(h.hostId) ?? null })) };
  }
  private async view(id: string): Promise<SessionSummary> {
    const managed = this.store.get<Session>("session", id);
    if (managed) return this.summaries(managed.hostId).find(s => s.sessionId === id)!;
    const list = await this.list();
    return list.sessions.find(s => s.sessionId === id) ?? fail("NOT_FOUND", "Conversation is absent from the available native inventories.", true, { sessionId: id });
  }
  private async get(id: string) {
    const session = await this.view(id);
    return { session, turns: this.store.list<Turn>("turn").filter(t => t.sessionId === id),
      approvals: this.store.list<Approval>("approval").filter(a => a.sessionId === id),
      operations: this.store.list<Operation>("operation").filter(o => o.sessionId === id).map(publicOperation) };
  }
  private async history(input: Record<string, unknown>) {
    const session = await this.view(String(input.sessionId)), cursor = Number(input.cursor ?? 0), limit = Number(input.limit ?? 100);
    const empty: EventHistory = { events: [], nextCursor: cursor, hasMore: false, liveMessages: [] };
    const [eventRead, nativeRead] = await Promise.allSettled([
      Promise.resolve().then(() => session.managed ? this.query(session.hostId, "readEvents", { sessionId: session.sessionId, cursor, limit }) : empty),
      Promise.resolve().then(() => session.codexThreadId ? this.query(session.hostId, "readSessionHistory", { codexThreadId: session.codexThreadId,
        ...(session.native || session.codexHome ? { codexHome: session.native?.codexHome ?? session.codexHome! } : {}), limit,
        ...(input.messageCursor ? { messageCursor: String(input.messageCursor) } : {}) }) : { messages: [], nextCursor: null, observedAt: now() }),
    ]);
    const error = (cause: unknown, message: string) => cause instanceof ManagementError ? cause.detail : { code: "READ_FAILED", message, retryable: true };
    const events = eventRead.status === "fulfilled" ? eventRead.value as EventHistory : empty;
    const native = nativeRead.status === "fulfilled" ? nativeRead.value as NativeHistory : { messages: [], nextCursor: null, observedAt: now() };
    if (eventRead.status === "fulfilled") this.liveReplies.replace(session.sessionId, events.liveMessages);
    this.liveReplies.saved(session.sessionId, native.messages);
    return { events: events.events, nextCursor: events.nextCursor, hasMore: events.hasMore,
      messages: native.messages, nextMessageCursor: native.nextCursor, liveMessages: this.liveReplies.get(session.sessionId),
      historyError: nativeRead.status === "rejected" ? error(nativeRead.reason, "Native saved messages could not be read.") : null,
      eventsError: eventRead.status === "rejected" ? error(eventRead.reason, "Host event history could not be read.") : null };
  }
  uncertain(operation: Operation): void {
    operation.status = "unknown";
    operation.error = { code: "DELIVERY_UNCERTAIN", message: "Delivery result is unknown. Inspect state or retry with the same request ID.", retryable: true, sessionId: operation.sessionId, ...(operation.turnId ? { turnId: operation.turnId } : {}) };
    this.store.put("operation", operation.commandId, operation);
    if (operation.operation === "sendMessage" || operation.operation === "createSession") {
      const session = this.session(operation.sessionId);
      if (!session.codexThreadId || (operation.turnId !== null && session.activeTurnId === operation.turnId)) this.unknown(session);
    }
  }
  expireDeliveries(): void {
    for (const op of this.store.list<Operation>("operation")) if (op.status === "accepted" && Date.now() - Date.parse(op.createdAt) > 15000) this.uncertain(op);
  }
  result(hostId: string, result: OperationResult): void {
    const operation = this.store.get<Operation>("operation", result.commandId);
    if (!operation || this.session(operation.sessionId).hostId !== hostId) fail("INVALID_INPUT", "Command does not belong to this host.");
    operation.status = result.status; operation.error = result.error;
    const session = this.session(operation.sessionId);
    if (operation.operation === "connectSession" && result.status === "error" && session.connectionState === "connecting") {
      session.connectionState = "error";
      this.store.put("session", session.sessionId, session);
    }
    if (result.status !== "unknown") this.pendingInputs.delete(operation.commandId);
    this.store.put("operation", operation.commandId, operation);
  }
  event(hostId: string, event: Event): void {
    const session = this.session(event.sessionId);
    if (session.hostId !== hostId || !Number.isSafeInteger(event.cursor) || event.cursor < 1) fail("INVALID_INPUT", "Event does not belong to this host.");
    if (event.cursor <= session.latestCursor) return;
    this.liveReplies.observe(event);
    this.store.transaction(() => {
      const payload = event.payload;
      for (const key of ["session", "turn", "approval"]) {
        const record = payload[key] as { sessionId: string } | undefined;
        if (record && record.sessionId !== event.sessionId) fail("INVALID_INPUT", "Event record belongs to another session.");
      }
      if (event.payload.session) this.applySession(hostId, event.payload.session as unknown as Session);
      const current = this.session(event.sessionId); current.latestCursor = event.cursor;
      this.store.put("session", event.sessionId, current);
      if (event.payload.turn) this.applyTurn(event.payload.turn as unknown as Turn);
      if (event.payload.approval) this.applyApproval(event.payload.approval as unknown as Approval);
    });
  }
  private applySession(hostId: string, session: Session): void {
    const existing = this.session(session.sessionId);
    if (existing.hostId !== hostId || session.hostId !== hostId) fail("INVALID_INPUT", "Session does not belong to this host.");
    if (!Object.hasOwn(session, "sessionConfig")) fail("RECOVERY_REQUIRED", "Session configuration record is unsupported. Start with fresh Dewbow state.");
    if (existing.sessionConfig) {
      if (!session.sessionConfig || canonicalJson([existing.sessionConfig.agentRef ?? null, existing.sessionConfig.overrides]) !== canonicalJson([session.sessionConfig.agentRef ?? null, session.sessionConfig.overrides]) ||
          (existing.sessionConfig.resolved && canonicalJson(existing.sessionConfig.resolved) !== canonicalJson(session.sessionConfig.resolved))) fail("INVALID_INPUT", "Session configuration snapshot cannot change after resolution.");
    } else if (session.sessionConfig !== null) fail("INVALID_INPUT", "Native connections cannot acquire an agent definition.");
    this.store.put("session", session.sessionId, { ...session, latestCursor: Math.max(existing.latestCursor, session.latestCursor) });
  }
  private applyTurn(turn: Turn): void {
    const existing = this.store.get<Turn>("turn", turn.turnId);
    if (!existing || existing.sessionId !== turn.sessionId) fail("INVALID_INPUT", "Turn does not belong to this session.");
    if (terminal(existing.state) && !terminal(turn.state)) return;
    this.store.put("turn", turn.turnId, turn);
    if (terminal(turn.state)) {
      const session = this.session(turn.sessionId);
      if (session.activeTurnId === turn.turnId) {
        session.activeTurnId = null;
        this.store.put("session", session.sessionId, session);
      }
      for (const approval of this.store.list<Approval>("approval")) if (approval.turnId === turn.turnId && approval.status !== "resolved") {
        approval.status = "invalidated"; this.store.put("approval", approval.approvalId, approval);
      }
    }
  }
  private applyApproval(approval: Approval): void {
    const session = this.session(approval.sessionId);
    const existing = this.store.get<Approval>("approval", approval.approvalId);
    if (existing && (existing.sessionId !== approval.sessionId || existing.turnId !== approval.turnId)) fail("INVALID_INPUT", "Approval identity conflict.");
    if (session.activeTurnId !== approval.turnId && approval.status !== "resolved") approval.status = "invalidated";
    if (existing?.decision && !approval.decision) approval = { ...approval, decision: existing.decision, decidedAt: existing.decidedAt };
    this.store.put("approval", approval.approvalId, approval);
  }
  reconcile(hostId: string, report: HostReport): void {
    this.store.transaction(() => {
      for (const session of report.sessions) this.applySession(hostId, session);
      for (const turn of report.turns) { if (this.session(turn.sessionId).hostId !== hostId) fail("INVALID_INPUT", "Invalid turn host."); this.applyTurn(turn); }
      for (const approval of report.approvals) { if (this.session(approval.sessionId).hostId !== hostId) fail("INVALID_INPUT", "Invalid approval host."); this.applyApproval(approval); }
      const reportedApprovals = new Set(report.approvals.map(a => a.approvalId));
      for (const approval of this.store.list<Approval>("approval")) {
        if (this.session(approval.sessionId).hostId === hostId && !reportedApprovals.has(approval.approvalId) && approval.status !== "resolved") {
          approval.status = "invalidated"; this.store.put("approval", approval.approvalId, approval);
        }
      }
      for (const result of report.operations) this.result(hostId, result);
      const reportedOperations = new Set(report.operations.map(o => o.commandId));
      for (const operation of this.store.list<Operation>("operation")) {
        if (operation.operation !== "sendMessage" || !operation.turnId || reportedOperations.has(operation.commandId) || !["accepted", "unknown"].includes(operation.status)) continue;
        const session = this.session(operation.sessionId), turn = this.store.get<Turn>("turn", operation.turnId)!;
        if (session.hostId === hostId && !session.activeTurnId && !terminal(turn.state)) {
          session.activeTurnId = turn.turnId; session.runtimeState = "unknown";
          this.store.put("session", session.sessionId, session);
        }
      }
    });
  }
  resumeCommands(hostId: string, report: HostReport): void {
    const seen = new Set(report.operations.map(o => o.commandId));
    for (const operation of this.store.list<Operation>("operation")) {
      if (this.session(operation.sessionId).hostId !== hostId || operation.status === "delivered" || operation.status === "error") continue;
      if (seen.has(operation.commandId)) continue;
      const input = operation.operation === "sendMessage" ? this.pendingInputs.get(operation.commandId) : operation.input;
      if (!input) continue; // A restart requires the client to retry its original message and request ID.
      if (operation.operation === "sendMessage") {
        const session = this.session(operation.sessionId); session.activeTurnId = operation.turnId;
        this.store.put("session", session.sessionId, session);
      }
      if (operation.operation === "decideApproval") {
        const approval = this.store.get<Approval>("approval", String(operation.input.approvalId));
        if (!approval || approval.status !== "pending") continue;
      }
      this.dispatch(hostId, { ...operation, input });
    }
  }
  private unknown(session: Session): void {
    if (session.runtimeState !== "unknown") { session.lastKnownState = session.runtimeState; session.lastKnownAt = session.observedAt; }
    session.runtimeState = "unknown"; this.store.put("session", session.sessionId, session);
    if (session.activeTurnId) {
      const turn = this.store.get<Turn>("turn", session.activeTurnId);
      if (turn && !terminal(turn.state)) { turn.state = "unknown"; this.store.put("turn", turn.turnId, turn); }
    }
  }
  disconnect(hostId: string, revoked = false): void {
    const host = this.store.get<Host>("host", hostId);
    if (host) { host.status = revoked ? "revoked" : "disconnected"; this.store.put("host", hostId, host); }
    for (const session of this.store.list<Session>("session")) if (session.hostId === hostId && session.activeTurnId) this.unknown(session);
  }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function publicOperation(operation: Operation) {
  const { caller: _caller, fingerprint: _fingerprint, input: _input, ...publicFields } = operation;
  return publicFields;
}
