import { test } from "node:test";
import assert from "node:assert/strict";
import { TeamStore } from "../dist/store.js";
import { TeamApi } from "../dist/api.js";
import { SessionService } from "../dist/session-service.js";
import { ChannelRuntime } from "../dist/channels/runtime.js";
import { DeliveryError } from "../dist/channels/adapter.js";
import { DingTalkSender, getTextMessageBodyBytes, parseMessage, splitText, textMessageBodyBudgetBytes, textMessageBodyLimitBytes } from "../dist/channels/dingtalk/messages.js";
import { runStream } from "../dist/channels/dingtalk/stream.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const credential = { credentialRef: "synthetic-app", clientId: "synthetic-client", clientSecret: "synthetic-secret", robotCode: "synthetic-robot", corpId: "synthetic-org" };
class SyntheticCore {
  loseSend = false;
  offline = false;
  url = "http://127.0.0.1:3000/"; sessions = new Map(); operations = new Map(); calls = []; loseCreate = false;
  async call(operation, input) {
    this.calls.push({ operation, input: structuredClone(input) });
    if(this.offline)throw new Error("Synthetic Core offline");
    if (operation === "listHosts") return { hosts: [{ hostId: "host", name: "Host", status: "connected" }] };
    if (operation === "listWorkspaceProfiles") return { profiles: [{ profileId: "empty", name: "Empty", kind: "emptyDirectory" }] };
    if (operation === "getSession") return structuredClone(this.sessions.get(input.sessionId));
    if (operation === "readSessionHistory") { const view = this.sessions.get(input.sessionId); return { messages: view.messages ?? [], liveMessages: [], activities: [], events: [], nextCursor: 0, beforeCursor: null, afterCursor: null, updateCursor: "update", hasMoreUpdates: false, hasMore: false, historyError: null, eventsError: null }; }
    const id = operation + input.requestId;
    if (this.operations.has(id)) return structuredClone(this.operations.get(id));
    const sessionId = input.sessionId ?? `session-${this.sessions.size + 1}`;
    if (operation === "createSession") this.sessions.set(sessionId, { session: { sessionId, hostId: input.hostId, workDir: `/synthetic/sessions/${sessionId}`, workspace: { profileId: input.workspaceProfileId, status: "ready" }, connectionState: "connected", runtimeState: "idle", activeTurnId: null, sessionConfig: { agentRef: input.agentRef, overrides: input.sessionOptions, resolved: {} } }, contextAuthority: "agent", operations: [], turns: [], interactions: [], interactionsError: null });
    const view = this.sessions.get(sessionId);
    const turnId = operation === "sendMessage" ? `turn-${input.requestId}` : input.turnId ?? null;
    const result = { commandId: id, operation, sessionId, turnId, requestId: input.requestId, status: "delivered", createdAt: new Date().toISOString(), error: null };
    if(operation === "pauseSessionExecution")view.session.executionPause={pauseId:id,authority:"agent",createdAt:result.createdAt};
    if(operation === "resumeSessionExecution"){assert.equal(input.pauseId,view.session.executionPause.pauseId);view.session.executionPause=null;}
    if(operation === "appendSessionContext"){view.contextRecords??=[];if(!view.contextRecords.some(record=>record.contextId===input.contextId))view.contextRecords.push(structuredClone(input));}
    if (operation === "sendMessage") { view.session.activeTurnId = turnId; view.session.runtimeState = "running"; view.turns.push({ turnId, codexTurnId: `native-${turnId}`, state: "running" }); }
    if (operation === "connectSession") view.session.connectionState = "connected";
    if (operation === "answerQuestions") view.interactions.find(item => item.interactionId === input.interactionId).status = "resolved";
    if (operation === "interruptTurn") { view.session.activeTurnId = null; view.session.runtimeState = "interrupted"; view.turns.find(item => item.turnId === turnId).state = "interrupted"; }
    this.operations.set(id, result); view.operations.push(result);
    if (operation === "createSession" && this.loseCreate) { this.loseCreate = false; const error = new Error(); error.detail = { code: "DELIVERY_UNCERTAIN", message: "Lost reply", retryable: true }; throw error; }
    if (operation === "sendMessage" && this.loseSend) { this.loseSend = false; throw new Error("Synthetic lost send response"); }
    return structuredClone(result);
  }
  finish(sessionId, text = "Synthetic final answer") { const view = this.sessions.get(sessionId), turn = view.turns.at(-1); turn.state = "completed"; view.session.activeTurnId = null; view.session.runtimeState = "idle"; view.messages = [{ id: `message-${turn.turnId}`, turnId: turn.codexTurnId, role: "assistant", text, phase: "final_answer", itemComplete: true, turnStatus: "completed" }]; }
}
async function fixture(t) {
  const team = new TeamStore(":memory:"), core = new SyntheticCore(), api = new TeamApi(team, core, [credential]);
  const cleanup = [];
  const sent = []; let failReply = false;
  const adapter = { run: async () => {}, send: async (_credential, address, text) => { if (failReply) { failReply = false; throw new DeliveryError(true); } sent.push({ userId: address.userId, text }); } };
  const runtime = new ChannelRuntime(team, new SessionService(team, core), [credential], () => adapter, { sendIntervalMs: 0 });
  const { chatbot } = await runtime.execute("createChatbot", { name: "Editor", definitionId: "default", hostId: "host", workspaceProfileId: "empty", enabled: true, requestId: "bot" }, "operator");
  const { connection } = await runtime.execute("createChannelConnection", { chatbotId: chatbot.chatbotId, credentialRef: credential.credentialRef, enabled: true, requestId: "connection" }, "operator");
  const accept = async (messageId, userId, text) => runtime.accept(connection.connectionId, { messageId, userId, text, corpId: credential.corpId, conversationId: `external-${userId}`, webhook: "https://oapi.dingtalk.com/robot/sendBySession?session=synthetic", expiresAt: Date.now() + 3600000 });
  t.after(async () => { for (const close of cleanup) await close(); await runtime.close(); await api.channels.close(); team.close(); });
  return { cleanup, team, core, api, runtime, sent, accept, connection, failReply: () => { failReply = true; } };
}

test("identities map to isolated sessions; duplicate input, steering, Web binding and reply retries retain exact operations", async t => {
  const f = await fixture(t);
  await f.accept("m1", "user-a", "First task"); await f.accept("m1", "user-a", "First task"); await f.accept("m1", "user-b", "Other task"); await f.runtime.tick();
  assert.equal(f.core.sessions.size, 2); assert.equal(f.core.calls.filter(value => value.operation === "sendMessage").length, 2);
  await f.accept("m2", "user-a", "Correction"); await f.runtime.tick(); assert.equal(f.core.calls.filter(value => value.operation === "steerTurn").length, 1);
  f.core.finish("session-1", "Reply A"); f.core.finish("session-2", "Reply B"); f.failReply(); await f.runtime.tick();
  assert.ok(f.sent.some(value => value.userId === "user-b" && value.text === "Reply B"));
  let state = await f.runtime.execute("getChannels", {}, "operator");
  const uncertain = state.deliveries.find(value => value.direction === "output" && value.status === "unknown"); assert.ok(uncertain);
  const inputCount = f.core.calls.filter(value => ["sendMessage", "steerTurn"].includes(value.operation)).length;
  await f.runtime.execute("retryChannelDelivery", { deliveryId: uncertain.deliveryId, requestId: "retry" }, "operator"); await f.runtime.tick();
  assert.equal(f.core.calls.filter(value => ["sendMessage", "steerTurn"].includes(value.operation)).length, inputCount);
  assert.ok(f.sent.some(value => value.userId === "user-a" && value.text === "Reply A"));
  const direct = await f.api.execute("createAgentSession", { definitionId: "default", hostId: "host", workspaceProfileId: "empty", requestId: "direct" });
  const a = state.conversations.find(value => value.userId === "user-a"), b = state.conversations.find(value => value.userId === "user-b");
  await f.runtime.execute("bindChannelConversation", { conversationId: a.conversationId, bindingId: direct.binding.bindingId, requestId: "bind-a" }, "operator");
  await assert.rejects(f.runtime.execute("bindChannelConversation", { conversationId: b.conversationId, bindingId: direct.binding.bindingId, requestId: "bind-b" }, "operator"), error => error.detail.code === "BINDING_IN_USE");
  await f.accept("m3", "user-a", "Continue Web session"); await f.runtime.tick(); assert.equal(f.core.calls.filter(value => value.operation === "sendMessage").at(-1).input.sessionId, direct.binding.sessionId);
  await f.runtime.execute("bindChannelConversation", { conversationId: a.conversationId, bindingId: direct.binding.bindingId, requestId: "bind-a" }, "operator");
  state = await f.runtime.execute("getChannels", {}, "operator"); assert.ok(!JSON.stringify(state).includes(credential.clientSecret)); assert.ok(!JSON.stringify(state).includes("sendBySession"));
});

test("takeover suppresses automatic output, synchronizes transcript only, permits offline human sending and resumes only on new input",async t=>{
  const f=await fixture(t);
  await f.accept("initial","user-a","Initial task");await f.runtime.tick();
  const conversation=f.runtime.store.list("channel_conversations")[0],id=conversation.conversationId;
  f.runtime.store.output(conversation,"old-reply","Old answer",conversation.bindingId);
  await f.runtime.execute("beginChannelTakeover",{conversationId:id,requestId:"takeover"},"operator");
  await f.runtime.tick();await f.runtime.tick();
  let view=await f.runtime.execute("readChannelConversation",{conversationId:id},"operator");
  assert.equal(view.takeovers[0].phase,"active");assert.equal(view.corePause,"paused");
  const executionCount=f.core.calls.filter(c=>["sendMessage","steerTurn","answerQuestions"].includes(c.operation)).length;
  for(const [index,text] of ["/new","/stop","/status","/answer fake 1"].entries())await f.accept(`human-${index}`,"user-a",text);
  await f.runtime.tick();
  assert.equal(f.core.calls.filter(c=>["sendMessage","steerTurn","answerQuestions"].includes(c.operation)).length,executionCount);
  assert.equal(f.core.sessions.size,1);assert.ok(!f.sent.some(s=>s.text==="Old answer" || s.text==="Task interrupted."));
  f.core.offline=true;
  const sent=await f.runtime.execute("sendChannelMessage",{conversationId:id,message:"Human answer",requestId:"manual"},"operator");
  await f.runtime.tick();assert.ok(f.sent.some(s=>s.text==="Human answer" && s.userId==="user-a"));
  const retained=f.runtime.store.get("channel_contexts",sent.contextId);assert.equal(retained.text,"Human answer");
  retained.createdAt="2000-01-01T00:00:00.000Z";f.runtime.store.put("channel_contexts",sent.contextId,retained);
  await f.runtime.tick();assert.equal(f.runtime.store.get("channel_contexts",sent.contextId).text,"Human answer");
  f.core.offline=false;
  await f.runtime.execute("updateChannelConnection",{connectionId:f.connection.connectionId,enabled:false,requestId:"disable-takeover"},"operator");
  const callsBeforeDisabledTick=f.core.calls.length;await f.runtime.tick();
  assert.equal(f.core.calls.length,callsBeforeDisabledTick,"disabled connection stops takeover background calls");
  assert.equal(f.runtime.store.get("channel_contexts",sent.contextId).text,"Human answer");
  await f.runtime.execute("updateChannelConnection",{connectionId:f.connection.connectionId,enabled:true,requestId:"enable-takeover"},"operator");await f.runtime.tick();
  assert.equal(f.runtime.store.get("channel_contexts",sent.contextId).text,null);
  f.core.sessions.get("session-1").session.executionPause=null;
  view=await f.runtime.execute("readChannelConversation",{conversationId:id},"operator");assert.equal(view.corePause,"externallyResumed");
  assert.equal(view.conversation.mode,"human");
  await f.runtime.execute("endChannelTakeover",{conversationId:id,requestId:"end"},"operator");await f.runtime.tick();
  assert.equal(f.core.calls.filter(c=>["sendMessage","steerTurn"].includes(c.operation)).length,executionCount);
  assert.deepEqual(f.core.sessions.get("session-1").contextRecords.map(r=>r.source),["takeoverStart","user","user","user","user","operator","takeoverEnd"]);
  await f.accept("after","user-a","New task");await f.runtime.tick();
  assert.equal(f.core.calls.filter(c=>c.operation==="sendMessage").length,2);
  assert.equal(f.runtime.store.get("channel_deliveries","old-reply").status,"suppressed");
});

test("end boundary queues new input while context or delivery is unresolved; retries never rerun the agent",async t=>{
  const f=await fixture(t);await f.accept("initial","user-a","Task");await f.runtime.tick();
  const conversationId=f.runtime.store.list("channel_conversations")[0].conversationId;
  await f.runtime.execute("beginChannelTakeover",{conversationId,requestId:"begin"},"operator");await f.runtime.tick();await f.runtime.tick();
  f.failReply();await f.runtime.execute("sendChannelMessage",{conversationId,message:"Pending human send",requestId:"manual"},"operator");await f.runtime.tick();
  await f.runtime.execute("endChannelTakeover",{conversationId,requestId:"end"},"operator");
  await f.accept("queued","user-a","After boundary");await f.runtime.tick();
  assert.equal(f.core.calls.filter(c=>c.operation==="sendMessage").length,1);
  const uncertain=f.runtime.store.list("channel_deliveries").find(d=>d.source==="operator" && d.status==="unknown");
  await f.runtime.execute("retryChannelDelivery",{deliveryId:uncertain.deliveryId,requestId:"retry"},"operator");await f.runtime.tick();await f.runtime.tick();
  assert.equal(f.core.calls.filter(c=>c.operation==="sendMessage").length,2);
  assert.equal(f.core.calls.filter(c=>c.operation==="resumeSessionExecution").length,1);
  assert.equal(f.core.sessions.get("session-1").contextRecords.filter(r=>r.source==="operator").length,1);
});

test("takeover during a platform send keeps suppression after an uncertain result and can close it without claiming success",async t=>{
  const f=await fixture(t);await f.accept("task","user-a","Task");await f.runtime.tick();f.core.finish("session-1","Old response");
  const conversation=f.runtime.store.list("channel_conversations")[0];
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);
  f.runtime.factory=()=>({run:async()=>{},send:async()=>{entered();await new Promise(resolve=>release=resolve);throw new DeliveryError(true);}});
  const tick=f.runtime.tick();await waiting;
  await f.runtime.execute("beginChannelTakeover",{conversationId:conversation.conversationId,requestId:"begin-during-send"},"operator");release();await tick;
  const unknown=f.runtime.store.list("channel_deliveries").find(d=>d.direction==="output" && d.status==="unknown");assert.equal(unknown.suppressed,true);
  await assert.rejects(f.runtime.execute("retryChannelDelivery",{deliveryId:unknown.deliveryId,requestId:"forbidden-retry"},"operator"),e=>e.detail.code==="DELIVERY_SUPPRESSED");
  await f.runtime.execute("closeChannelDelivery",{deliveryId:unknown.deliveryId,requestId:"close"},"operator");
  const closed=f.runtime.store.get("channel_deliveries",unknown.deliveryId);assert.equal(closed.outcomeUnknown,true);assert.equal(closed.status,"suppressed");
});

test("ordinary question tokens require exact identity and current interaction; operator context blocks retained replies", async t => {
  const f = await fixture(t); await f.accept("task", "user-a", "Task"); await f.runtime.tick();
  const view = f.core.sessions.get("session-1"), turn = view.turns[0];
  view.interactions.push({ interactionId: "question-1", turnId: turn.turnId, kind: "questions", authority: "agent", sensitive: false, blocking: true, status: "pending", details: { questions: [{ questionId: "q1", header: "Choice", prompt: "Pick one", options: [{ label: "First", description: "One" }, { label: "Second", description: "Two" }], allowCustom: false, secret: false }, { questionId: "q2", header: "Details", prompt: "Supply details", options: null, allowCustom: true, secret: false }] } });
  await f.runtime.tick(); const token = f.runtime.store.list("channel_questions")[0].token;
  await f.accept("wrong", "user-b", `/answer ${token} 1`); await f.runtime.tick(); assert.equal(f.core.calls.filter(value => value.operation === "answerQuestions").length, 0);
  await f.accept("answer", "user-a", `/answer ${token} 2`); await f.runtime.tick();
  assert.equal(f.core.calls.filter(value => value.operation === "answerQuestions").length, 0, "collect every question before submission");
  const expired = f.runtime.store.list("channel_questions").find(value => value.questionId === "q2"); expired.expiresAt = Date.now() - 1; f.runtime.store.put("channel_questions", expired.token, expired);
  await f.accept("expired", "user-a", `/answer ${expired.token} text:Expired`); await f.runtime.tick();
  assert.equal(f.core.calls.filter(value => value.operation === "answerQuestions").length, 0);
  const current = f.runtime.store.list("channel_questions").find(value => value.questionId === "q2");
  await f.accept("details", "user-a", `/answer ${current.token} text:Current`); await f.runtime.tick();
  assert.deepEqual(f.core.calls.find(value => value.operation === "answerQuestions").input.answers, [{ questionId: "q1", answers: ["Second"] }, { questionId: "q2", answers: ["Current"] }]);
  assert.equal(f.runtime.store.list("channel_questions").length, 0, "confirmed answers are no longer retained");
  f.core.finish("session-1", "Restricted answer"); view.contextAuthority = "operator"; await f.runtime.tick();
  assert.ok(!f.sent.some(value => value.text.includes("Restricted answer")));
  await f.accept("new", "user-a", "/new"); await f.runtime.tick(); assert.equal(f.core.sessions.size, 2);
});

test("controls retain completed workspaces, refuse busy replacement and route new definition revisions separately", async t => {
  const f = await fixture(t);
  await f.accept("status-first", "user-a", "/status"); await f.runtime.tick(); assert.equal(f.core.sessions.size, 0);
  await f.accept("task", "user-a", "Task"); await f.runtime.tick();
  let state = await f.runtime.execute("getChannels", {}, "operator"), original = state.conversations[0].bindingId;
  await f.accept("busy-new", "user-a", "/new"); await f.runtime.tick(); assert.equal(f.core.sessions.size, 1);
  assert.equal(f.runtime.store.list("channel_conversations")[0].bindingId, original);
  const turnId = f.core.sessions.get("session-1").session.activeTurnId;
  await f.accept("stop", "user-a", "/stop"); await f.runtime.tick();
  assert.equal(f.core.calls.find(value => value.operation === "interruptTurn").input.turnId, turnId);
  assert.ok(f.sent.some(value => value.text === "Task interrupted."));
  await f.accept("new", "user-a", "/new"); await f.runtime.tick(); assert.equal(f.core.sessions.size, 2);
  const replacement = f.runtime.store.list("channel_conversations")[0].bindingId; assert.notEqual(replacement, original);
  const {definition} = f.api.execute("createAgentDefinition", {name:"Editor revision", sessionOptions:{instructionsAppend:"Frozen"},requestId:"definition"});
  state = await f.runtime.execute("getChannels", {}, "operator");
  await f.runtime.execute("updateChatbot", {chatbotId:state.chatbots[0].chatbotId,definitionId:definition.definitionId,requestId:"target"}, "operator");
  await f.accept("new-definition", "user-a", "Task with new definition"); await f.runtime.tick();
  f.api.execute("updateAgentDefinition", {definitionId:definition.definitionId,expectedRevision:"1",sessionOptions:{instructionsAppend:"Changed"},requestId:"edit"});
  state = await f.runtime.execute("getChannels", {}, "operator"); assert.equal(state.conversations.length, 2);
  const mapped = state.conversations.find(value=>value.definitionId===definition.definitionId);
  const details = await f.api.execute("getSessionBinding", {bindingId:mapped.bindingId});
  assert.equal(details.binding.memberId, null); assert.equal(details.binding.agentRef.revision, "1"); assert.equal(details.requestedOptions.instructionsAppend, "Frozen");
  assert.ok(details.requests.some(value=>value.operation==="createAgentSession"), "reads retain another caller's original creation record");
});

test("DingTalk identity parsing rejects foreign destinations and expired webhooks use OpenAPI without timeout fallback", async () => {
  const body = { conversationType: "1", senderCorpId: credential.corpId, senderStaffId: "user", robotCode: credential.robotCode, conversationId: "conversation", msgId: "message", sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=synthetic", sessionWebhookExpiredTime: Date.now() + 100000, msgtype: "text", text: { content: "Unicode 🙂\nText" } };
  const frame = changes => ({ type: "CALLBACK", headers: { messageId: "callback", topic: "/v1.0/im/bot/messages/get" }, data: JSON.stringify({ ...body, ...changes }) });
  assert.equal(parseMessage(frame({}), credential).text, body.text.content);
  assert.throws(() => parseMessage(frame({ senderCorpId: "other" }), credential)); assert.throws(() => parseMessage(frame({ sessionWebhook: "https://example.invalid/private" }), credential));
  assert.equal(textMessageBodyLimitBytes - textMessageBodyBudgetBytes, 1000);
  const withinBudget = "A".repeat(textMessageBodyBudgetBytes - getTextMessageBodyBytes(""));
  assert.deepEqual(splitText(withinBudget), [withinBudget]); assert.equal(splitText(withinBudget + "A").length, 2);
  assert.deepEqual(splitText("中文🙂".repeat(400)), ["中文🙂".repeat(400)], "ordinary replies stay in one message");
  const paragraph = "A".repeat(15000) + "\r\n \r\n" + "B".repeat(15000), line = "A".repeat(15000) + "\n" + "B".repeat(15000), sentence = "中文".repeat(2500) + "。" + "后续".repeat(1600) + "。";
  for (const text of ["🙂中文\n".repeat(4000), paragraph, line, sentence, "x".repeat(18900) + "🙂".repeat(1000), "word ".repeat(5000), "\"" + "A".repeat(30000) + "\"", " \n" + "🙂".repeat(8000), "\"\\\n\t\u0000".repeat(6000)]) {
    const chunks = splitText(text), parts = chunks.map(value => value.replace(/^\[\d+\/\d+\]\n/, ""));
    assert.equal(parts.join(""), text); assert.ok(parts.every(value => value.trim())); assert.ok(chunks.every(value => getTextMessageBodyBytes(value) <= textMessageBodyBudgetBytes), "count JSON escaping and part labels in the complete payload");
  }
  assert.ok(splitText(paragraph)[0].endsWith("\r\n \r\n")); assert.ok(splitText(line)[0].endsWith("\n")); assert.ok(splitText(sentence)[0].endsWith("。"));
  const calls = []; let timeout = false;
  const sender = new DingTalkSender(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); if (timeout) throw new Error("Synthetic timeout"); return Response.json(url.includes("accessToken") ? { accessToken: "synthetic-access", expireIn: 7200 } : url.includes("batchSend") ? { processQueryKey: "synthetic-query" } : { errcode: 0 }); });
  const address = { corpId: credential.corpId, userId: "user", webhook: body.sessionWebhook, expiresAt: 0 }; await sender.send(credential, address, "Reply", new AbortController().signal);
  assert.equal(calls[1].body.userIds[0], "user"); assert.equal(calls[1].body.robotCode, credential.robotCode);
  timeout = true; await assert.rejects(sender.send(credential, { ...address, expiresAt: Date.now() + 100000 }, "Reply", new AbortController().signal), error => error.uncertain);
  assert.equal(calls.length, 3, "uncertain webhook delivery must not call OpenAPI");
});

test("restart reconciles an uncertain original send and resumes reply delivery without creating or executing another session", async t => {
  const f = await fixture(t); f.core.loseSend = true;
  await f.accept("uncertain", "user-a", "Original input"); await f.runtime.tick();
  assert.equal(f.runtime.store.list("channel_deliveries").find(value => value.direction === "input").status, "unknown");
  f.core.finish("session-1", "Recovered final"); await f.runtime.close();
  const adapter = { run: async (_credentials, _receive, signal) => signal.aborted ? undefined : new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })), send: async (_credential, address, text) => f.sent.push({ userId: address.userId, text }) };
  const restored = new ChannelRuntime(f.team, new SessionService(f.team, f.core), [credential], () => adapter, { sendIntervalMs: 0 });
  f.cleanup.push(() => restored.close()); restored.start(); await restored.tick();
  assert.equal(f.core.sessions.size, 1); assert.equal(f.core.calls.filter(value => value.operation === "sendMessage").length, 1);
  assert.ok(f.sent.some(value => value.text === "Recovered final"));
  const duplicate = new ChannelRuntime(f.team, new SessionService(f.team, f.core), [credential], () => adapter);
  assert.throws(() => duplicate.start(), error => error.detail.code === "CHANNEL_IN_USE"); await duplicate.close();
  await restored.accept(f.connection.connectionId, { messageId: "uncertain", userId: "user-a", text: "Original input", corpId: credential.corpId, conversationId: "external-user-a", webhook: "https://oapi.dingtalk.com/robot/sendBySession?session=synthetic", expiresAt: Date.now() + 100000 });
  await restored.tick(); assert.equal(f.core.calls.filter(value => value.operation === "sendMessage").length, 1);
  const serialized = JSON.stringify(f.runtime.store.list("channel_deliveries")); assert.ok(!serialized.includes("Original input"));
});

test("confirmed state races choose a new operation, while disabling or shutting down stops further submission", async t => {
  const f=await fixture(t); await f.accept("first", "user-a", "First"); await f.runtime.tick(); f.core.finish("session-1"); await f.runtime.tick();
  const call=f.core.call.bind(f.core); let rejectIdle=true;
  f.core.call=async(operation,input)=>{
    if(operation==="sendMessage" && rejectIdle){rejectIdle=false; await call("sendMessage",{sessionId:input.sessionId,requestId:"independent-web-turn",message:"Web task"});
      const result={commandId:"rejected",operation,sessionId:input.sessionId,turnId:null,requestId:input.requestId,status:"error",error:{code:"SESSION_BUSY",message:"State changed",retryable:false}};
      f.core.operations.set(operation+input.requestId,result); f.core.sessions.get(input.sessionId).operations.push(result); return result;
    } return call(operation,input);
  };
  await f.accept("racing", "user-a", "Channel participation"); await f.runtime.tick(); await f.runtime.tick();
  assert.equal(f.core.calls.filter(value=>value.operation==="steerTurn").length,1);
  assert.equal(f.runtime.store.list("channel_deliveries").find(value=>value.direction==="input" && value.operation==="steerBindingTurn").status,"completed");
  f.core.finish("session-1", "🙂".repeat(8000)); f.core.sessions.get("session-1").messages[0].itemComplete=false; await f.runtime.tick();
  assert.ok(!f.sent.some(value=>value.text.startsWith("[1/")), "turn completion does not establish message completeness");
  f.core.sessions.get("session-1").messages[0].itemComplete=true; f.failReply(); await f.runtime.tick();
  assert.ok(!f.sent.some(value=>value.text.startsWith("[2/")), "later reply segments wait for the uncertain first segment");
  const reply=f.runtime.store.list("channel_deliveries").find(value=>value.direction==="output"&&value.status==="unknown");
  await f.runtime.execute("retryChannelDelivery",{deliveryId:reply.deliveryId,requestId:"segments"},"operator"); await f.runtime.tick();
  assert.ok(f.sent.some(value=>value.text.startsWith("[2/")));
  const submitted=f.core.calls.filter(value=>["sendMessage","steerTurn"].includes(value.operation)).length;
  let release, observed; const entered=new Promise(resolve=>observed=resolve); const held=new Promise(resolve=>release=resolve); let hold=true;
  f.core.call=async(operation,input)=>{if(operation==="getSession"&&hold){hold=false;observed();await held;}return call(operation,input);};
  await f.accept("pending", "user-a", "Retained while disabled"); const tick=f.runtime.tick(); await entered;
  await f.runtime.execute("updateChannelConnection",{connectionId:f.connection.connectionId,enabled:false,requestId:"disable"},"operator");
  release(); await tick; await f.runtime.close();
  assert.equal(f.core.calls.filter(value=>["sendMessage","steerTurn"].includes(value.operation)).length,submitted);
  assert.ok(f.runtime.store.list("channel_deliveries").some(value=>value.text==="Retained while disabled"&&value.status==="pending"));
});

test("loopback Stream callbacks acknowledge durable receipt and retain deduplication across reconnects", async t => {
  const f = await fixture(t), controller = new AbortController(), acknowledgements = []; let connections = 0, gatewayCalls = 0;
  const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(socketServer, "listening");
  const gateway = createServer((_request, response) => {
    if (++gatewayCalls === 1) { response.writeHead(500); response.end("{}"); return; }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ endpoint: `ws://127.0.0.1:${socketServer.address().port}`, ticket: "synthetic-ticket" }));
  }); gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  socketServer.on("connection", socket => {
    const round = ++connections;
    socket.on("message", raw => {
      const ack = JSON.parse(raw); acknowledgements.push(ack);
      if (ack.headers.messageId === `callback-${round}` && round === 1) socket.close();
    });
    socket.send(JSON.stringify({ type: "SYSTEM", headers: { messageId: `ping-${round}`, topic: "ping" }, data: '{"opaque":"synthetic"}' }));
    socket.send(JSON.stringify({ type: "CALLBACK", headers: { messageId: `callback-${round}`, topic: "/v1.0/im/bot/messages/get" }, data: JSON.stringify({ conversationType: "1", senderCorpId: credential.corpId, senderStaffId: "user-a", robotCode: credential.robotCode, conversationId: "external-user-a", msgId: "same-platform-message", msgtype: "text", text: { content: "Synthetic stream task" }, sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=synthetic", sessionWebhookExpiredTime: Date.now() + 100000 }) }));
  });
  const stream = runStream(credential, { signal: controller.signal, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, retryDelayMs: 1, handle: async frame => { await f.runtime.accept(f.connection.connectionId, parseMessage(frame, credential)); return { code: 200, headers: { messageId: frame.headers.messageId, contentType: "application/json" }, message: "OK", data: '{"response":null}' }; } });
  try {
    const end = Date.now() + 5000;
    while (!acknowledgements.some(value => value.headers.messageId === "callback-2") && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(acknowledgements.find(value => value.headers.messageId === "callback-2"), { code: 200, headers: { messageId: "callback-2", contentType: "application/json" }, message: "OK", data: '{"response":null}' });
    assert.equal(acknowledgements.find(value => value.headers.messageId === "ping-1").data, '{"opaque":"synthetic"}');
    await f.runtime.tick(); assert.equal(f.core.calls.filter(value => value.operation === "sendMessage").length, 1);
  } finally { controller.abort(); await stream; for (const socket of socketServer.clients) socket.terminate(); await Promise.all([new Promise(resolve => socketServer.close(resolve)), new Promise(resolve => gateway.close(resolve))]); }
});
