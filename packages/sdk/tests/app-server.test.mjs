import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessions } from "../dist/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const archivedId = "00000000-0000-4000-8000-000000000002";

// A synthetic Unix WebSocket endpoint. No Codex process or model turn is started.
async function endpoint(t, respond) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dewbow-rpc-")));
  const path = join(home, "public.sock"), sockets = new Set(), calls = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0), upgraded = false;
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(buffer.toString("ascii"))[1];
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        buffer = buffer.subarray(end + 4); upgraded = true;
      }
      while (buffer.length >= 2) {
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + size);
        const request = JSON.parse(payload.toString("utf8")); calls.push(request);
        if (request.id === undefined) continue;
        const result = respond(request, home);
        if (result === undefined) continue;
        const body = Buffer.from(JSON.stringify({ id: request.id, ...result }));
        const header = Buffer.alloc(body.length < 126 ? 2 : 4);
        header[0] = 129; header[1] = body.length < 126 ? body.length : 126;
        if (header.length === 4) header.writeUInt16BE(body.length, 2);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return { home, path, calls, sockets };
}

test("public API snapshot paginates, lists archive states, and reads loaded metadata only", async t => {
  const fake = await endpoint(t, (request, home) => {
    if (request.method === "initialize") return { result: { codexHome: home } };
    if (request.method === "thread/loaded/list") return { result: { data: [id], nextCursor: null } };
    if (request.method === "thread/list") {
      if (request.params.archived) return { result: { data: [{ id: archivedId, title: "Archived fixture", source: "cli" }], nextCursor: null } };
      if (!request.params.cursor) return { result: { data: [], nextCursor: "synthetic-page-two" } };
      return { result: { data: [{ id, title: "Saved fixture", source: "cli" }], nextCursor: null } };
    }
    if (request.method === "thread/read") return { result: { thread: { id, title: "Loaded fixture", source: "cli",
      status: { type: "active", activeFlags: ["waitingOnApproval", "PRIVATE_FLAG"] },
      turns: ["PRIVATE_TURN"], preview: "PRIVATE_PREVIEW" } } };
    throw new Error("Unexpected discovery RPC: " + request.method);
  });
  const snapshot = await discoverSessions({ codexHome: fake.home, sockets: [fake.path], sources: ["app-server"] });
  assert.equal(snapshot.summary.sessions, 2);
  assert.equal(snapshot.summary.activeSessions, 1);
  assert.equal(snapshot.summary.archived, 1);
  const session = snapshot.sessions.find(row => row.id === id);
  assert.deepEqual(session.activeFlags, ["waitingOnApproval"]);
  assert.deepEqual(session.pids, []);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_"), false);
  assert.deepEqual(fake.calls.filter(row => row.method === "thread/read").map(row => row.params), [{ threadId: id, includeTurns: false }]);
  assert.equal(fake.calls.filter(row => row.method === "thread/list").every(row => row.params.useStateDbOnly === true), true);
  assert.deepEqual([...new Set(fake.calls.map(row => row.method))].sort(), ["initialize", "initialized", "thread/list", "thread/loaded/list", "thread/read"].sort());
});

test("failed and aborted API reads publish no partial inventory and close the connection", async t => {
  let fail = true;
  const fake = await endpoint(t, (request, home) => {
    if (request.method === "initialize") return { result: { codexHome: home } };
    if (request.method === "thread/loaded/list") return { result: { data: [], nextCursor: null } };
    if (request.method === "thread/list" && !request.params.archived) return { result: { data: [{ id, source: "cli" }], nextCursor: null } };
    if (fail) return { error: { message: "PRIVATE_SERVER_ERROR" } };
    return undefined;
  });
  const options = { codexHome: fake.home, sockets: [fake.path], sources: ["app-server"] };
  const failed = await discoverSessions(options);
  assert.equal(failed.summary.sessions, null);
  assert.equal(failed.sessions.length, 0);
  assert.equal(failed.runtimes[0].state, "error");
  assert.equal(JSON.stringify(failed).includes("PRIVATE_SERVER_ERROR"), false);
  fail = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));
  await assert.rejects(discoverSessions({ ...options, signal: controller.signal }), { name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fake.sockets.size, 0);
});
