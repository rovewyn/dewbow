import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { ControlPlane } from "../dist/index.js";
import { now } from "@dewbow/core-protocol";
import { DatabaseSync } from "node:sqlite";

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for synthetic service state");
}

test("API and MCP share durable IDs, enforce interaction authority, and reconcile disconnects without duplicate history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dewbow-control-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const hostsFile = join(directory, "hosts.json");
  const permissions = [{ hostId: "host-1", name: "Synthetic host", token: "synthetic-daemon-credential" }];
  writeFileSync(hostsFile, JSON.stringify(permissions));
  const config = { host: "127.0.0.1", port, publicOrigin: origin, statePath: join(directory, "control.sqlite"), hostsFile,
    managementToken: "synthetic-management-credential", operatorPassword: "synthetic-operator-password", webRoot: directory };
  let service = new ControlPlane(config), socket;
  const received = [], events = [];
  const sessions = new Map(), turns = new Map(), interactions = new Map(), results = [];
  const native = Array.from({ length: 501 }, (_, i) => ({ id: `native-${i}`, codexHome: "/synthetic/codex-home", name: `Saved conversation ${i}`,
    workDir: "/synthetic/workspace", createdAt: now(), updatedAt: now(), archived: i === 0, kind: "session", parentId: null,
    forkedFromId: null, runtimeStatus: i === 1 ? "idle" : "unknown", hasActiveWriter: false }));
  const message = { id: "native-message", turnId: "native-turn", role: "assistant", text: "Saved native reply", phase: "final_answer", createdAt: now(), turnStatus: "completed" };
  const queried = [];
  const streamed = [];
  const headers = { "content-type": "application/json", connection: "close", authorization: `Bearer ${config.managementToken}` };
  const api = async (name, input = {}, auth = headers) => {
    const response = await fetch(`${origin}/api/${name}`, { method: "POST", headers: auth, body: JSON.stringify(input) });
    return response.json();
  };
  const mcp = async (method, params) => fetch(`${origin}/mcp`, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(response => response.json());
  const sendEvent = (session, type, payload = {}, turn = null) => {
    session.latestCursor++;
    const event = { eventId: `${session.sessionId}:${session.latestCursor}`, cursor: session.latestCursor, sessionId: session.sessionId,
      turnId: turn?.turnId ?? null, timestamp: now(), type, payload: { ...payload, session: structuredClone(session), ...(turn ? { turn: structuredClone(turn) } : {}) } };
    events.push(event); socket.send(JSON.stringify({ type: "event", event }));
  };
  async function connect() {
    socket = new WebSocket(`${origin.replace("http", "ws")}/hosts/connect`, { headers: { authorization: "Bearer synthetic-daemon-credential" } });
    socket.on("message", raw => {
      const frame = JSON.parse(raw);
      if (frame.type === "sync") {
        for (const event of events) socket.send(JSON.stringify({ type: "event", event }));
        socket.send(JSON.stringify({ type: "report", report: { sessions: [...sessions.values()], turns: [...turns.values()], interactions: [...interactions.values()], operations: results } }));
      } else if (frame.type === "command") received.push(frame.command);
      else if (frame.type === "query") {
        const query = frame.query; queried.push(query);
        const rows = [...native, { ...native[0], codexHome: "/synthetic/another-home" }, { ...native[0], id: "synthetic-codex-thread", name: "Owned conversation" }];
        const start = query.input.cursor ?? 0;
        const selectedEvents = events.filter(e => e.sessionId === query.input.sessionId && e.cursor > start);
        const page = selectedEvents.slice(0, query.input.limit ?? 100).map(e => { const { text, ...payload } = e.payload; return { ...e, payload }; });
        const result = query.operation === "readEvents" ? { events: page, nextCursor: page.at(-1)?.cursor ?? start, hasMore: selectedEvents.length > page.length, liveMessages: streamed.filter(m => m.sessionId === query.input.sessionId).map(({ sessionId, ...m }) => m) } : query.operation === "discoverSessions" ? { sessions: rows.slice(start, start + 500), observedAt: now(), sources: [{ source: "database", state: "success", error: null }], nextCursor: start + 500 < rows.length ? start + 500 : null }
          : query.operation === "readInteractions" ? {interactions:[...interactions.values()].filter(item=>item.sessionId===query.input.sessionId)} : { messages:[message],activities:[],observedAt:now(),beforeCursor:null,afterCursor:null,updateCursor:null,hasMoreUpdates:false };
        socket.send(JSON.stringify({ type: "query_result", response: { queryId: query.queryId, result } }));
      }
    });
    await once(socket, "open"); socket.send(JSON.stringify({ type: "hello", hostId: "host-1" }));
    await until(async () => (await api("listHosts")).result.hosts[0]?.status === "connected");
  }
  try {
    await service.start();
    assert.equal((await api("listHosts", {}, {})).error.code, "UNAUTHORIZED");
    const listed = (await mcp("tools/list")).result.tools;
    assert.deepEqual(listed.map(tool=>tool.name),["listHosts","listWorkspaceProfiles","listSessions","createSession","connectSession","getSession","readSessionHistory","getSessionActivity","readSessionContent","sendMessage","steerTurn","answerQuestions","interruptTurn"]);
    assert.deepEqual(listed.find(tool => tool.name === "createSession").inputSchema.required, ["hostId", "requestId"]);
    assert.equal(listed.find(tool => tool.name === "createSession").inputSchema.properties.sessionOptions.additionalProperties, false);
    assert.ok(listed.every(tool => Object.keys(tool.inputSchema.properties).every(key => /^[a-z][a-zA-Z0-9]*$/.test(key))));
    assert.equal((await api("sessions_create", {})).error.code, "INVALID_INPUT");
    assert.equal((await api("listSessions", { host_id: "host-1" })).error.code, "INVALID_INPUT");
    assert.equal((await mcp("tools/call", { name: "sessions_create", arguments: {} })).error.code, -32602);
    assert.equal((await mcp("tools/call", { name: "listSessions", arguments: { host_id: "host-1" } })).result.isError, true);
    assert.equal((await fetch(`${origin}/mcp`, { method: "POST", headers: { ...headers, origin: "https://untrusted.example" }, body: "{}" })).status, 403);
    const rejected = new WebSocket(`${origin.replace("http", "ws")}/hosts/connect`, { headers: { authorization: "Bearer invalid-credential" } });
    const rejectStatus = await new Promise(resolve => { rejected.on("unexpected-response", (_req, res) => { resolve(res.statusCode); res.resume(); rejected.terminate(); }); rejected.on("error", () => {}); });
    assert.equal(rejectStatus, 401);
    await connect();
    const options = { model: "synthetic-model", reasoningEffort: "high", instructionsAppend: "Review the article." };
    const agentRef = { id: "editor", revision: "1" };
    const create = { hostId: "host-1", workDir: "/synthetic/workspace", requestId: "create-1", agentRef, sessionOptions: options };
    for (const sessionOptions of [null, [], { reasoningEffort: 1 }, { instructionsAppend: null }, { instructionsAppend: "x".repeat(100001) }, { sandbox: "danger-full-access" }, { config: {} }, { mcpServers: {} }, { skills: [] }, { constructor: {} }, JSON.parse('{"__proto__":{}}')]) {
      assert.equal((await api("createSession", { ...create, sessionOptions })).error.code, "INVALID_INPUT");
    }
    assert.equal((await api("createSession", { ...create, agentRef: { id: "editor" } })).error.code, "INVALID_INPUT");
    const created = (await api("createSession", create)).result;
    assert.equal((await api("createSession", create)).result.sessionId, created.sessionId);
    assert.equal((await mcp("tools/call", { name: "createSession", arguments: { ...create, agentRef: { revision: "1", id: "editor" }, sessionOptions: { instructionsAppend: options.instructionsAppend, reasoningEffort: "high", model: "synthetic-model" } } })).result.structuredContent.sessionId, created.sessionId);
    assert.equal((await api("createSession", { ...create, workDir: "/other" })).error.code, "REQUEST_CONFLICT");
    assert.equal((await api("createSession", { ...create, sessionOptions: { ...options, instructionsAppend: "Different instructions." } })).error.code, "REQUEST_CONFLICT");
    assert.equal((await api("createSession", { ...create, agentRef: { ...agentRef, revision: "2" } })).error.code, "REQUEST_CONFLICT");
    await until(() => received.length === 1);
    assert.deepEqual(received[0].input.sessionOptions, options); assert.deepEqual(received[0].input.agentRef, agentRef);
    const acceptedConfig = (await api("getSession", { sessionId: created.sessionId })).result.session.sessionConfig;
    assert.deepEqual(acceptedConfig, { overrides: options, agentRef, resolved: null });
    const sessionConfig = { ...acceptedConfig, resolved: { model: "synthetic-model", modelProvider: "openai", reasoningEffort: "high",
      developerInstructions: "Host baseline.\n\nReview the article.", approvalPolicy: "on-request", approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } } };
    let session = { sessionId: created.sessionId, hostId: "host-1", workDir: create.workDir, codexThreadId: "synthetic-codex-thread",
      sessionConfig,
      createdAt: now(), runtimeState: "idle", connectionState: "connected", connectionConfirmedAt: now(), observedAt: now(), lastKnownState: "idle", lastKnownAt: now(), activeTurnId: null, latestCursor: 0 };
    sessions.set(session.sessionId, session); sendEvent(session, "session_created");
    results.push({ commandId: created.commandId, status: "delivered", error: null });
    socket.send(JSON.stringify({ type: "result", result: results.at(-1) }));
    await until(async () => (await api("getSession", { sessionId: session.sessionId })).result.session.codexThreadId);
    const changedSession = structuredClone(session);
    changedSession.sessionConfig.resolved.developerInstructions = "Mutated snapshot.";
    socket.send(JSON.stringify({ type: "event", event: { eventId: `${session.sessionId}:2`, cursor: 2, sessionId: session.sessionId,
      turnId: null, timestamp: now(), type: "session_connected", payload: { session: changedSession } } }));
    await once(socket, "close");
    assert.deepEqual((await api("getSession", { sessionId: session.sessionId })).result.session.sessionConfig, sessionConfig);
    await connect();
    const inventory = (await api("listSessions")).result;
    assert.equal(inventory.sessions.length, 503);
    assert.equal(new Set(inventory.sessions.filter(s => s.codexThreadId === native[0].id).map(s => s.sessionId)).size, 2);
    assert.equal(inventory.sessions.filter(s => s.codexThreadId === session.codexThreadId).length, 1);
    assert.equal(inventory.sessions.find(s => s.sessionId === session.sessionId).name, "Owned conversation");
    assert.equal(queried.filter(q => q.operation === "discoverSessions").length, 2);
    const discovered = inventory.sessions.find(s => !s.managed);
    assert.equal((await api("getSession", { sessionId: discovered.sessionId })).result.session.managed, false);
    assert.deepEqual((await api("readSessionHistory", { sessionId: discovered.sessionId })).result.messages, [message]);
    assert.equal((await api("sendMessage", { sessionId: discovered.sessionId, requestId: "read-only", message: "Do not run" })).error.code, "SESSION_NOT_CONNECTED");
    const connectInput = { sessionId: discovered.sessionId, requestId: "connect-native" };
    const connecting = (await api("connectSession", connectInput)).result;
    assert.equal(connecting.sessionId, discovered.sessionId);
    assert.equal((await api("connectSession", connectInput)).result.commandId, connecting.commandId);
    assert.equal((await api("connectSession", { ...connectInput, sessionOptions: options })).error.code, "INVALID_INPUT");
    assert.equal((await api("connectSession", { ...connectInput, requestId: "parallel-connect" })).error.code, "SESSION_NOT_READY");
    assert.equal((await api("sendMessage", { sessionId: discovered.sessionId, requestId: "before-connect", message: "Wait for resume" })).error.code, "SESSION_NOT_READY");
    const adopted = { ...discovered, codexHome: discovered.native.codexHome, runtimeState: "idle", connectionConfirmedAt: now(), connectionState: "connected", latestCursor: 0 };
    delete adopted.native; delete adopted.managed; delete adopted.name;
    sessions.set(adopted.sessionId, adopted); sendEvent(adopted, "session_connected");
    results.push({ commandId: connecting.commandId, status: "delivered", error: null });
    socket.send(JSON.stringify({ type: "result", result: results.at(-1) }));
    await until(async () => (await api("getSession", { sessionId: adopted.sessionId })).result.session.connectionState === "connected");
    assert.equal((await api("listSessions")).result.sessions.filter(s => s.codexThreadId === discovered.codexThreadId && s.native?.codexHome === discovered.native.codexHome).length, 1);
    const nativeSend = await api("sendMessage", { sessionId: adopted.sessionId, requestId: "native-followup", message: "Continue saved conversation" });
    assert.equal(nativeSend.result.sessionId, discovered.sessionId);
    const input = { sessionId: session.sessionId, message: "Synthetic message", requestId: "send-1" };
    const sent = (await api("sendMessage", input)).result;
    assert.equal((await api("sendMessage", input)).result.turnId, sent.turnId);
    assert.equal((await api("sendMessage", { ...input, requestId: "send-busy" })).error.code, "SESSION_BUSY");
    assert.equal((await api("getSession", { sessionId: session.sessionId })).result.session.runtimeState, "idle");
    const database = new DatabaseSync(config.statePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS n FROM records WHERE kind='session'").get().n, 2);
    assert.equal(database.prepare("SELECT count(*) AS n FROM records WHERE json_type(value,'$.input.message') IS NOT NULL").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='events'").get().n, 0);
    database.close();
    let turn = { turnId: sent.turnId, sessionId: session.sessionId, requestId: input.requestId, codexTurnId: "synthetic-codex-turn",
      state: "awaiting_approval", createdAt: now(), observedAt: now(), error: null };
    results.push({ commandId: sent.commandId, status: "delivered", error: null });
    socket.send(JSON.stringify({ type: "result", result: results.at(-1) }));
    turns.set(turn.turnId, turn); session.activeTurnId = turn.turnId; session.runtimeState = "awaiting_approval";
    const interaction = { interactionId:"interaction-1",sessionId:session.sessionId,turnId:turn.turnId,itemId:"synthetic-item",kind:"approval",authority:"operator",blocking:true,sensitive:false,
      details:{action:{command:"synthetic action"}},content:{contentId:"synthetic-content",kind:"output",label:"Interaction details",byteLength:100,availability:"available",completeness:"complete",authority:"agent"},status:"pending",decision:null,requestId:null,createdAt:now(),observedAt:now() };
    interactions.set(interaction.interactionId, interaction); sendEvent(session, "approval_requested", { interaction }, turn);
    await until(async () => (await api("getSession", { sessionId: session.sessionId })).result.interactions.length);
    const decision = { sessionId: session.sessionId, turnId: turn.turnId, interactionId: interaction.interactionId, decision: "allow",requestId:"decision-1" };
    assert.equal((await api("decideApproval", decision)).error.code, "FORBIDDEN");
    const login = await fetch(`${origin}/auth/login`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ password: config.operatorPassword }) });
    const operator = { "content-type": "application/json", connection: "close", cookie: login.headers.get("set-cookie").split(";")[0] };
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await api("decideApproval", { ...decision, turnId: "stale" }, operator)).error.code, "STALE_TURN");
    const decided = (await api("decideApproval", decision, operator)).result;
    assert.equal((await api("decideApproval", decision, operator)).result.commandId, decided.commandId);
    await until(()=>received.filter(command=>command.commandId === decided.commandId).length===2);
    socket.send(JSON.stringify({type:"result",result:{commandId:decided.commandId,status:"unknown",error:{code:"DELIVERY_UNCERTAIN",message:"Synthetic lost response",retryable:true}}}));
    await until(async()=>(await api("getSession",{sessionId:session.sessionId})).result.operations.find(op=>op.commandId===decided.commandId)?.status === "unknown");
    assert.equal((await api("decideApproval",decision,operator)).result.commandId,decided.commandId);
    await until(()=>received.filter(command=>command.commandId === decided.commandId).length===3);
    assert.equal((await api("decideApproval", { ...decision, decision: "deny" }, operator)).error.code, "REQUEST_CONFLICT");
    const ordinary={...interaction,interactionId:"ordinary-question",kind:"questions",authority:"agent",details:{questions:[{questionId:"constructor",header:"Choice",prompt:"Choose",options:null,allowCustom:true,secret:false}]} };
    interactions.set(ordinary.interactionId,ordinary);sendEvent(session,"interaction_requested",{interaction:ordinary},turn);
    await until(async()=>(await api("getSession",{sessionId:session.sessionId})).result.interactions.some(item=>item.interactionId===ordinary.interactionId));
    const answering={sessionId:session.sessionId,turnId:turn.turnId,interactionId:ordinary.interactionId,requestId:"bad-answer",answers:[{questionId:"missing",answers:["synthetic-private-answer"]}]};
    const badAnswer=(await api("answerQuestions",answering)).result;
    socket.send(JSON.stringify({type:"result",result:{commandId:badAnswer.commandId,status:"error",error:{code:"INVALID_INPUT",message:"Synthetic invalid answer",retryable:false}}}));
    await until(async()=>(await api("getSession",{sessionId:session.sessionId})).result.interactions.find(item=>item.interactionId===ordinary.interactionId)?.status === "pending");
    const validAnswer=(await api("answerQuestions",{...answering,requestId:"correct-answer",answers:[{questionId:"constructor",answers:["synthetic-private-answer"]}]})).result;
    assert.equal(validAnswer.status,"accepted");
    const journalRead=new DatabaseSync(config.statePath,{readOnly:true});
    assert.ok(!JSON.stringify(journalRead.prepare("SELECT * FROM records").all()).includes("synthetic-private-answer"));journalRead.close();
    assert.equal((await api("interruptTurn", { sessionId: session.sessionId, turnId: "stale", requestId: "interrupt-stale" })).error.code, "STALE_TURN");
    const interruption = (await api("interruptTurn", { sessionId: session.sessionId, turnId: turn.turnId, requestId: "interrupt-1" })).result;
    assert.equal(interruption.status, "accepted");
    socket.terminate();
    await until(async () => (await api("listHosts")).result.hosts[0].status === "disconnected");
    assert.equal((await api("getSession", { sessionId: session.sessionId })).result.session.runtimeState, "unknown");
    assert.equal((await api("sendMessage", { ...input, requestId: "offline-send" })).error.code, "HOST_UNAVAILABLE");
    await connect();
    assert.equal((await api("getSession", { sessionId: session.sessionId })).result.session.runtimeState, "awaiting_approval");
    turn.state = "interrupted"; session.activeTurnId = null; session.runtimeState = "interrupted";
    sendEvent(session, "turn_completed", {}, turn);
    await until(async () => (await api("getSession", { sessionId: session.sessionId })).result.session.activeTurnId === null);
    const reply = { ...message, id: "streamed-item", turnId: turn.codexTurnId, text: "Volatile streamed reply", turnStatus: "inProgress", sessionId: session.sessionId };
    streamed.push(reply);
    sendEvent(session, "assistant_delta", { itemId: reply.id, text: reply.text }, turn);
    sendEvent(session, "tool_activity", { command: "synthetic tool action", itemType: "commandExecution" }, turn);
    const history = (await api("readSessionHistory", { sessionId: session.sessionId })).result;
    assert.equal(history.liveMessages[0].text, reply.text);
    assert.ok(history.events.every(e => e.payload.text === undefined));
    const firstPage = (await api("readSessionHistory", { sessionId: session.sessionId, limit: 1 })).result;
    assert.equal(firstPage.events.length, 1); assert.equal(firstPage.hasMore, true);
    const secondPage = (await api("readSessionHistory", { sessionId: session.sessionId, cursor: firstPage.nextCursor, limit: 1 })).result;
    assert.equal(secondPage.events[0].cursor, firstPage.nextCursor + 1);
    assert.deepEqual(history.events.map(e => e.cursor), [1, 2, 3, 4, 5, 6]);
    const rpc = await mcp("tools/call", { name: "readSessionHistory", arguments: { sessionId: session.sessionId } });
    assert.deepEqual(rpc.result.structuredContent, history);
    await service.stop(); service = new ControlPlane(config); await service.start();
    assert.equal((await api("getSession", { sessionId: session.sessionId })).result.session.runtimeState, "interrupted");
    assert.equal((await api("createSession", create)).result.sessionId, session.sessionId);
    assert.deepEqual((await api("getSession", { sessionId: session.sessionId })).result.session.sessionConfig, sessionConfig);
    const offline = (await api("readSessionHistory", { sessionId: session.sessionId })).result;
    assert.deepEqual(offline.events, []); assert.equal(offline.nextCursor, 0);
    assert.equal(offline.eventsError.code, "HOST_UNAVAILABLE");
    assert.equal(offline.historyError.code, "HOST_UNAVAILABLE");
    await connect();
    const reloaded = (await api("readSessionHistory", { sessionId: session.sessionId })).result;
    assert.deepEqual(reloaded.events, history.events);
    assert.equal(reloaded.liveMessages[0].text, reply.text);
    const central = new DatabaseSync(config.statePath, { readOnly: true });
    assert.equal(central.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='events'").get().n, 0);
    assert.ok(central.prepare("SELECT value FROM records").all().every(row => !row.value.includes(reply.text) && !row.value.includes("synthetic tool action")));
    const persisted = JSON.parse(central.prepare("SELECT value FROM records WHERE kind='session' AND id=?").get(session.sessionId).value);
    assert.equal(persisted.sessionId, session.sessionId); assert.equal(persisted.hostId, "host-1");
    assert.equal(persisted.codexThreadId, "synthetic-codex-thread");
    assert.deepEqual(persisted.sessionConfig, sessionConfig);
    assert.equal(persisted.session_id, undefined); assert.equal(persisted.host_id, undefined);
    central.close();
    const pendingInput = { ...input, requestId: "pending-restart", message: "Volatile retry input" };
    const pendingOperation = (await api("sendMessage", pendingInput)).result;
    await service.stop(); service = new ControlPlane(config); await service.start(); await connect();
    assert.equal((await api("getSession", { sessionId: session.sessionId })).result.session.activeTurnId, pendingOperation.turnId);
    assert.equal((await api("sendMessage", { ...pendingInput, requestId: "must-stay-busy" })).error.code, "SESSION_BUSY");
    const receivedBefore = received.length;
    assert.equal((await api("sendMessage", pendingInput)).result.commandId, pendingOperation.commandId);
    await until(() => received.length > receivedBefore);
    assert.equal(received.at(-1).input.message, pendingInput.message);
    const unavailableNative = inventory.sessions.find(s => s.codexThreadId === "native-1");
    const beforeFailedConnection = (await api("getSession", { sessionId: unavailableNative.sessionId })).result.session.runtimeState;
    assert.equal(beforeFailedConnection, "idle");
    const failedConnectInput = { sessionId: unavailableNative.sessionId, requestId: "connect-unavailable" };
    const failedConnect = (await api("connectSession", failedConnectInput)).result;
    socket.send(JSON.stringify({ type: "result", result: { commandId: failedConnect.commandId, status: "error", error: { code: "NOT_FOUND", message: "Native conversation is unavailable.", retryable: false } } }));
    await until(async () => (await api("getSession", { sessionId: unavailableNative.sessionId })).result.session.connectionState === "error");
    assert.equal((await api("getSession", { sessionId: unavailableNative.sessionId })).result.session.runtimeState, beforeFailedConnection);
    assert.equal((await api("sendMessage", { sessionId: unavailableNative.sessionId, requestId: "after-failed-connect", message: "Must not execute" })).error.code, "SESSION_NOT_READY");
    assert.equal((await api("connectSession", { ...failedConnectInput, requestId: "retry-connect" })).result.status, "accepted");
    const privateTurn={...turn,turnId:pendingOperation.turnId,codexTurnId:"private-native-turn",state:"awaiting_input"};
    session.activeTurnId=privateTurn.turnId;turns.set(privateTurn.turnId,privateTurn);
    const secret={...ordinary,interactionId:"secret-question",turnId:privateTurn.turnId,authority:"operator",sensitive:true,details:{questions:[{questionId:"secret",header:"Secret",prompt:"Private",options:null,allowCustom:true,secret:true}],answers:[{questionId:"secret",answers:["synthetic-secret-answer"]}]}};
    interactions.set(secret.interactionId,secret);sendEvent(session,"interaction_requested",{interaction:secret},privateTurn);
    await until(async()=>(await api("getSession",{sessionId:session.sessionId})).result.interactions.some(item=>item.interactionId===secret.interactionId));
    assert.equal((await api("getSession",{sessionId:session.sessionId})).result.interactions.find(item=>item.interactionId===secret.interactionId).details,undefined);
    const privateHistory=(await api("readSessionHistory",{sessionId:session.sessionId})).result;
    assert.ok(privateHistory.messages.every(item=>item.text==="" && item.availability === "restricted"));
    assert.ok(privateHistory.liveMessages.every(item=>item.text==="" && item.availability === "restricted"));
    assert.equal((await api("readSessionContent",{sessionId:session.sessionId,contentId:secret.content.contentId})).error.code,"FORBIDDEN");
    assert.equal((await api("sendMessage",{sessionId:session.sessionId,requestId:"repeat-secret",message:"Repeat previous input"})).error.code,"FORBIDDEN");
    assert.equal((await api("sendMessage",pendingInput)).result.commandId,pendingOperation.commandId,"Private context still permits reconciliation of an existing request.");
    assert.equal((await api("getSession",{sessionId:session.sessionId},operator)).result.interactions.find(item=>item.interactionId===secret.interactionId).details.answers[0].answers[0],"synthetic-secret-answer");
    permissions[0].revoked = true; writeFileSync(hostsFile, JSON.stringify(permissions));
    assert.equal((await api("sendMessage", { ...input, requestId: "after-restart" })).error.code, "FORBIDDEN");
    assert.equal((await api("listHosts")).result.hosts[0].status, "revoked");
    const revoked = new WebSocket(`${origin.replace("http", "ws")}/hosts/connect`, { headers: { authorization: "Bearer synthetic-daemon-credential" } });
    const revokedStatus = await new Promise(resolve => { revoked.on("unexpected-response", (_req, res) => { resolve(res.statusCode); res.resume(); revoked.terminate(); }); revoked.on("error", () => {}); });
    assert.equal(revokedStatus, 401);
  } finally { socket?.terminate(); await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});
