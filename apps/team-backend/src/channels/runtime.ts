import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fail, TeamError, type ChannelConnection, type ChannelState, type Chatbot, type CoreHistory, type CoreInteraction, type SessionBindingResult, type SessionBindingDetails } from "@dewbow/team-protocol";
import { SessionService } from "../session-service.js";
import { fingerprintInput, TeamStore } from "../store.js";
import { DeliveryError, type ChannelAdapter, type ChannelCredentials, type IncomingMessage } from "./adapter.js";
import { ChannelStore, key, type Conversation, type Delivery, type Question, type Watch } from "./store.js";
import { DingTalkSender, makeAck, parseMessage, splitText } from "./dingtalk/messages.js";
import { runStream } from "./dingtalk/stream.js";
import { Takeovers } from "./takeover.js";

export function readChannelCredentials(path?: string): ChannelCredentials[] {
  if (!path) return [];
  let values: ChannelCredentials[];
  try { values = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Invalid private channel credential configuration."); }
  if (!Array.isArray(values)) throw new Error("Channel credentials must be an array.");
  const refs = new Set<string>(), accounts = new Set<string>();
  for (const value of values) {
    if (!value || [value.credentialRef, value.clientId, value.clientSecret, value.robotCode, value.corpId].some(field => typeof field !== "string" || !field.trim() || field.length > 4096 || field.startsWith("replace-with-"))
      || refs.has(value.credentialRef) || accounts.has(value.clientId)) throw new Error("Invalid or duplicate channel credential entry.");
    refs.add(value.credentialRef); accounts.add(value.clientId);
  }
  return values;
}

export class DingTalkAdapter implements ChannelAdapter {
  constructor(private readonly sender = new DingTalkSender(), private readonly state: (status: string) => void = () => {}) {}
  async run(credentials: ChannelCredentials, receive: (message: IncomingMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
    await runStream(credentials, { signal, log: message => this.state(message.startsWith("Stream connected.") ? "connected" : "reconnecting"), handle: async frame => {
      try { const message = parseMessage(frame, credentials); if (message) await receive(message); return makeAck(frame, 200, "OK"); }
      catch { return makeAck(frame, 400, "Rejected"); }
    } });
  }
  send(credentials: ChannelCredentials, address: Conversation["address"], text: string, signal: AbortSignal) { return this.sender.send(credentials, address, text, signal); }
}

const timestamp = () => new Date().toISOString();
const terminal = (state: string) => ["completed", "interrupted", "error"].includes(state);

export class ChannelRuntime {
  readonly store: ChannelStore;
  private readonly running = new Map<string, { controller: AbortController; task: Promise<void>; adapter: ChannelAdapter; status: string }>();
  private readonly stopSignal = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private readonly ownerId = randomUUID();
  private leaseHeld = false;
  private ticking: Promise<void> | null = null;
  private readonly sendAfter = new Map<string, number>();
  private readonly takeovers: Takeovers;

  constructor(team: TeamStore, private readonly sessions: SessionService, private readonly credentials: ChannelCredentials[] = [], private readonly factory?: (connection: ChannelConnection) => ChannelAdapter, private readonly options: { sendIntervalMs?: number } = {}) {
    this.store = new ChannelStore(team);
    this.takeovers = new Takeovers(this.store,sessions,conversation=>!this.stopSignal.signal.aborted && this.active(this.connection(conversation.connectionId)));
  }
  start(): void {
    if (this.timer) return;
    this.store.acquireLease(this.ownerId); this.leaseHeld = true;
    this.leaseTimer = setInterval(() => {
      if (!this.store.renewLease(this.ownerId)) { this.stopSignal.abort(); for (const value of this.running.values()) value.controller.abort(); }
    }, 5000);
    this.store.recover();
    // A previous process may have accepted input but not started its task. Startup observes only.
    for (const delivery of this.store.list<Delivery>("channel_deliveries")) if (delivery.direction === "input" && delivery.status === "pending" && !delivery.deferredTakeoverId) {
      delivery.status = "unknown"; delivery.error = "Input retained after restart. Retry the original delivery from Team."; this.save(delivery);
    }
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000);
    void this.tick().catch(() => {});
  }
  async close(): Promise<void> {
    clearInterval(this.timer); clearInterval(this.leaseTimer); this.stopSignal.abort();
    for (const value of this.running.values()) value.controller.abort();
    await Promise.allSettled([...this.running.values()].map(value => value.task));
    await this.ticking?.catch(() => {});
    if (this.leaseHeld) { this.store.releaseLease(this.ownerId); this.leaseHeld = false; }
  }
  private save(delivery: Delivery): void {
    const current=this.store.get<Delivery>("channel_deliveries",delivery.deliveryId);
    if(current?.direction==="input" && current.contextId && current.status==="completed")Object.assign(delivery,current);
    if(current?.suppressed)delivery.suppressed=true;
    delivery.updatedAt = timestamp(); this.store.put("channel_deliveries", delivery.deliveryId, delivery);
  }
  private connection(id: string): ChannelConnection { return this.store.get<ChannelConnection>("channel_connections", id) ?? fail("NOT_FOUND", "Channel connection not found."); }
  private bot(id: string): Chatbot { return this.store.get<Chatbot>("channel_chatbots", id) ?? fail("NOT_FOUND", "Chatbot not found."); }
  private secret(connection: ChannelConnection): ChannelCredentials {
    const value = this.credentials.find(value => value.credentialRef === connection.credentialRef) ?? fail("CHANNEL_NOT_CONFIGURED", "Private channel credentials are unavailable.");
    if (connection.accountId !== value.clientId || connection.corpId !== value.corpId) fail("CHANNEL_TARGET_CHANGED", "This credential reference now identifies a different application or organization.");
    return value;
  }
  private active(connection: ChannelConnection): boolean { return connection.enabled && this.bot(connection.chatbotId).enabled; }

  async execute(operation: string, input: Record<string, unknown>, caller: string): Promise<unknown> {
    if (operation === "readChannelConversation") return this.takeovers.read(String(input.conversationId));
    if (["beginChannelTakeover","endChannelTakeover","sendChannelMessage"].includes(operation)) return this.store.team.mutate(caller,operation,input,()=>{
      const id=String(input.conversationId);
      if (operation === "beginChannelTakeover") return this.takeovers.begin(id,String(input.requestId));
      if (operation === "endChannelTakeover") return this.takeovers.end(id);
      return this.takeovers.send(id,String(input.message),String(input.requestId));
    });
    if (operation === "getChannels") {
      const state: ChannelState = {
        chatbots: this.store.list("channel_chatbots"),
        connections: this.store.list<ChannelConnection>("channel_connections").map(value => ({ ...value, status: this.running.get(value.connectionId)?.status ?? (this.active(value) ? "connecting" : "disabled") })),
        conversations: this.store.list<Conversation>("channel_conversations").map(({ address: _address, ...value }) => value),
        deliveries: this.store.list<Delivery>("channel_deliveries").filter(value => value.status !== "completed").slice(-200).map(({ text: _text, payload: _payload, ...value }) => ({ ...value, bodyRetained: Boolean(this.store.get<Delivery>("channel_deliveries", value.deliveryId)?.text) })),
        credentials: this.credentials.map(({ credentialRef, corpId, robotCode }) => ({ credentialRef, corpId, robotCode })),
      }; return state;
    }
    if (operation === "bindChannelConversation") {
      const prior = this.store.team.findRequest(caller, operation, String(input.requestId), fingerprintInput(input));
      if (prior?.result) return prior.result;
      const conversation = this.store.get<Conversation>("channel_conversations", String(input.conversationId)) ?? fail("NOT_FOUND", "Conversation not found.");
      if (conversation.mode === "human") fail("TAKEOVER_ACTIVE","End takeover before changing the binding.");
      if (this.store.list<Delivery>("channel_deliveries").some(item => item.conversationId === conversation.conversationId && item.direction === "input" && ["pending", "processing", "unknown"].includes(item.status))) fail("SESSION_BUSY", "Resolve pending input before changing the binding.");
      const details = await this.details(String(input.bindingId));
      if (details.binding.agentRef.id !== conversation.definitionId || details.core!.contextAuthority !== "agent" || details.core!.session.workspace?.status !== "ready"
        || details.core!.session.activeTurnId || details.core!.session.connectionState !== "connected" || details.core!.session.runtimeState !== "idle") fail("INVALID_BINDING", "Select an idle, ready, isolated session of this definition with agent-readable context.");
      return this.store.team.mutate(caller, operation, input, () => {
        if (this.store.list<Delivery>("channel_deliveries").some(item => item.conversationId === conversation.conversationId && item.direction === "input" && ["pending", "processing", "unknown"].includes(item.status))
          || this.store.list<Watch>("channel_turns").some(item => item.conversationId === conversation.conversationId && !item.complete)) fail("SESSION_BUSY", "Resolve current channel execution before changing the binding.");
        this.store.claim(details.binding.bindingId, conversation.conversationId);
        const current = this.store.get<Conversation>("channel_conversations", conversation.conversationId)!;
        if (current.mode === "human") fail("TAKEOVER_ACTIVE","End takeover before changing the binding.");
        current.bindingId = details.binding.bindingId; current.pendingBindingId = null; current.updatedAt = timestamp();
        this.store.put("channel_conversations", current.conversationId, current); return { conversation: this.publicConversation(current) };
      });
    }
    return this.store.team.mutate(caller, operation, input, () => {
      if (operation === "createChatbot" || operation === "updateChatbot") {
        const old = operation === "updateChatbot" ? this.bot(String(input.chatbotId)) : null;
        const bot: Chatbot = { chatbotId: old?.chatbotId ?? randomUUID(), name: String(input.name ?? old?.name).trim(), definitionId: String(input.definitionId ?? old?.definitionId), hostId: String(input.hostId ?? old?.hostId), workspaceProfileId: String(input.workspaceProfileId ?? old?.workspaceProfileId), enabled: input.enabled as boolean ?? old?.enabled ?? false, createdAt: old?.createdAt ?? timestamp(), updatedAt: timestamp() };
        this.store.team.getDefinition(bot.definitionId);
        this.store.put("channel_chatbots", bot.chatbotId, bot); return { chatbot: bot };
      }
      if (operation === "createChannelConnection" || operation === "updateChannelConnection") {
        const old = operation === "updateChannelConnection" ? this.connection(String(input.connectionId)) : null;
        const credential = this.credentials.find(value => value.credentialRef === (old?.credentialRef ?? input.credentialRef)) ?? fail("CHANNEL_NOT_CONFIGURED", "Private channel credentials are unavailable.");
        const connection: ChannelConnection = { connectionId: old?.connectionId ?? randomUUID(), chatbotId: old?.chatbotId ?? String(input.chatbotId), platform: "dingtalk", accountId: old?.accountId ?? credential.clientId, corpId: old?.corpId ?? credential.corpId, credentialRef: old?.credentialRef ?? String(input.credentialRef), enabled: input.enabled as boolean ?? old?.enabled ?? false, createdAt: old?.createdAt ?? timestamp(), updatedAt: timestamp() };
        this.bot(connection.chatbotId); this.secret(connection);
        if (this.store.list<ChannelConnection>("channel_connections").some(value => value.connectionId !== connection.connectionId && value.credentialRef === connection.credentialRef)) fail("CONNECTION_IN_USE", "This application already has a channel connection.");
        this.store.put("channel_connections", connection.connectionId, connection); return { connection };
      }
      if (operation === "retryChannelDelivery") {
        const delivery = this.store.get<Delivery>("channel_deliveries", String(input.deliveryId)) ?? fail("NOT_FOUND", "Delivery not found.");
        if (delivery.suppressed) fail("DELIVERY_SUPPRESSED","This automatic delivery permanently lost sending eligibility at takeover.");
        if (!["unknown", "error"].includes(delivery.status) || !delivery.text) fail("INVALID_INPUT", "This delivery has no retryable retained body.");
        delivery.status = "pending"; delivery.error = null; this.save(delivery); return { deliveryId: delivery.deliveryId };
      }
      if (operation === "closeChannelDelivery") {
        const delivery=this.store.get<Delivery>("channel_deliveries",String(input.deliveryId)) ?? fail("NOT_FOUND","Delivery not found.");
        if (delivery.direction!=="output" || !["unknown","error"].includes(delivery.status)) fail("INVALID_INPUT","Only an unresolved outgoing delivery can be closed.");
        delivery.outcomeUnknown=delivery.status==="unknown";delivery.closedAt=timestamp();delivery.suppressed=true;delivery.status="suppressed";delivery.text=null;delivery.payload=null;
        delivery.error=delivery.outcomeUnknown ? "Closed without retry by the operator; the platform outcome remains unknown." : "Failed delivery closed without retry by the operator.";
        this.save(delivery);return {deliveryId:delivery.deliveryId};
      }
      fail("NOT_FOUND", "Unknown channel operation.");
    });
  }
  private publicConversation({ address: _address, sequence:_sequence, ...conversation }: Conversation) { return conversation; }
  readConversation(id: string, observation?: SessionBindingDetails) { return this.takeovers.read(id, observation); }
  private automatic(id: string): boolean { return this.store.get<Conversation>("channel_conversations",id)?.mode !== "human"; }

  async accept(connectionId: string, message: IncomingMessage): Promise<void> {
    const connection = this.connection(connectionId), bot = this.bot(connection.chatbotId), credentials = this.secret(connection);
    if (!this.active(connection) || message.corpId !== credentials.corpId || !message.userId.trim()) fail("FORBIDDEN", "This channel identity is not permitted.");
    this.store.team.transaction(() => {
      const id = key(connectionId, message.corpId, message.userId, bot.definitionId);
      const conversation = this.store.get<Conversation>("channel_conversations", id) ?? { conversationId: id, connectionId, corpId: message.corpId, userId: message.userId, definitionId: bot.definitionId, externalConversationId: message.conversationId, bindingId: null, pendingBindingId: null, generation: 0, updatedAt: timestamp(), address: { corpId: message.corpId, userId: message.userId, webhook: message.webhook, expiresAt: message.expiresAt } };
      conversation.externalConversationId = message.conversationId; conversation.updatedAt = timestamp(); conversation.address = { corpId: message.corpId, userId: message.userId, webhook: message.webhook, expiresAt: message.expiresAt };
      this.store.put("channel_conversations", id, conversation);
      const deliveryId = key(connectionId, message.corpId, message.userId, message.messageId);
      const existing = this.store.get<Delivery>("channel_deliveries", deliveryId);
      if (existing) { if (existing.text && existing.text !== message.text) fail("REQUEST_CONFLICT", "Platform message ID changed its content."); return; }
      const delivery: Delivery = { deliveryId, conversationId: id, direction: "input", status: "pending", bindingId: null, turnId: null, operation: null, requestId: null, text: message.text, payload: null, error: null, createdAt: timestamp(), updatedAt: timestamp() };
      this.store.put("channel_deliveries", deliveryId, delivery);
      this.takeovers.receive(conversation,delivery);
    });
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.process().finally(() => { this.ticking = null; }); return this.ticking;
  }
  private async process(): Promise<void> {
    if (this.stopSignal.signal.aborted) return;
    if (this.leaseHeld && !this.store.ownsLease(this.ownerId)) return;
    for (const connection of this.store.list<ChannelConnection>("channel_connections")) {
      const running = this.running.get(connection.connectionId);
      if (!this.active(connection)) { running?.controller.abort(); continue; }
      if (!running && this.timer) {
        const controller = new AbortController();
        const adapter = this.factory?.(connection) ?? new DingTalkAdapter(new DingTalkSender(), status => { const current = this.running.get(connection.connectionId); if (current) current.status = status; });
        const task = Promise.resolve().then(() => adapter.run(this.secret(connection), message => this.accept(connection.connectionId, message), controller.signal)).catch(() => {}).finally(() => this.running.delete(connection.connectionId));
        this.running.set(connection.connectionId, { controller, adapter, task, status: "connecting" });
      }
    }
    const blocked = new Set<string>();
    await this.takeovers.tick();
    for (const delivery of this.store.list<Delivery>("channel_deliveries")) if (delivery.text && !delivery.deferredTakeoverId && delivery.source !== "operator" && this.automatic(delivery.conversationId) && Date.now() - Date.parse(delivery.createdAt) > 24 * 60 * 60 * 1000) { delivery.text = null; delivery.payload = null; delivery.status = "error"; delivery.error = "Retained body expired after 24 hours. Submit a new request explicitly."; this.save(delivery); }
    for (const delivery of this.store.list<Delivery>("channel_deliveries")) {
      if (this.stopSignal.signal.aborted) return;
      if (delivery.direction !== "input" || !["pending", "processing", "unknown"].includes(delivery.status)) continue;
      if (blocked.has(delivery.conversationId) && !["/status", "/stop"].includes(delivery.text ?? "")) continue;
      const conversation = this.store.get<Conversation>("channel_conversations", delivery.conversationId)!;
      if (!this.active(this.connection(conversation.connectionId))) continue;
      if (delivery.status === "unknown") { await this.reconcile(delivery); if (delivery.status === "unknown") blocked.add(delivery.conversationId); continue; }
      if (this.takeovers.receive(conversation,delivery)) continue;
      await this.input(conversation, delivery);
      if (["pending", "unknown", "processing"].includes(delivery.status)) blocked.add(delivery.conversationId);
    }
    for (const watch of this.store.list<Watch>("channel_turns")) { if (this.stopSignal.signal.aborted) return; if (!watch.complete) await this.observe(watch).catch(() => {}); }
    const blockedReplies = new Set<string>();
    for (const delivery of this.store.list<Delivery>("channel_deliveries")) {
      if (this.stopSignal.signal.aborted) return;
      if (delivery.direction !== "output" || ["completed","suppressed"].includes(delivery.status) || delivery.suppressed || !delivery.text || blockedReplies.has(delivery.conversationId)) continue;
      if (delivery.status === "pending") await this.output(delivery);
      if (!["completed"].includes(delivery.status)) blockedReplies.add(delivery.conversationId);
    }
    this.store.purgeQuestions();

  }
  private async details(bindingId: string): Promise<SessionBindingDetails> {
    const details = await this.sessions.execute("getSessionBinding", { bindingId }, "channel") as SessionBindingDetails;
    if (!details.core || details.coreError) fail(details.coreError?.code ?? "SESSION_NOT_READY", "Core session state is unavailable.", true);
    return details;
  }
  private finish(delivery: Delivery): void { delivery.status = "completed"; delivery.text = null; delivery.payload = null; delivery.error = null; this.save(delivery); }
  private notice(conversation: Conversation, delivery: Delivery, text: string): void { this.store.output(conversation, key(delivery.deliveryId, "notice"), text); }

  private async ready(conversation: Conversation, delivery: Delivery, replace: boolean): Promise<string | null> {
    if (!this.automatic(conversation.conversationId)) return null;
    if (conversation.bindingId && !replace) return conversation.bindingId;
    const connection = this.connection(conversation.connectionId), bot = this.bot(connection.chatbotId);
    if (this.stopSignal.signal.aborted || !this.active(connection)) return null;
    if (bot.definitionId !== conversation.definitionId) fail("ROUTE_CHANGED", "The chatbot definition changed. Send a new message to its current agent.");
    if (!conversation.pendingBindingId) {
      const result = await this.sessions.execute("createAgentSession", { definitionId: conversation.definitionId, hostId: bot.hostId, workspaceProfileId: bot.workspaceProfileId, requestId: key("create", conversation.conversationId, conversation.generation) }, `channel:${conversation.conversationId}`) as SessionBindingResult;
      conversation.pendingBindingId = result.binding.bindingId; this.store.put("channel_conversations", conversation.conversationId, conversation);
      if (result.error) { delivery.bindingId = result.binding.bindingId; throw new TeamError(result.error); }
    }
    if (this.stopSignal.signal.aborted || !this.active(connection)) return null;
    const details = await this.details(conversation.pendingBindingId);
    if (details.core!.session.connectionState === "error") fail("RECOVERY_REQUIRED", "Session creation failed. Inspect the original request in Team.");
    if (details.core!.session.connectionState !== "connected" || details.core!.session.runtimeState !== "idle") return null;
    this.store.team.transaction(() => {
      this.store.claim(details.binding.bindingId, conversation.conversationId);
      conversation.bindingId = details.binding.bindingId; conversation.pendingBindingId = null; conversation.updatedAt = timestamp(); this.store.put("channel_conversations", conversation.conversationId, conversation);
    });
    return conversation.bindingId;
  }

  private async input(conversation: Conversation, delivery: Delivery): Promise<void> {
    try {
      if (this.takeovers.receive(conversation,delivery)) return;
      const text = delivery.text!;
      if (text === "/unsupported") { this.notice(conversation, delivery, "Only text messages are supported."); this.finish(delivery); return; }
      if (text === "/status") {
        const id = conversation.bindingId ?? conversation.pendingBindingId;
        if (!id) this.notice(conversation, delivery, "No session yet. Send a task to start one.");
        else {
          try { const details = await this.details(id); this.notice(conversation, delivery, `Session ${details.binding.sessionId ?? "pending"}\nConnection: ${details.core!.session.connectionState}\nExecution: ${details.core!.session.runtimeState}`); }
          catch { this.notice(conversation, delivery, `Connection: unknown\nExecution: unknown\nCore state is unavailable. ${this.sessions.core.url ?? "Open Core to inspect it."}`); }
        }
        this.finish(delivery); return;
      }
      if (text === "/new" && !delivery.payload) {
        const id = conversation.bindingId ?? conversation.pendingBindingId;
        if (id) { const details = await this.details(id); if (details.core!.session.activeTurnId || details.core!.session.runtimeState === "unknown" || details.core!.session.connectionState !== "connected" || details.core!.operations.some(value => ["accepted", "unknown"].includes(value.status))) fail("SESSION_BUSY", "Stop or reconcile the current task before /new."); }
        conversation.generation++; conversation.pendingBindingId = null; delivery.payload = { replace: true }; this.save(delivery); this.store.put("channel_conversations", conversation.conversationId, conversation);
      }
      if (text === "/stop" && !conversation.bindingId) { this.notice(conversation, delivery, "No active session."); this.finish(delivery); return; }
      if (text.startsWith("/answer ") && !conversation.bindingId) fail("STALE_QUESTION", "No current session has issued this question token.");
      if (delivery.bindingId && !this.store.team.getBinding(delivery.bindingId).sessionId) {
        if (this.stopSignal.signal.aborted || !this.active(this.connection(conversation.connectionId))) return;
        const retry = await this.sessions.execute("retrySessionBindingCreation", { bindingId: delivery.bindingId }, "channel") as SessionBindingResult;
        if (retry.error) throw new TeamError(retry.error);
        delivery.bindingId = null;
      }
      const bindingId = delivery.bindingId ?? await this.ready(conversation, delivery, text === "/new");
      if (!bindingId) return;
      delivery.bindingId = bindingId;
      if (text === "/new") { this.notice(conversation, delivery, "A new isolated session is ready. Previous files and sessions are retained."); this.finish(delivery); return; }
      let details = await this.details(bindingId);
      if (!this.automatic(conversation.conversationId)) {this.takeovers.receive(conversation,delivery);return;}
      if (this.stopSignal.signal.aborted || !this.active(this.connection(conversation.connectionId)) || !this.automatic(conversation.conversationId)) return;
      if (details.core!.contextAuthority !== "agent") fail("FORBIDDEN", "This session requires the Core operator. Continue in Core.");
      if (!delivery.operation && details.core!.session.connectionState !== "connected" && !details.core!.session.activeTurnId) {
        const result = await this.sessions.execute("connectSessionBinding", { bindingId, requestId: key(delivery.deliveryId, "connect") }, "channel") as SessionBindingResult;
        if (result.error) throw new TeamError(result.error);
        delivery.status = "pending"; this.save(delivery); return;
      }
      if (!delivery.operation) {
        if (text === "/stop") {
          if (details.core!.session.runtimeState === "unknown") fail("RECOVERY_REQUIRED", "Execution state is unknown. Inspect Core before reporting a stop.", true);
          if (!details.core!.session.activeTurnId) { this.notice(conversation, delivery, "No active turn."); this.finish(delivery); return; }
          delivery.operation = "interruptBindingTurn"; delivery.payload = { turnId: details.core!.session.activeTurnId };
        } else if (text.startsWith("/answer ")) {
          const answer = await this.answer(conversation, bindingId, text, details);
          if (!answer) { this.notice(conversation, delivery, "Answer saved. Reply to the remaining numbered questions."); this.finish(delivery); return; }
          delivery.operation = "answerBindingQuestions"; delivery.payload = answer;
        } else {
          if (details.core!.session.runtimeState === "unknown" || details.core!.session.connectionState !== "connected" || details.core!.interactionsError) fail("RECOVERY_REQUIRED", "Session state is unknown. Inspect Core before sending more input.", true);
          if (details.core!.interactions.some(value => value.status === "pending" && value.blocking)) fail("AWAITING_INPUT", "Reply with /answer for ordinary questions, or handle approvals in Core.");
          delivery.operation = details.core!.session.activeTurnId ? "steerBindingTurn" : "sendBindingMessage";
          delivery.payload = { message: text, ...(details.core!.session.activeTurnId ? { turnId: details.core!.session.activeTurnId } : {}) };
        }
        delivery.requestId = key(delivery.deliveryId, delivery.operation);
      }
      if (!this.automatic(conversation.conversationId)) {this.takeovers.receive(conversation,delivery);return;}
      if (this.stopSignal.signal.aborted || !this.active(this.connection(conversation.connectionId))) return;
      delivery.status = "processing"; this.save(delivery);
      const result = await this.sessions.execute(delivery.operation, { bindingId, ...delivery.payload, requestId: delivery.requestId }, "channel") as SessionBindingResult;
      if (result.operation?.turnId) delivery.turnId = result.operation.turnId;
      if (result.error) {
        if (!this.automatic(conversation.conversationId) && !["accepted","unknown"].includes(result.operation?.status??"") && ["SESSION_PAUSED","SESSION_BUSY","STALE_TURN"].includes(result.error.code)) {
          delivery.operation=null;delivery.requestId=null;delivery.payload=null;this.takeovers.receive(conversation,delivery);return;
        }
        if (result.operation?.status === "error" && ["STALE_TURN", "SESSION_BUSY"].includes(result.error.code)) {
          details = await this.details(bindingId);
          if (details.core!.contextAuthority === "agent" && details.core!.session.connectionState === "connected" && !details.core!.interactionsError && !details.core!.interactions.some(value => value.status === "pending" && value.blocking)) {
            const turnId = details.core!.session.activeTurnId;
            if (result.error.code === "STALE_TURN" && delivery.operation === "steerBindingTurn" && details.core!.session.runtimeState === "idle" && !turnId) {
              delivery.operation = "sendBindingMessage"; delivery.payload = { message: text };
            } else if (result.error.code === "SESSION_BUSY" && delivery.operation === "sendBindingMessage" && details.core!.session.runtimeState === "running" && turnId) {
              delivery.operation = "steerBindingTurn"; delivery.payload = { message: text, turnId };
            } else throw new TeamError(result.error);
            delivery.requestId = key(delivery.deliveryId, delivery.operation); delivery.status = "pending"; this.save(delivery); return;
          }
        }
        throw new TeamError(result.error);
      }
      if (result.operation?.status !== "delivered") { delivery.status = "unknown"; this.save(delivery); return; }
      if (["sendBindingMessage", "steerBindingTurn", "interruptBindingTurn", "answerBindingQuestions"].includes(delivery.operation) && delivery.turnId) this.watch(conversation, bindingId, delivery.turnId);
      if (delivery.operation === "answerBindingQuestions") this.store.clearAnswers(conversation.conversationId, String(delivery.payload?.interactionId));
      this.finish(delivery);
    } catch (error) {
      delivery.status = error instanceof TeamError && error.detail.retryable ? "unknown" : "error";
      delivery.error = error instanceof TeamError ? `${error.detail.code}: ${error.detail.message}` : "Channel input could not be processed.";
      this.save(delivery); this.notice(conversation, delivery, `${delivery.error}\nInspect this conversation in Team${this.sessions.core.url ? ` or Core: ${this.sessions.core.url}` : "."}`);
    }
  }

  private watch(conversation: Conversation, bindingId: string, turnId: string): void {
    const watchId = key(conversation.conversationId, bindingId, turnId);
    if (!this.store.get("channel_turns", watchId)) this.store.put("channel_turns", watchId, { watchId, conversationId: conversation.conversationId, bindingId, turnId, eventCursor: 0, updateCursor: null, beforeCursor: null, complete: !this.automatic(conversation.conversationId) } satisfies Watch);
  }
  private async reconcile(delivery: Delivery): Promise<void> {
    if (!delivery.bindingId || !delivery.requestId || !delivery.operation) return;
    try {
      const details = await this.details(delivery.bindingId);
      const request = details.requests.find(value => value.requestId === delivery.requestId && value.operation === delivery.operation);
      if (request?.result?.status === "delivered") {
        if (request.result.turnId) this.watch(this.store.get<Conversation>("channel_conversations", delivery.conversationId)!, delivery.bindingId, request.result.turnId);
        if (delivery.operation === "answerBindingQuestions") this.store.clearAnswers(delivery.conversationId, String(delivery.payload?.interactionId));
        this.finish(delivery);
      } else if (request?.result?.status === "error") {
        if (!this.automatic(delivery.conversationId) && ["SESSION_PAUSED","SESSION_BUSY"].includes(request.error?.code??"")) {
          delivery.operation=null;delivery.requestId=null;delivery.payload=null;
          this.takeovers.receive(this.store.get<Conversation>("channel_conversations",delivery.conversationId)!,delivery);
        } else {delivery.status = "error"; delivery.error = request.error?.message ?? "Core rejected this input."; this.save(delivery);}
      }
    } catch { /* Unknown input never becomes a new task. */ }
  }
  private async answer(conversation: Conversation, bindingId: string, text: string, details: SessionBindingDetails): Promise<Record<string, unknown> | null> {
    const match = /^\/answer\s+(\S+)\s+([\s\S]+)$/.exec(text);
    const question = match ? this.store.get<Question>("channel_questions", match[1]!) : null;
    const interaction = question ? details.core!.interactions.find(item => item.interactionId === question.interactionId) : null;
    if (!question || question.conversationId !== conversation.conversationId || question.bindingId !== bindingId || question.expiresAt < Date.now() || interaction?.status !== "pending" || interaction.authority !== "agent" || interaction.sensitive || interaction.turnId !== question.turnId || details.core!.interactionsError) fail("STALE_QUESTION", "Question token is expired or unavailable.");
    const response = match![2]!;
    if (/^\d+(,\d+)*$/.test(response)) {
      const indices = response.split(",").map(Number);
      if (indices.some(index => index < 1 || index > question.options.length)) fail("INVALID_INPUT", "Choose a displayed option number or use text: for a custom answer.");
      question.answer = indices.map(index => question.options[index - 1]!);
    } else { if (!question.allowCustom) fail("INVALID_INPUT", "This question accepts only the listed options."); question.answer = [response.startsWith("text:") ? response.slice(5) : response]; }
    this.store.put("channel_questions", question.token, question);
    const questions = this.store.list<Question>("channel_questions").filter(value => value.conversationId === conversation.conversationId && value.interactionId === interaction.interactionId && value.expiresAt > Date.now());
    const expected = interaction.details?.questions;
    if (!expected?.length || expected.some(value => value.secret)) fail("FORBIDDEN", "Question details are restricted or unavailable.");
    const answers = expected.map(value => questions.find(item => item.questionId === value.questionId));
    if (answers.some(value => !value?.answer)) return null;
    return { turnId: question.turnId, interactionId: question.interactionId, answers: answers.map(value => ({ questionId: value!.questionId, answers: value!.answer! })) };
  }
  private questions(conversation: Conversation, watch: Watch, interactions: CoreInteraction[]): void {
    for (const interaction of interactions.filter(value => value.turnId === watch.turnId && value.status === "pending")) {
      if (interaction.authority !== "agent" || interaction.sensitive || !interaction.details?.questions?.length || interaction.details.questions.some(value => value.secret)) {
        this.store.output(conversation, key(watch.watchId, interaction.interactionId, "operator"), `This task needs the Core operator. ${this.sessions.core.url ?? "Open Core to continue."}`); continue;
      }
      for (const question of interaction.details.questions) {
        if (this.store.list<Question>("channel_questions").some(value => value.conversationId === conversation.conversationId && value.interactionId === interaction.interactionId && value.questionId === question.questionId && value.expiresAt > Date.now())) continue;
        const token = randomBytes(6).toString("hex"), options = question.options?.map(value => value.label) ?? [];
        this.store.put("channel_questions", token, { token, conversationId: conversation.conversationId, bindingId: watch.bindingId, turnId: watch.turnId, interactionId: interaction.interactionId, questionId: question.questionId, options, allowCustom: question.allowCustom, answer: null, expiresAt: Date.now() + 15 * 60 * 1000 } satisfies Question);
        const prompt = `${question.header}\n${question.prompt}\n${question.options?.map((value, index) => `${index + 1}. ${value.label}: ${value.description}`).join("\n") ?? ""}\nReply: /answer ${token} <option number${question.allowCustom ? " or text:your answer" : ""}>`;
        this.store.output(conversation, key(watch.watchId, token), prompt, watch.bindingId, watch.turnId);
      }
    }
  }
  private async observe(watch: Watch): Promise<void> {
    const conversation = this.store.get<Conversation>("channel_conversations", watch.conversationId)!;
    if (!this.active(this.connection(conversation.connectionId)) || !this.automatic(watch.conversationId)) return;
    const details = await this.details(watch.bindingId);
    if (!this.automatic(watch.conversationId) || this.store.get<Watch>("channel_turns",watch.watchId)?.complete) return;
    const turn = details.core!.turns.find(value => value.turnId === watch.turnId);
    if (details.core!.contextAuthority !== "agent") {
      if (turn && terminal(turn.state)) { watch.complete = true; this.store.put("channel_turns", watch.watchId, watch); this.store.output(conversation, key(watch.watchId, "restricted"), `This conversation requires the Core operator. ${this.sessions.core.url ?? "Open Core to continue."}`); }
      return;
    }
    if (details.core!.interactionsError) return;
    this.questions(conversation, watch, details.core!.interactions);
    if (!turn || !terminal(turn.state)) return;
    if (turn.state !== "completed") { this.store.output(conversation, key(watch.watchId, "ended"), `Task ${turn.state}.`, watch.bindingId, watch.turnId); watch.complete = true; this.store.put("channel_turns", watch.watchId, watch); return; }
    if (!turn.codexTurnId) return;
    const page = await this.sessions.execute("readBindingHistory", { bindingId: watch.bindingId, cursor: watch.eventCursor, limit: 500, ...(watch.beforeCursor ? { beforeCursor: watch.beforeCursor } : watch.updateCursor ? { updateCursor: watch.updateCursor } : {}) }, "channel") as CoreHistory;
    if (!this.automatic(watch.conversationId) || this.store.get<Watch>("channel_turns",watch.watchId)?.complete) return;
    if (page.historyError || page.eventsError) return;
    watch.eventCursor = Math.max(watch.eventCursor, page.nextCursor); if (!watch.beforeCursor) watch.updateCursor = page.updateCursor;
    const messages = [...page.messages, ...page.liveMessages].filter(value => value.turnId === turn.codexTurnId && value.role === "assistant" && value.availability !== "restricted" && value.text && value.itemComplete === true);
    const finals = messages.filter(value => value.phase === "final_answer");
    if (!finals.length) { const fallback = messages.filter(value => value.phase === null).at(-1); if (fallback) finals.push(fallback); }
    for (const message of finals) for (const [index, chunk] of splitText(message.text).entries()) this.store.output(conversation, key(watch.watchId, message.id, index), chunk, watch.bindingId, watch.turnId);
    if (finals.length) watch.complete = true;
    else if (!watch.beforeCursor && page.beforeCursor) watch.beforeCursor = page.beforeCursor;
    else if (watch.beforeCursor) watch.beforeCursor = page.beforeCursor;
    this.store.put("channel_turns", watch.watchId, watch);
  }
  private async output(delivery: Delivery): Promise<void> {
    const conversation = this.store.get<Conversation>("channel_conversations", delivery.conversationId)!, connection = this.connection(conversation.connectionId);
    if (!this.active(connection) || (this.sendAfter.get(connection.connectionId) ?? 0) > Date.now()) return;
    if (delivery.suppressed || (delivery.source !== "operator" && !this.automatic(delivery.conversationId))) return;
    if (delivery.bindingId && delivery.source !== "operator") {
      try { const details = await this.details(delivery.bindingId); if (details.core!.contextAuthority !== "agent") { delivery.status = "error"; delivery.text = null; delivery.error = "Content requires the Core operator."; this.save(delivery); return; } if (details.core!.interactionsError) return; }
      catch { return; }
    }
    const adapter = this.running.get(connection.connectionId)?.adapter ?? this.factory?.(connection);
    if (!adapter || this.stopSignal.signal.aborted || !this.active(this.connection(connection.connectionId))) return;
    if (this.store.get<Delivery>("channel_deliveries",delivery.deliveryId)?.suppressed || (delivery.source !== "operator" && !this.automatic(delivery.conversationId))) return;
    delivery.status = "processing"; this.save(delivery); this.sendAfter.set(connection.connectionId, Date.now() + (this.options.sendIntervalMs ?? 3000));
    try { const connectionSignal = this.running.get(connection.connectionId)?.controller.signal; await adapter.send(this.secret(connection), conversation.address, delivery.text!, connectionSignal ? AbortSignal.any([this.stopSignal.signal, connectionSignal]) : this.stopSignal.signal); this.finish(delivery); }
    catch (error) { delivery.status = error instanceof DeliveryError && !error.uncertain ? "error" : "unknown"; delivery.error = "Platform delivery was not confirmed. Retry only this retained reply after review."; this.save(delivery); }
  }
}
