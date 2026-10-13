import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPrivateFile, ensurePrivateDirectory } from "@dewbow/core-protocol/files";
import { controllerPath, readController, alive } from "../local-live-state.mjs";
import { initializeLocal, readLocalEnvironment, environment } from "../local-config.mjs";

const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/local-codex.mjs", import.meta.url));
async function command(operation, directory, args = []) {
  const result = await execute(process.execPath, ["scripts/local-live.mjs", operation, "--state-dir", directory, ...args], { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 1048576 });
  return JSON.parse(result.stdout);
}
async function port() {
  const server = createProbe(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const value = server.address().port; await new Promise(accept => server.close(accept)); return value;
}
async function canListen(value) {
  const server = createProbe();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(value, "127.0.0.1", accept); });
  await new Promise(accept => server.close(accept));
}
function ownedDirectory() { return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "dewbow-live-"))); }
function removeOwned(directory) {
  assert.equal(dirname(directory), realpathSync(tmpdir())); rmSync(directory, { recursive: true, force: true });
}
async function api(origin, token, operation, input = {}) {
  const response = await fetch(`${origin}/api/${operation}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.error, undefined); return result.result;
}

test("live lifecycle authenticates its owner, preserves state and stops only the selected instance", { timeout: 180000 }, async t => {
  const directory = ownedDirectory(), instances = [];
  t.after(async () => {
    let stopped = true;
    for (const instance of instances) { try { await command("down", instance.directory); } catch { stopped = false; } }
    assert.equal(stopped && instances.every(instance => !readController(instance.directory)), true, "Retain fixture state when owned shutdown is unconfirmed.");
    removeOwned(directory);
  });
  for (const name of ["first", "second"]) {
    const state = join(directory, name), home = join(directory, `${name}-codex`); mkdirSync(home);
    const corePort = await port(); let teamPort = await port(); while (teamPort === corePort) teamPort = await port();
    const instance = { directory: state, home, corePort, teamPort }; instances.push(instance);
    if (name === "first") {
      initializeLocal({ directory: state, corePort, teamPort });
      instance.initialCredentials = readFileSync(join(state, "credentials.json"), "utf8");
    }
    instance.ready = await command("up", state, ["--core-port", String(corePort), "--team-port", String(teamPort), "--codex-executable", fixture, "--codex-home", home]);
    assert.equal(instance.ready.status, "ready"); assert.equal(instance.ready.services.daemon, "connected");
    assert.equal(alive(instance.ready.pid), true); assert.equal(alive(instance.ready.runtimePid), true);
    assert.equal(readLocalEnvironment(state, "host-daemon.env").CODEX_HOME.replaceAll("\\", "/"), home.replaceAll("\\", "/"));
    if (instance.initialCredentials) assert.equal(readFileSync(join(state, "credentials.json"), "utf8"), instance.initialCredentials);
  }
  const [first, second] = instances, record = readController(first.directory);
  assert.equal((await fetch(`${record.controlOrigin}/stop`, { method: "POST", signal: AbortSignal.timeout(3000) })).status, 403);
  const duplicate = await command("up", first.directory);
  assert.equal(duplicate.instanceId, first.ready.instanceId); assert.equal(duplicate.runtimePid, first.ready.runtimePid);
  const credentialsPath = join(first.directory, "credentials.json"), credentialsText = readFileSync(credentialsPath, "utf8"), credentials = JSON.parse(credentialsText);
  const saved = await api(first.ready.teamUrl, credentials.teamOperator, "createAgentDefinition", { name: "Synthetic live agent", description: "Lifecycle persistence check", sessionOptions: { instructionsAppend: "Use the synthetic fixture." }, requestId: randomUUID() });
  const created = await api(first.ready.coreUrl, credentials.agent, "createSession", { hostId: "local-host", workDir: join(first.directory, "workdir"), requestId: randomUUID() });
  assert.ok(["accepted", "delivered"].includes(created.status));
  let connected = false;
  for (let i = 0; i < 30; i++) {
    const detail = await api(first.ready.coreUrl, credentials.agent, "getSession", { sessionId: created.sessionId });
    if (detail.session.connectionState === "connected") { connected = true; break; }
    await delay(100);
  }
  assert.equal(connected, true);
  const parallel = await Promise.all([
    command("down", first.directory),
    ...Array.from({ length: 3 }, () => command("status", first.directory).catch(error => JSON.parse(error.stdout))),
  ]);
  const stopped = parallel[0];
  assert.ok(parallel.slice(1).every(value => ["ready", "stopping", "stopped", "unavailable"].includes(value.status)));
  assert.equal(existsSync(controllerPath(first.directory)), false);
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.runtimeExited, true); assert.equal(stopped.portsReleased, true);
  assert.equal(alive(first.ready.pid), false); assert.equal(alive(first.ready.runtimePid), false);
  await canListen(first.corePort); await canListen(first.teamPort);
  assert.equal((await command("status", second.directory)).status, "ready");
  assert.equal((await command("down", first.directory)).status, "stopped");
  const restarted = await command("up", first.directory); first.ready = restarted;
  assert.notEqual(restarted.instanceId, record.instanceId); assert.equal(readFileSync(credentialsPath, "utf8"), credentialsText);
  const definitions = await api(restarted.teamUrl, credentials.teamOperator, "listAgentDefinitions");
  assert.ok(definitions.definitions.some(item => item.definitionId === saved.definition.definitionId));
  const sessions = await api(restarted.coreUrl, credentials.agent, "listSessions");
  assert.ok(sessions.sessions.some(item => item.sessionId === created.sessionId));
});

test("failed startup rolls back owned services and stale controller identities never stop unrelated listeners", { timeout: 120000 }, async t => {
  const directory = ownedDirectory(), occupied = createServer(), unrelated = createServer();
  const seen = [];
  unrelated.on("request", (request, response) => { seen.push(request.method); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ instanceId: randomUUID(), status: "ready" })); });
  occupied.listen(0, "127.0.0.1"); unrelated.listen(0, "127.0.0.1"); await Promise.all([once(occupied, "listening"), once(unrelated, "listening")]);
  const state = join(directory, "failure"), home = join(directory, "synthetic-codex"), ownedStates = [state]; mkdirSync(home);
  t.after(async () => {
    for (const ownedState of ownedStates) if (readController(ownedState)) await command("down", ownedState);
    assert.ok(ownedStates.every(ownedState => !readController(ownedState)), "Retain fixture state until its owned controllers stop.");
    await Promise.all([new Promise(accept => occupied.close(accept)), new Promise(accept => unrelated.close(accept))]); removeOwned(directory);
  });
  const corePort = occupied.address().port, teamPort = await port();
  await assert.rejects(command("up", state, ["--core-port", String(corePort), "--team-port", String(teamPort), "--codex-executable", fixture, "--codex-home", home]));
  assert.equal(occupied.listening, true); assert.equal(existsSync(controllerPath(state)), false); await canListen(teamPort);
  const failedNative = join(directory, "native-failure"), failCore = await port(); let failTeam = await port(); while (failTeam === failCore) failTeam = await port();
  ownedStates.push(failedNative);
  writeFileSync(join(home, "fail-start"), "synthetic failure");
  await assert.rejects(command("up", failedNative, ["--core-port", String(failCore), "--team-port", String(failTeam), "--codex-executable", fixture, "--codex-home", home]));
  assert.equal(existsSync(controllerPath(failedNative)), false); await canListen(failCore); await canListen(failTeam);
  unlinkSync(join(home, "fail-start"));
  const badTarget = join(directory, "bad-target"); ownedStates.push(badTarget);
  initializeLocal({ directory: badTarget, corePort: failCore, teamPort: failTeam, codexExecutable: fixture, codexHome: home });
  const badEnvironment = readLocalEnvironment(badTarget, "team.env"); badEnvironment.DEWBOW_CORE_URL += "/wrong-prefix/";
  writeFileSync(join(badTarget, "team.env"), environment(badEnvironment));
  await assert.rejects(command("up", badTarget));
  assert.equal(existsSync(join(badTarget, "daemon.sqlite")), false); assert.equal(existsSync(controllerPath(badTarget)), false);
  await canListen(failCore); await canListen(failTeam);
  const stale = join(directory, "stale"); ensurePrivateDirectory(stale);
  createPrivateFile(controllerPath(stale), JSON.stringify({ contractVersion: "v1", instanceId: randomUUID(), pid: process.pid, token: randomBytes(32).toString("base64url"), controlOrigin: `http://127.0.0.1:${unrelated.address().port}` }));
  await assert.rejects(command("down", stale), error => JSON.parse(error.stdout).status === "unavailable");
  assert.deepEqual(seen, ["GET"]); assert.equal(unrelated.listening, true); assert.equal(alive(process.pid), true);
});
