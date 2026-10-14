import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { ControlPlane } from "../../apps/control-plane/dist/index.js";
import { readEventStream } from "@dewbow/protocol/stream";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await wait(10); }
  throw new Error("Synthetic subscription did not advance.");
}

test("Session SSE preserves updates, reconnect cursors and content authority", async t => {
  const directory = mkdtempSync(join(tmpdir(), "dewbow-updates-"));
  const hostId = "synthetic-host", managementToken = "synthetic-management-token";
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([{ hostId, name: "Synthetic host", token: "synthetic-host-token" }]));
  const controlPlaneConfig = { host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1:0", statePath: join(directory, "control.sqlite"), hostsFile: join(directory, "hosts.json"), managementToken, operatorPassword: "synthetic-operator-password", webRoot: directory };
  const plane = new ControlPlane(controlPlaneConfig), connections = [];
  let historyReads = 0, dispatched = 0, events = [], live = [], items = [], blockedRead;
  t.after(async () => {
    for (const connection of connections) connection.abort();
    await plane.stop(); rmSync(directory, { recursive: true, force: true });
  });
  await plane.start(); controlPlaneConfig.publicOrigin = `http://127.0.0.1:${plane.address().port}`;
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
      const result = { messages: structuredClone(selected), activities: [],
        observedAt: new Date().toISOString(), beforeCursor: null, afterCursor: null, updateCursor: `update-${selected.at(-1)?.updatedOrdinal ?? ordinal}`, hasMoreUpdates: Boolean(input.updateCursor && remaining.length > selected.length) };
      if (blockedRead) { const gate = blockedRead; blockedRead = null; await gate; }
      return result;
    }
    throw new Error("Unexpected synthetic native query.");
  };
  const created = await management.call("createSession", { hostId, workDir: "/synthetic/session", requestId: "create" }, { id: "agent", operator: false });
  const sessionId = created.sessionId, timestamp = new Date().toISOString();
  plane.store.put("session", sessionId, { ...plane.store.get("session", sessionId), codexThreadId: "synthetic-native-thread", connectionState: "connected", runtimeState: "idle" });
  management.result(hostId, { commandId: created.commandId, status: "delivered", error: null });
  async function subscribe(origin, path, credentialHeaders) {
    const controller = new AbortController(); connections.push(controller);
    const response = await fetch(origin + path, { headers: credentialHeaders, signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const frames = [];
    const done = (async () => { for await (const frame of readEventStream(response.body)) frames.push(frame); })().catch(error => { if (!controller.signal.aborted) throw error; });
    return { frames, done, abort: () => controller.abort() };
  }
  assert.equal((await fetch(`${controlPlaneConfig.publicOrigin}/api/subscribeSessionUpdates?sessionId=${sessionId}`, { headers: { Authorization: `Bearer invalid-token` } })).status, 401);
  assert.equal((await fetch(`${controlPlaneConfig.publicOrigin}/api/subscribeSessionUpdates?sessionId=${sessionId}&cursor=invalid`, { headers: { Authorization: `Bearer ${managementToken}` } })).status, 400);
  for (const target of [
    { object: management, method: "call", operation: "getSession", server: plane.server, changes: plane.store.changes, origin: controlPlaneConfig.publicOrigin, path: `/api/subscribeSessionUpdates?sessionId=${sessionId}`, token: managementToken },
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
  const stream = await subscribe(controlPlaneConfig.publicOrigin, `/api/subscribeSessionUpdates?sessionId=${sessionId}`, { Authorization: `Bearer ${managementToken}` });
  await until(() => stream.frames.some(frame => frame.event === "snapshot"));
  const executions = dispatched;
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
  await until(() => stream.frames.some(frame => frame.data.history?.liveMessages.some(item => item.text === "Hello")));
  live = [{ ...message, text: "Hello world" }]; emit("assistant_delta", { itemId: message.id, text: " world" });
  await until(() => stream.frames.some(frame => frame.data.history?.liveMessages.some(item => item.text === "Hello world")));
  items = [{ ...message, text: "Hello world", itemComplete: true, turnStatus: "completed", ordinal: 1, updatedOrdinal: 1 }]; live = [];
  plane.store.put("turn", turnId, { ...plane.store.get("turn", turnId), state: "completed" });
  emit("assistant_message", { itemId: message.id, text: "Hello world", phase: "final_answer", stage: "completed" });
  await until(() => stream.frames.some(frame => frame.data.history?.messages.some(item => item.itemComplete && item.text === "Hello world")));
  await wait(250); const idleReads = historyReads; await wait(250); assert.equal(historyReads, idleReads, "idle session subscriptions do not poll native history");
  const last = stream.frames.filter(frame => frame.data.history).at(-1).data.history;
  stream.abort(); await stream.done;
  items.push(...Array.from({ length: 55 }, (_, index) => ({ ...message, id: `saved-${index}`, text: `Saved ${index}`, itemComplete: true, turnStatus: "completed", ordinal: index + 2, updatedOrdinal: index + 2 })));
  const resumed = await subscribe(controlPlaneConfig.publicOrigin, `/api/subscribeSessionUpdates?${new URLSearchParams({ sessionId, cursor: String(last.nextCursor), updateCursor: last.updateCursor })}`, { Authorization: `Bearer ${managementToken}` });
  await until(() => new Set(resumed.frames.flatMap(frame => frame.data.history?.messages.map(item => item.id) ?? [])).size === 55);
  assert.equal(dispatched, executions, "subscriptions and reconnects never submit execution");
  let releaseRead;
  blockedRead = new Promise(resolve => { releaseRead = resolve; });
  const inFlight = await subscribe(controlPlaneConfig.publicOrigin, `/api/subscribeSessionUpdates?sessionId=${sessionId}`, { Authorization: `Bearer ${managementToken}` });
  await until(() => blockedRead === null);
  plane.store.put("interaction", "synthetic-sensitive", { interactionId: "synthetic-sensitive", sessionId, turnId, itemId: "synthetic-item", kind: "questions", authority: "operator", sensitive: true, blocking: true, status: "pending", createdAt: timestamp, observedAt: timestamp, requestId: null, decision: null, content: { contentId: null, kind: "output", label: "Restricted content", byteLength: null, availability: "unavailable", completeness: "unknown", authority: "operator" } });
  releaseRead();
  const firstRestricted = await until(() => inFlight.frames.find(frame => frame.event === "snapshot"));
  assert.equal(firstRestricted.data.details.contextAuthority, "operator");
  assert.ok(firstRestricted.data.history.messages.every(item => item.text === ""), "in-flight snapshots recheck authority before publishing");
  inFlight.abort(); await inFlight.done;
  await until(() => resumed.frames.some(frame => frame.data.details?.contextAuthority === "operator"));
  live = [{ ...message, id: "private-answer", text: "Synthetic private answer" }]; emit("assistant_delta", { itemId: "private-answer", text: "Synthetic private answer" });
  const restricted = await until(() => resumed.frames.findLast(frame => frame.data.history?.liveMessages.some(item => item.id === "private-answer")));
  assert.equal(restricted.data.history.liveMessages.find(item => item.id === "private-answer").text, "");
  const login = await fetch(controlPlaneConfig.publicOrigin + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: controlPlaneConfig.operatorPassword }) });
  const operator = await subscribe(controlPlaneConfig.publicOrigin, `/api/subscribeSessionUpdates?sessionId=${sessionId}`, { Cookie: login.headers.get("set-cookie").split(";")[0] });
  await until(() => operator.frames.some(frame => frame.data.history?.liveMessages.some(item => item.text === "Synthetic private answer")));
  resumed.abort(); await resumed.done;
  await until(() => plane.store.changes.listeners.size === 1);
  operator.abort(); await operator.done;
  await until(() => plane.store.changes.listeners.size === 0);
});
