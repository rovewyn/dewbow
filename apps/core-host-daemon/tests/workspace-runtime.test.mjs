import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, copyFileSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { HostDaemon } from "../dist/index.js";

const until = async predicate => { const deadline = Date.now() + 8000; while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Synthetic workspace runtime timed out."); };

test("host transport prepares an isolated profile and refuses native recovery when its saved directory is missing", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dewbow-profile-runtime-")));
  const executable = join(dir, "codex.mjs"); copyFileSync(new URL("fixtures/codex.mjs", import.meta.url), executable);
  writeFileSync(join(dir, "synthetic-config.json"), JSON.stringify({ model: "synthetic-default", sandbox_workspace_write: { writable_roots: ["/synthetic/shared"] } }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const frames = []; let socket, reports = 0;
  server.on("connection", connection => { socket = connection; connection.on("message", raw => { const frame = JSON.parse(raw); frames.push(frame); if (frame.type === "hello") connection.send(JSON.stringify({ type: "sync", cursors: {} })); if (frame.type === "report") { reports++; connection.send(JSON.stringify({ type: "ready" })); } }); });
  const config = { hostId: "synthetic-host", token: "synthetic-token", codexHome: dir, codexExecutable: executable, statePath: join(dir, "daemon.sqlite"), controlPlaneUrl: `http://127.0.0.1:${server.address().port}`, workspaces: { root: join(dir, "sessions"), profiles: [{ profileId: "empty", name: "Empty", kind: "emptyDirectory" }] } };
  let daemon = new HostDaemon(config);
  try {
    await daemon.start(); await until(() => reports === 1);
    socket.send(JSON.stringify({ type: "query", query: { queryId: "profiles", operation: "listWorkspaceProfiles", authority: "agent", input: {} } }));
    const profiles = await until(() => frames.find(value => value.type === "query_result" && value.response.queryId === "profiles"));
    assert.deepEqual(profiles.response.result.profiles, [{ profileId: "empty", name: "Empty", kind: "emptyDirectory" }]);
    const command = { commandId: "create-profile", sessionId: "managed-profile", turnId: null, authority: "agent", operation: "createSession", input: { hostId: config.hostId, workspaceProfileId: "empty", requestId: "create-profile" } };
    socket.send(JSON.stringify({ type: "command", command }));
    const result = await until(() => frames.find(value => value.type === "result" && value.result.commandId === command.commandId));
    assert.equal(result.result.status, "delivered");
    const preparation = frames.filter(value => value.type === "event" && value.event.type === "workspace_updated");
    assert.equal(preparation[0].event.payload.session.workspace.status, "preparing"); assert.equal(preparation[0].event.payload.session.workDir, null);
    assert.equal(preparation[1].event.payload.session.workspace.status, "ready");
    const session = frames.find(value => value.type === "event" && value.event.type === "session_created").event.payload.session;
    assert.equal(session.workspace.status, "ready"); assert.equal(session.workDir, realpathSync(join(dir, "sessions", "managed-profile")));
    assert.deepEqual(session.sessionConfig.resolved.sandbox.writableRoots, []); assert.equal(session.sessionConfig.resolved.sandbox.excludeTmpdirEnvVar, true);
    await daemon.stop(); renameSync(session.workDir, join(dir, "retained-result"));
    const requests = () => readFileSync(join(dir, "synthetic-rpc.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const resumeCount = requests().filter(value => value.method === "thread/resume").length;
    daemon = new HostDaemon(config); await daemon.start(); await until(() => reports === 2);
    const report = frames.findLast(value => value.type === "report");
    assert.equal(report.report.sessions[0].connectionState, "error"); assert.equal(requests().filter(value => value.method === "thread/resume").length, resumeCount);
    assert.equal(requests().filter(value => value.method === "thread/start").length, 1);
  } finally { await daemon.stop(); for (const connection of server.clients) connection.terminate(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
