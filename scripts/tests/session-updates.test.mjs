import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { get } from "node:http";
import { ControlPlane } from "../../apps/core-control-plane/dist/index.js";
import { TeamStore } from "../../apps/team-backend/dist/store.js";
import { TeamApi } from "../../apps/team-backend/dist/api.js";
import { CoreClient } from "../../apps/team-backend/dist/core-client.js";
import { createTeamServer } from "../../apps/team-backend/dist/server.js";
import { readEventStream } from "@dewbow/core-protocol/stream";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await wait(10); }
  throw new Error("Synthetic subscription did not advance.");
}

test("Core and Team SSE preserve updates, reconnect cursors, authority and channel speaking boundaries", async t => {
  const directory = mkdtempSync(join(tmpdir(), "dewbow-updates-"));
  const hostId = "synthetic-host", coreToken = "synthetic-core-management-token", teamToken = "synthetic-team-operator-token";
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([{ hostId, name: "Synthetic host", token: "synthetic-host-token" }]));
  const coreConfig = { host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1:0", statePath: join(directory, "core.sqlite"), hostsFile: join(directory, "hosts.json"), managementToken: coreToken, operatorPassword: "synthetic-core-operator-password", webRoot: directory };
  const plane = new ControlPlane(coreConfig), store = new TeamStore(join(directory, "team.sqlite")), connections = [];
  let server, historyReads = 0, dispatched = 0, events = [], live = [], items = [], contexts = [], blockedRead;
  t.after(async () => {
    for (const connection of connections) connection.abort();
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await plane.stop(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await plane.start(); coreConfig.publicOrigin = `http://127.0.0.1:${plane.address().port}`;
  const management = plane.gateway.management;
  plane.store.put("host", hostId, { hostId, name: "Synthetic host", status: "connected", lastSeenAt: new Date().toISOString() });
  management.dispatch = () => { dispatched++; };
  management.query = async (_hostId, operation, input) => {
    if (operation === "readInteractions") return { interactions: plane.store.list("interaction") };
    if (operation === "readEvents") {
      const selected = events.filter(event => event.cursor > input.cursor).slice(0, input.limit);
      return { events: selected, nextCursor: selected.at(-1)?.cursor ?? input.cursor, hasMore: false, liveMessages: structuredClone(live) };
    }
    if (operation === "readSessionHistory") {
      historyReads++;
      const ordinal = input.updateCursor ? Number(input.updateCursor.split("-")[1]) : 0;
      const remaining = items.filter(item => item.updatedOrdinal > ordinal), selected = input.updateCursor ? remaining.slice(0, input.limit) : remaining.slice(-input.limit);
      const result = { messages: structuredClone(selected), activities: [], contextRecords: contexts.filter(record => record.sequence > (input.contextCursor ?? 0)), contextCursor: contexts.at(-1)?.sequence ?? 0, beforeContextCursor: null, hasMoreContexts: false,
        observedAt: new Date().toISOString(), beforeCursor: null, afterCursor: null, updateCursor: `update-${selected.at(-1)?.updatedOrdinal ?? ordinal}`, hasMoreUpdates: Boolean(input.updateCursor && remaining.length > selected.length) };
      if (blockedRead) { const gate = blockedRead; blockedRead = null; await gate; }
      return result;
    }
    throw new Error("Unexpected synthetic native query.");
  };
  const credential = { credentialRef: "synthetic-app", clientId: "synthetic-client", clientSecret: "synthetic-secret", corpId: "synthetic-org", robotCode: "synthetic-robot" };
  const api = new TeamApi(store, new CoreClient(coreConfig.publicOrigin, coreToken), [credential]);
  const created = await api.execute("createAgentSession", { definitionId: "default", hostId, workspaceProfileId: "empty", requestId: "create" });
  const sessionId = created.binding.sessionId, timestamp = new Date().toISOString();
  plane.store.put("session", sessionId, { ...plane.store.get("session", sessionId), codexThreadId: "synthetic-native-thread", workDir: "/synthetic/session", connectionState: "connected", runtimeState: "idle",
    workspace: { kind: "emptyDirectory", profileId: "empty", workDir: "/synthetic/session", directoryIdentity: "synthetic-directory", repository: null, baseCommit: null, branch: null, status: "ready" } });
  management.result(hostId, { commandId: created.operation.commandId, status: "delivered", error: null });
  const { chatbot } = await api.execute("createChatbot", { name: "Synthetic bot", definitionId: "default", hostId, workspaceProfileId: "empty", enabled: true, requestId: "bot" });
  const { connection } = await api.execute("createChannelConnection", { chatbotId: chatbot.chatbotId, credentialRef: credential.credentialRef, enabled: false, requestId: "connection" });
  const conversationId = "synthetic-conversation";
  api.channels.store.put("channel_conversations", conversationId, { conversationId, connectionId: connection.connectionId, definitionId: "default", corpId: credential.corpId, userId: "synthetic-user", externalConversationId: "synthetic-external", bindingId: null, pendingBindingId: null, generation: 0, updatedAt: timestamp, address: { corpId: credential.corpId, userId: "synthetic-user", webhook: "https://oapi.dingtalk.com/robot/sendBySession", expiresAt: 0 } });
  await api.execute("bindChannelConversation", { conversationId, bindingId: created.binding.bindingId, requestId: "bind" });
  const teamConfig = { publicOrigin: "http://127.0.0.1:0", operatorToken: teamToken, webDir: directory };
  server = createTeamServer(teamConfig, (...args) => api.execute(...args), (...args) => api.subscribe(...args));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); teamConfig.publicOrigin = `http://127.0.0.1:${server.address().port}`;
  async function subscribe(origin, path, credentialHeaders) {
    const controller = new AbortController(); connections.push(controller);
    const response = await fetch(origin + path, { headers: credentialHeaders, signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const frames = [];
    const done = (async () => { for await (const frame of readEventStream(response.body)) frames.push(frame); })().catch(error => { if (!controller.signal.aborted) throw error; });
    return { frames, done, abort: () => controller.abort() };
  }
  assert.equal((await fetch(`${teamConfig.publicOrigin}/api/subscribeBindingUpdates?bindingId=${created.binding.bindingId}`)).status, 401);
  assert.equal((await fetch(`${coreConfig.publicOrigin}/api/subscribeSessionUpdates?sessionId=${sessionId}`, { headers: { Authorization: `Bearer ${teamToken}` } })).status, 401);
  assert.equal((await fetch(`${teamConfig.publicOrigin}/api/subscribeBindingUpdates?bindingId=${created.binding.bindingId}&conversationId=${conversationId}`, { headers: { Authorization: `Bearer ${teamToken}` } })).status, 400);
  assert.equal((await fetch(`${coreConfig.publicOrigin}/api/subscribeSessionUpdates?sessionId=${sessionId}&cursor=invalid`, { headers: { Authorization: `Bearer ${coreToken}` } })).status, 400);
  for (const target of [
    { object: management, method: "call", operation: "getSession", server: plane.server, changes: plane.store.changes, origin: coreConfig.publicOrigin, path: `/api/subscribeSessionUpdates?sessionId=${sessionId}`, token: coreToken },
    { object: api, method: "execute", operation: "getSessionBinding", server, changes: store.changes, origin: teamConfig.publicOrigin, path: `/api/subscribeBindingUpdates?bindingId=${created.binding.bindingId}`, token: teamToken },
  ]) {
    let release, entered, disconnected, finished, blocked = false, subscriptions = 0;
    const ready = new Promise(resolve => { entered = resolve; });
    const closed = new Promise(resolve => { disconnected = resolve; });
    const completed = new Promise(resolve => { finished = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const original = target.object[target.method], originalSubscribe = target.changes.subscribe;
    target.object[target.method] = async (...args) => {
      if (!blocked && args[0] === target.operation) {
        blocked = true; entered(); await gate;
        const result = await original.apply(target.object, args); finished(); return result;
      }
      return original.apply(target.object, args);
    };
    target.changes.subscribe = (...args) => { subscriptions++; return originalSubscribe.apply(target.changes, args); };
    target.server.once("request", (_request, response) => response.once("close", disconnected));
    const request = get(target.origin + target.path, { headers: { Authorization: `Bearer ${target.token}` } });
    request.on("error", () => {});
    try {
      await ready; request.destroy(); await closed; release(); await completed; await wait(0);
      assert.equal(subscriptions, 0, "disconnected clients never start subscriptions after a preflight read");
    } finally {
      release(); request.destroy(); target.object[target.method] = original; target.changes.subscribe = originalSubscribe;
    }
  }
  const coreStream = await subscribe(coreConfig.publicOrigin, `/api/subscribeSessionUpdates?sessionId=${sessionId}`, { Authorization: `Bearer ${coreToken}` });
  const teamStream = await subscribe(teamConfig.publicOrigin, `/api/subscribeChannelConversationUpdates?conversationId=${conversationId}`, { Authorization: `Bearer ${teamToken}` });
  await until(() => coreStream.frames.some(frame => frame.event === "snapshot") && teamStream.frames.some(frame => frame.data.history));
  assert.equal(teamStream.frames.find(frame => frame.data.details)?.data.details.channelConversationId, conversationId);
  let wrongTargetCalls = 0;
  const wrongTarget = new TeamApi(store, { url: "https://different-core.example/", call: async () => { wrongTargetCalls++; throw new Error("Wrong target"); }, subscribeSessionUpdates: async () => { wrongTargetCalls++; throw new Error("Wrong target"); } }, [credential]);
  const wrongController = new AbortController(), wrongFrames = [];
  const wrongTask = wrongTarget.subscribe("subscribeBindingUpdates", { bindingId: created.binding.bindingId }, "operator", (_event, value) => wrongFrames.push(value), wrongController.signal);
  await until(() => wrongFrames.some(frame => frame.details?.coreError?.code === "CORE_TARGET_CHANGED"));
  assert.equal(wrongTargetCalls, 0); assert.ok(wrongFrames.every(frame => !frame.history)); wrongController.abort(); await wrongTask;
  const executions = dispatched;
  for (const operation of ["sendBindingMessage", "steerBindingTurn", "answerBindingQuestions"]) {
    const input = { bindingId: created.binding.bindingId, requestId: operation, ...(operation === "sendBindingMessage" ? { message: "Operator must not impersonate the user" } : { turnId: "synthetic-turn", ...(operation === "steerBindingTurn" ? { message: "Instruction" } : { interactionId: "synthetic-question", answers: [{ questionId: "q", answers: ["a"] }] }) }) };
    await assert.rejects(api.execute(operation, input), error => error.detail.code === "CHANNEL_INPUT_REQUIRED");
  }
  assert.equal(dispatched, executions);
  const turnId = "synthetic-turn", nativeTurnId = "synthetic-native-turn";
  plane.store.put("turn", turnId, { turnId, sessionId, codexTurnId: nativeTurnId, requestId: "synthetic-input", mode: "default", state: "running", createdAt: timestamp, observedAt: timestamp, error: null });
  const emit = (type, payload = {}) => {
    const session = plane.store.get("session", sessionId), turn = plane.store.get("turn", turnId);
    const cursor = session.latestCursor + 1;
    const event = { eventId: `${sessionId}:${cursor}`, sessionId, turnId, cursor, timestamp, type, payload: { ...payload, session: { ...session, latestCursor: cursor }, turn } };
    events.push(event); management.event(hostId, event);
  };
  const message = { id: "synthetic-answer", turnId: nativeTurnId, role: "assistant", phase: "final_answer", createdAt: timestamp, turnStatus: "inProgress", itemComplete: false, text: "Hello" };
  live = [{ ...message }]; emit("assistant_delta", { itemId: message.id, text: "Hello" });
  await until(() => teamStream.frames.some(frame => frame.data.history?.liveMessages.some(item => item.text === "Hello")));
  live = [{ ...message, text: "Hello world" }]; emit("assistant_delta", { itemId: message.id, text: " world" });
  await until(() => coreStream.frames.some(frame => frame.data.history?.liveMessages.some(item => item.text === "Hello world")) && teamStream.frames.some(frame => frame.data.history?.liveMessages.some(item => item.text === "Hello world")));
  items = [{ ...message, text: "Hello world", itemComplete: true, turnStatus: "completed", ordinal: 1, updatedOrdinal: 1 }]; live = [];
  plane.store.put("turn", turnId, { ...plane.store.get("turn", turnId), state: "completed" });
  emit("assistant_message", { itemId: message.id, text: "Hello world", phase: "final_answer", stage: "completed" });
  await until(() => teamStream.frames.some(frame => frame.data.history?.messages.some(item => item.itemComplete && item.text === "Hello world")));
  contexts = [{ contextId: "synthetic-context", sessionId, segmentId: "synthetic-segment", source: "operator", text: "Passive human history", sequence: 1, createdAt: timestamp, afterTurnId: nativeTurnId }];
  emit("context_appended");
  await until(() => teamStream.frames.some(frame => frame.data.history?.contextRecords?.some(item => item.contextId === "synthetic-context")));
  await wait(250); const idleReads = historyReads; await wait(250); assert.equal(historyReads, idleReads, "idle session subscriptions do not poll native history");
  const last = teamStream.frames.filter(frame => frame.data.history).at(-1).data.history;
  coreStream.abort(); teamStream.abort(); await Promise.all([coreStream.done, teamStream.done]);
  items.push(...Array.from({ length: 55 }, (_, index) => ({ ...message, id: `saved-${index}`, text: `Saved ${index}`, itemComplete: true, turnStatus: "completed", ordinal: index + 2, updatedOrdinal: index + 2 })));
  const resumed = await subscribe(teamConfig.publicOrigin, `/api/subscribeBindingUpdates?${new URLSearchParams({ bindingId: created.binding.bindingId, resumeSessionId: sessionId, cursor: String(last.nextCursor), updateCursor: last.updateCursor, contextCursor: String(last.contextCursor) })}`, { Authorization: `Bearer ${teamToken}` });
  await until(() => new Set(resumed.frames.flatMap(frame => frame.data.history?.messages.map(item => item.id) ?? [])).size === 55);
  assert.equal(dispatched, executions, "subscriptions and reconnects never submit execution");
  await api.execute("beginChannelTakeover", { conversationId, requestId: "takeover" });
  const takeoverStream = await subscribe(teamConfig.publicOrigin, `/api/subscribeChannelConversationUpdates?conversationId=${conversationId}`, { Authorization: `Bearer ${teamToken}` });
  await until(() => takeoverStream.frames.some(frame => frame.data.conversation?.conversation.mode === "human"));
  let releaseRead;
  blockedRead = new Promise(resolve => { releaseRead = resolve; });
  const inFlight = await subscribe(coreConfig.publicOrigin, `/api/subscribeSessionUpdates?sessionId=${sessionId}`, { Authorization: `Bearer ${coreToken}` });
  await until(() => blockedRead === null);
  plane.store.put("interaction", "synthetic-sensitive", { interactionId: "synthetic-sensitive", sessionId, turnId, itemId: "synthetic-item", kind: "questions", authority: "operator", sensitive: true, blocking: true, status: "pending", createdAt: timestamp, observedAt: timestamp, requestId: null, decision: null, content: { contentId: null, kind: "output", label: "Restricted content", byteLength: null, availability: "unavailable", completeness: "unknown", authority: "operator" } });
  releaseRead();
  const firstRestricted = await until(() => inFlight.frames.find(frame => frame.event === "snapshot"));
  assert.equal(firstRestricted.data.details.contextAuthority, "operator");
  assert.ok(firstRestricted.data.history.messages.every(item => item.text === ""), "in-flight snapshots recheck authority before publishing");
  inFlight.abort(); await inFlight.done;
  await until(() => resumed.frames.some(frame => frame.data.details?.core?.contextAuthority === "operator"));
  live = [{ ...message, id: "private-answer", text: "Synthetic private answer" }]; emit("assistant_delta", { itemId: "private-answer", text: "Synthetic private answer" });
  const restricted = await until(() => resumed.frames.findLast(frame => frame.data.history?.liveMessages.some(item => item.id === "private-answer")));
  assert.equal(restricted.data.history.liveMessages.find(item => item.id === "private-answer").text, "");
  const login = await fetch(coreConfig.publicOrigin + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: coreConfig.operatorPassword }) });
  const operator = await subscribe(coreConfig.publicOrigin, `/api/subscribeSessionUpdates?sessionId=${sessionId}`, { Cookie: login.headers.get("set-cookie").split(";")[0] });
  await until(() => operator.frames.some(frame => frame.data.history?.liveMessages.some(item => item.text === "Synthetic private answer")));
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await Promise.all([resumed.done, takeoverStream.done]);
  await until(() => plane.store.changes.listeners.size === 1);
  operator.abort(); await operator.done;
  await until(() => plane.store.changes.listeners.size === 0);
});
