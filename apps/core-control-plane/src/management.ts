import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, fail, LiveReplies, ManagementError, maskPrivateMessages, maskPrivateActivity, maskPrivateEvents, now, terminal, validateInput } from "@dewbow/core-protocol";
import type { AgentRef, Interaction, Command, Event, EventHistory, Host, HostQuery, HostReport, ManagementErrorData, NativeHistory, NativeInventory, NativeSession, Operation, OperationResult, Session, SessionOptions, SessionSummary, Turn } from "@dewbow/core-protocol";
import { Store } from "@dewbow/core-protocol/store";

export interface Caller { id: string; operator: boolean }
export class Management {
  dispatch: (hostId: string, command: Command) => void = () => {};
  query: (hostId: string, operation: HostQuery["operation"], input: HostQuery["input"], authority?: HostQuery["authority"]) => Promise<unknown> = async () => fail("HOST_UNAVAILABLE", "Host reads are unavailable.", true);
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
    if (name === "listWorkspaceProfiles") { this.available(String(input.hostId)); return this.query(String(input.hostId), "listWorkspaceProfiles", {}); }
    if (name === "listSessions") return this.list(input.hostId as string | undefined);
    if (name === "getSession") return this.get(String(input.sessionId),caller);
    if (name === "readSessionHistory") return this.history(input,caller);
    if (name === "getSessionActivity" || name === "readSessionContent") {
      return this.readContent(name,input,caller);
    }
    if (name === "connectSession") return this.connect(input, caller);
    return this.mutate(name, input, caller);
  }
  private mutate(name: string, input: Record<string, unknown>, caller: Caller, source?: SessionSummary): unknown {
    if (name === "decideApproval" && !caller.operator) fail("FORBIDDEN", "Only the Web operator can decide interactions.");
    if (name !== "connectSession" && typeof input.sessionId === "string" && input.sessionId.startsWith("native:") && !this.store.get("session", input.sessionId)) fail("SESSION_NOT_CONNECTED", "Connect this native conversation before sending commands.");
    const requestId = String(input.requestId ?? input.interactionId);
    const commandId = hash(JSON.stringify([caller.id, name, requestId]));
    const fingerprint = hash(canonicalJson(input));
    const existing = this.store.get<Operation>("operation", commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail("REQUEST_CONFLICT", "Request ID was already used with different input.", false, { sessionId: existing.sessionId, ...(existing.turnId ? { turnId: existing.turnId } : {}) });
      if (["sendMessage","steerTurn","answerQuestions","decideApproval"].includes(existing.operation) && (existing.status === "unknown" || existing.status === "accepted")) {
        const session = this.session(existing.sessionId);
        this.available(session.hostId);
        this.pendingInputs.set(commandId, input);
        if (existing.operation === "sendMessage" && !session.activeTurnId && existing.turnId && !terminal(this.store.get<Turn>("turn", existing.turnId)!.state)) {
          session.activeTurnId = existing.turnId; session.runtimeState = "unknown";
          this.store.put("session", session.sessionId, session);
        }
        this.dispatch(session.hostId, { ...existing, input });
      }
      return publicOperation(existing);
    }
    if(!caller.operator && ["sendMessage","steerTurn","answerQuestions"].includes(name) && this.privateConversation(String(input.sessionId)))fail("FORBIDDEN","This conversation contains private operator input and requires the Core operator.");
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
      session = { sessionId: randomUUID(), hostId: String(input.hostId), workDir: typeof input.workDir === "string" ? input.workDir : null, codexThreadId: null,
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
      } else if (["interruptTurn","decideApproval","answerQuestions","steerTurn"].includes(name)) {
        turnId = String(input.turnId);
        if (session.activeTurnId !== turnId) fail("STALE_TURN", "Turn is no longer active.", false, { sessionId: session.sessionId, turnId });
        if (name === "decideApproval" || name === "answerQuestions") {
          const interaction = this.store.get<Interaction>("interaction", String(input.interactionId));
          if (!interaction || interaction.sessionId !== session.sessionId || interaction.turnId !== turnId || interaction.status !== "pending") fail("STALE_INTERACTION", "Interaction is not pending for this session and turn.");
          if ((name === "decideApproval" && interaction.kind !== "approval") || (name === "answerQuestions" && interaction.kind !== "questions")) fail("INVALID_INPUT","Operation does not match the interaction.");
          if (interaction.authority === "operator" && !caller.operator) fail("FORBIDDEN","This interaction requires the Core operator.");
        }
      }
    }
    const operation: Operation = { commandId, operation: name as Command["operation"], sessionId: session.sessionId, turnId,
      input,authority:caller.operator ? "operator" : "agent",caller:caller.id,requestId,fingerprint,status:"accepted",createdAt:now(),error:null };
    this.store.transaction(() => {
      if (name === "sendMessage") {
        session.activeTurnId = turnId;
        this.store.put("turn", turnId!, { turnId: turnId!, sessionId: session.sessionId, requestId, codexTurnId: null,
          mode:input.mode as Turn["mode"],state:"accepted",createdAt:operation.createdAt,observedAt:operation.createdAt,error:null } satisfies Turn);
      }
      if (name === "decideApproval" || name === "answerQuestions") {
        const interaction = this.store.get<Interaction>("interaction", String(input.interactionId))!;
        interaction.status = "requested"; interaction.requestId = requestId; interaction.observedAt = now();
        if (name === "decideApproval") interaction.decision = input.decision as "allow" | "deny";
        this.store.put("interaction", interaction.interactionId, interaction);
      }
      this.store.put("session", session.sessionId, session);
      this.store.put("operation", commandId, operation);
    });
    if (["sendMessage","steerTurn","answerQuestions"].includes(name)) this.pendingInputs.set(commandId,input);
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
      return { ...s, ...observation, managed: true, name: source?.name ?? s.workDir?.split(/[\\/]/).filter(Boolean).at(-1) ?? s.sessionId, native: source };
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
  private async get(id: string,caller:Caller) {
    const session = await this.view(id);
    let interactions = this.store.list<Interaction>("interaction").filter(item=>item.sessionId === id), interactionsError = null;
    if (session.managed && session.codexThreadId) {
      try {
        const page = await this.query(session.hostId,"readInteractions",{sessionId:id},caller.operator ? "operator" : "agent") as {interactions:Interaction[]};
        if (!Array.isArray(page.interactions)) fail("READ_FAILED","Invalid interaction view.",true);
        for (const item of page.interactions) { if (item.sessionId !== id) fail("INVALID_INPUT","Interaction belongs to another session."); this.applyInteraction(item); }
        interactions = page.interactions.map(item=>{
          const metadata = this.store.get<Interaction>("interaction",item.interactionId)!;
          return {...metadata,...(metadata.content.contentId === item.content.contentId ? {details:item.details} : {})};
        });
      } catch (cause) { interactionsError = cause instanceof ManagementError ? cause.detail : {code:"READ_FAILED",message:"Interactions are unavailable.",retryable:true}; }
    }
    return { session, contextAuthority:this.privateConversation(id) ? "operator" : "agent",turns: this.store.list<Turn>("turn").filter(t => t.sessionId === id),
      interactions:interactions.map(item=>{if(caller.operator || !this.privateConversation(id))return item;const {details:_details,...metadata}=item;return metadata;}),interactionsError,
      operations: this.store.list<Operation>("operation").filter(o => o.sessionId === id).map(publicOperation) };
  }
  private privateTurns(sessionId:string):Set<string> {
    return this.privateConversation(sessionId) ? new Set(this.store.list<Turn>("turn").filter(turn=>turn.sessionId===sessionId && turn.codexTurnId).map(turn=>turn.codexTurnId!)) : new Set();
  }
  private privateConversation(sessionId:string):boolean {return this.store.list<Interaction>("interaction").some(item=>item.sessionId===sessionId && item.sensitive);}
  private async history(input: Record<string, unknown>,caller:Caller) {
    if ([input.beforeCursor,input.afterCursor,input.updateCursor].filter(value=>value !== undefined).length > 1) fail("INVALID_INPUT","Choose one history cursor.");
    const session = await this.view(String(input.sessionId)), cursor = Number(input.cursor ?? 0), limit = Number(input.limit ?? 50);
    const empty: EventHistory = { events: [], nextCursor: cursor, hasMore: false, liveMessages: [] };
    const [eventRead, nativeRead] = await Promise.allSettled([
      Promise.resolve().then(() => session.managed ? this.query(session.hostId, "readEvents", { sessionId: session.sessionId, cursor, limit },caller.operator ? "operator" : "agent") : empty),
      Promise.resolve().then(() => session.codexThreadId ? this.query(session.hostId, "readSessionHistory", { codexThreadId: session.codexThreadId,
        ...(session.native || session.codexHome ? { codexHome: session.native?.codexHome ?? session.codexHome! } : {}), limit,
        ...(input.beforeCursor ? { beforeCursor:String(input.beforeCursor) } : {}),...(input.afterCursor ? { afterCursor:String(input.afterCursor) } : {}),...(input.updateCursor ? { updateCursor:String(input.updateCursor) } : {}) },caller.operator ? "operator" : "agent") : { messages:[],activities:[],beforeCursor:null,afterCursor:null,updateCursor:null,hasMoreUpdates:false,observedAt:now() }),
    ]);
    const error = (cause: unknown, message: string) => cause instanceof ManagementError ? cause.detail : { code: "READ_FAILED", message, retryable: true };
    const events = eventRead.status === "fulfilled" ? eventRead.value as EventHistory : empty;
    const native = nativeRead.status === "fulfilled" ? nativeRead.value as NativeHistory : { messages:[],activities:[],beforeCursor:null,afterCursor:null,updateCursor:null,hasMoreUpdates:false,observedAt:now() };
    if (eventRead.status === "fulfilled") this.liveReplies.replace(session.sessionId, events.liveMessages);
    this.liveReplies.saved(session.sessionId, native.messages);
    const live=this.liveReplies.get(session.sessionId);
    const privateTurns=caller.operator || !this.privateConversation(session.sessionId) ? new Set<string>() : new Set([...this.privateTurns(session.sessionId),...native.messages.map(item=>item.turnId),...native.activities.map(item=>item.turnId),...live.map(item=>item.turnId),...events.events.flatMap(event=>[event.turnId??"",(event.payload.turn as Turn|undefined)?.codexTurnId??""])]);
    return { events: caller.operator ? events.events : maskPrivateEvents(events.events,privateTurns), nextCursor: events.nextCursor, hasMore: events.hasMore,
      messages:maskPrivateMessages(native.messages,privateTurns),activities:native.activities.map(item=>privateTurns.has(item.turnId) ? maskPrivateActivity(item) : item),beforeCursor:native.beforeCursor,afterCursor:native.afterCursor,updateCursor:native.updateCursor,hasMoreUpdates:native.hasMoreUpdates,liveMessages:maskPrivateMessages(live,privateTurns),
      historyError: nativeRead.status === "rejected" ? error(nativeRead.reason, "Native saved messages could not be read.") : null,
      eventsError: eventRead.status === "rejected" ? error(eventRead.reason, "Host event history could not be read.") : null };
  }
  private async readContent(operation: "getSessionActivity" | "readSessionContent", input: Record<string,unknown>,caller:Caller) {
    const session = await this.view(String(input.sessionId));
    if (!session.codexThreadId) fail("SESSION_NOT_READY","Native conversation is not ready.");
    if(!caller.operator && this.privateConversation(session.sessionId) && operation === "readSessionContent")fail("FORBIDDEN","This conversation contains private operator input.");
    const { sessionId: _sessionId, ...options } = input;
    return this.query(session.hostId,operation,{ ...options,codexThreadId:session.codexThreadId,
      ...(session.native || session.codexHome ? { codexHome:session.native?.codexHome ?? session.codexHome! } : {}) },caller.operator ? "operator" : "agent");
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
    if (result.status === "error" && ["answerQuestions","decideApproval"].includes(operation.operation)) {
      const interaction=this.store.get<Interaction>("interaction",String(operation.input.interactionId));
      if(interaction?.status === "requested" && interaction.requestId === operation.requestId) {
        if(["INVALID_INPUT","FORBIDDEN","LIMIT_EXCEEDED"].includes(result.error?.code??"") && session.activeTurnId === interaction.turnId) {
          interaction.status="pending";interaction.requestId=null;interaction.decision=null;
        } else if(["STALE_INTERACTION","STALE_TURN"].includes(result.error?.code??""))interaction.status="invalidated";
        interaction.observedAt=now();this.store.put("interaction",interaction.interactionId,interaction);
      }
    }
    this.store.put("operation", operation.commandId, operation);
  }
  event(hostId: string, event: Event): void {
    const session = this.session(event.sessionId);
    if (session.hostId !== hostId || !Number.isSafeInteger(event.cursor) || event.cursor < 1) fail("INVALID_INPUT", "Event does not belong to this host.");
    if (event.cursor <= session.latestCursor) return;
    this.liveReplies.observe(event);
    this.store.transaction(() => {
      const payload = event.payload;
      for (const key of ["session", "turn", "interaction"]) {
        const record = payload[key] as { sessionId: string } | undefined;
        if (record && record.sessionId !== event.sessionId) fail("INVALID_INPUT", "Event record belongs to another session.");
      }
      if (event.payload.session) this.applySession(hostId, event.payload.session as unknown as Session);
      const current = this.session(event.sessionId); current.latestCursor = event.cursor;
      this.store.put("session", event.sessionId, current);
      if (event.payload.turn) this.applyTurn(event.payload.turn as unknown as Turn);
      if (event.payload.interaction) this.applyInteraction(event.payload.interaction as unknown as Interaction);
    });
  }
  private applySession(hostId: string, session: Session): void {
    const existing = this.session(session.sessionId);
    if (existing.hostId !== hostId || session.hostId !== hostId) fail("INVALID_INPUT", "Session does not belong to this host.");
    if (!Object.hasOwn(session, "sessionConfig")) fail("RECOVERY_REQUIRED", "Session configuration record is unsupported. Start with fresh Dewbow state.");
    if (existing.workspace?.status === "ready" && (canonicalJson(existing.workspace) !== canonicalJson(session.workspace) || existing.workDir !== session.workDir)) fail("INVALID_INPUT", "Resolved workspace ownership cannot change.");
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
      for (const interaction of this.store.list<Interaction>("interaction")) if (interaction.turnId === turn.turnId && interaction.status !== "resolved") {
        interaction.status = "invalidated"; this.store.put("interaction", interaction.interactionId, interaction);
      }
    }
  }
  private applyInteraction(interaction: Interaction): void {
    const session = this.session(interaction.sessionId);
    const existing = this.store.get<Interaction>("interaction", interaction.interactionId);
    if (existing && (existing.sessionId !== interaction.sessionId || existing.turnId !== interaction.turnId)) fail("INVALID_INPUT", "Interaction identity conflict.");
    if (session.activeTurnId !== interaction.turnId && interaction.status !== "resolved") interaction.status = "invalidated";
    if (existing && (["resolved","invalidated"].includes(existing.status) || ({pending:0,requested:1,delivered:2,resolved:3,invalidated:3}[existing.status] > {pending:0,requested:1,delivered:2,resolved:3,invalidated:3}[interaction.status]))) {
      interaction = {...interaction,...existing,authority:interaction.authority};
    }
    this.store.put("interaction", interaction.interactionId, interaction);
  }
  reconcile(hostId: string, report: HostReport): void {
    this.store.transaction(() => {
      for (const session of report.sessions) this.applySession(hostId, session);
      for (const turn of report.turns) { if (this.session(turn.sessionId).hostId !== hostId) fail("INVALID_INPUT", "Invalid turn host."); this.applyTurn(turn); }
      for (const interaction of report.interactions) { if (this.session(interaction.sessionId).hostId !== hostId) fail("INVALID_INPUT", "Invalid interaction host."); this.applyInteraction(interaction); }
      const reportedInteractions = new Set(report.interactions.map(a => a.interactionId));
      for (const interaction of this.store.list<Interaction>("interaction")) {
        if (this.session(interaction.sessionId).hostId === hostId && !reportedInteractions.has(interaction.interactionId) && interaction.status !== "resolved") {
          interaction.status = "invalidated"; this.store.put("interaction", interaction.interactionId, interaction);
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
      const input = ["sendMessage","steerTurn","answerQuestions"].includes(operation.operation) ? this.pendingInputs.get(operation.commandId) : operation.input;
      if (!input) continue; // A restart requires the client to retry its original message and request ID.
      if (operation.operation === "sendMessage") {
        const session = this.session(operation.sessionId); session.activeTurnId = operation.turnId;
        this.store.put("session", session.sessionId, session);
      }
      if (operation.operation === "decideApproval" || operation.operation === "answerQuestions") {
        const interaction = this.store.get<Interaction>("interaction", String(operation.input.interactionId));
        if (!interaction || !["pending","requested"].includes(interaction.status) || (interaction.requestId && interaction.requestId!==operation.requestId)) continue;
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
