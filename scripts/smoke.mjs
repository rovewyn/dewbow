import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
if (!args.length || args.length % 2) throw new Error("Usage: npm run local:smoke -- <host-id> <absolute-work-dir> [<host-id> <absolute-work-dir> ...]");
const origin = process.env.DEWBOW_CONTROL_PLANE_URL ?? "http://127.0.0.1:3000";
const credential = process.env.DEWBOW_MANAGEMENT_TOKEN;
if (!credential) throw new Error("DEWBOW_MANAGEMENT_TOKEN is required.");
const trace = { startedAt: new Date().toISOString(), node: process.version, clientPlatform: process.platform, hosts: [], sessions: [], checks: [] };
let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const value = await response.json();
  if (value.error) throw new Error(value.error.message);
  return value.result;
}
async function call(name, input = {}) {
  const result = await rpc("tools/call", { name, arguments: input });
  if (result.isError) {
    const error = JSON.parse(result.content[0].text).error;
    throw Object.assign(new Error(error.message), error);
  }
  return result.structuredContent;
}
async function expectCode(action, code) {
  await assert.rejects(action, error => error.code === code);
  trace.checks.push(code);
}
async function observe(sessionId, predicate) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const detail = await call("getSession", { sessionId });
    if (predicate(detail)) return detail;
    if (["error", "unknown"].includes(detail.session.runtimeState) && detail.session.codexThreadId) throw new Error(`Session ${sessionId} is ${detail.session.runtimeState}; inspect it before retrying.`);
    if (detail.operations.some(operation => operation.status === "error")) throw new Error(`Execution failed for ${sessionId}.`);
    await delay(1000);
  }
  throw new Error(`Observation timed out for ${sessionId}; retain its IDs and inspect the session.`);
}
async function history(sessionId) {
  let cursor=0,beforeCursor=null,more=true;
  const events = [], messages = new Map();
  while (more) {
    const page = await call("readSessionHistory",{sessionId,cursor,limit:20,...(beforeCursor ? {beforeCursor} : {})});
    assert.equal(page.historyError, null);
    assert.ok(page.events.every(event => event.cursor > cursor));
    events.push(...page.events); cursor = page.nextCursor;
    for (const message of page.messages) messages.set(message.id, message);
    beforeCursor = page.beforeCursor;
    more = page.hasMore || beforeCursor !== null;
  }
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
  assert.ok(events.every((event, index) => index === 0 || event.cursor > events[index - 1].cursor));
  return { events, messages: [...messages.values()] };
}

mkdirSync("outputs", { recursive: true, mode: 0o700 });
const output = resolve("outputs", `smoke-${Date.now()}.json`);
try {
  const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dewbow-smoke", version: "1.0.0" } });
  assert.equal(initialized.protocolVersion, "2025-03-26");
  const notification = await fetch(`${origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notification.status, 202);
  assert.equal((await rpc("tools/list")).tools.length,12);
  const unauthorized = await fetch(`${origin}/api/listHosts`, { method: "POST", headers: { Authorization: "Bearer invalid-smoke-credential", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauthorized.status, 401);
  trace.checks.push("invalid_management_credential_rejected");
  const hosts = (await call("listHosts")).hosts;
  trace.hosts = hosts.map(host => ({ hostId: host.hostId, status: host.status }));
  for (let index = 0; index < args.length; index += 2) {
    const hostId = args[index], workDir = args[index + 1];
    assert.ok(hosts.some(host => host.hostId === hostId && host.status === "connected"), `Host ${hostId} must be connected.`);
    const request = { hostId, workDir, requestId: randomUUID() };
    const created = await call("createSession", request);
    assert.equal((await call("createSession", request)).sessionId, created.sessionId);
    await expectCode(() => call("createSession", { ...request, workDir: `${workDir}/different-input` }), "REQUEST_CONFLICT");
    await observe(created.sessionId, detail => Boolean(detail.session.codexThreadId) && detail.session.runtimeState === "idle");
    trace.sessions.push({ hostId, sessionId: created.sessionId, createRequestId: request.requestId, marker: `dewbow-smoke-${randomUUID()}`, turns: [] });
  }
  await Promise.all(trace.sessions.map(async session => {
    const request = { sessionId: session.sessionId, message: `Remember the token ${session.marker} for this conversation. Reply with exactly that token. Do not use tools.`, requestId: randomUUID() };
    const accepted = await call("sendMessage", request);
    assert.equal((await call("sendMessage", request)).turnId, accepted.turnId);
    await expectCode(() => call("sendMessage", { ...request, message: "Changed input" }), "REQUEST_CONFLICT");
    await expectCode(() => call("sendMessage", { ...request, requestId: randomUUID() }), "SESSION_BUSY");
    session.turns.push({ turnId: accepted.turnId, requestId: request.requestId });
  }));
  await Promise.all(trace.sessions.map(async session => {
    const completed = await observe(session.sessionId, detail => detail.turns.some(turn => turn.turnId === session.turns[0].turnId && turn.state === "completed"));
    session.codexThreadId = completed.session.codexThreadId;
    const request = { sessionId: session.sessionId, message: "What token did I ask you to remember? Reply with exactly that token. Do not use tools.", requestId: randomUUID() };
    const accepted = await call("sendMessage", request);
    session.turns.push({ turnId: accepted.turnId, requestId: request.requestId });
    const followed = await observe(session.sessionId, detail => detail.turns.some(turn => turn.turnId === accepted.turnId && turn.state === "completed"));
    assert.equal(followed.session.codexThreadId, session.codexThreadId);
    assert.equal(followed.turns.length, 2);
    const { events, messages } = await history(session.sessionId);
    for (const turn of session.turns) assert.equal(events.filter(event => event.turnId === turn.turnId && event.type === "turn_started").length, 1, "Each native turn must emit one start confirmation.");
    const nativeTurnId = followed.turns.find(t => t.turnId === accepted.turnId).codexTurnId;
    assert.ok(messages.some(message => message.turnId === nativeTurnId && message.role === "assistant" && message.text.includes(session.marker)), "Follow-up must recall the token in the same conversation.");
    session.events = events.map(event => ({ eventId: event.eventId, cursor: event.cursor, turnId: event.turnId, type: event.type }));
  }));
  assert.equal((await call("listSessions")).sessions.filter(session => trace.sessions.some(record => record.sessionId === session.sessionId)).length, trace.sessions.length);
  trace.checks.push("create_and_send_deduplication", "conversation_continuity", "ordered_history");
  if (trace.sessions.length > 1) trace.checks.push("independent_sessions");
  trace.result = "passed";
  console.log(`MCP smoke passed for ${trace.sessions.length} session(s). Trace: ${output}`);
} catch (error) {
  trace.result = "failed";
  trace.errorCode = error.code ?? "SMOKE_FAILED";
  throw error;
} finally {
  trace.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(trace, null, 2) + "\n", { mode: 0o600 });
}
