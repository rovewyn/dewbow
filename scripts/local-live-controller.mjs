import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { once } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createPrivateFile } from "@dewbow/core-protocol/files";
import { ControlPlane, readControlPlaneConfig } from "../apps/core-control-plane/dist/index.js";
import { HostDaemon, readHostDaemonConfig } from "../apps/core-host-daemon/dist/index.js";
import { readConfig } from "../apps/team-backend/dist/config.js";
import { createTeamServer } from "../apps/team-backend/dist/server.js";
import { TeamStore } from "../apps/team-backend/dist/store.js";
import { TeamApi } from "../apps/team-backend/dist/api.js";
import { CoreClient } from "../apps/team-backend/dist/core-client.js";
import { readLocalEnvironment } from "./local-config.mjs";
import { alive, controllerPath, releaseController, writePrivateJson } from "./local-live-state.mjs";

const directory = resolve(process.argv[2]);
const instanceId = randomUUID(), token = randomBytes(32).toString("base64url");
const record = { contractVersion: "v1", instanceId, token, pid: process.pid, controlOrigin: null };
let owned = false, handedOff = false, phase = "starting", failure = null, stopping = false, stopPromise, startPromise;
let control, plane, daemon, team, teamStore, coreConfig, teamConfig, daemonConfig, runtimePid = null;
let coreStarted = false, teamStarted = false;
const cancellation = new AbortController();
const send = value => { if (process.connected) process.send(value, () => {}); };
const guard = () => { if (stopping) throw new Error("Startup was cancelled."); };

function nativePid() {
  try {
    const database = new DatabaseSync(daemonConfig.statePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM records WHERE kind=? AND id=?").get("meta", "owner");
      const owner = row ? JSON.parse(row.value) : null;
      return owner?.daemonPid === process.pid && Number.isSafeInteger(owner.runtimePid) && owner.runtimePid > 0 ? owner.runtimePid : null;
    } finally { database.close(); }
  } catch { return null; }
}

async function api(origin, credential, operation, input = {}) {
  const response = await fetch(`${origin}/api/${operation}`, { method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: JSON.stringify(input),
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(3000)]),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error("Service readiness could not be confirmed.");
  return body.result;
}

async function status() {
  const value = { instanceId, pid: process.pid, status: phase, ...(failure ? { message: failure } : {}),
    coreUrl: coreConfig?.publicOrigin, teamUrl: teamConfig?.publicOrigin, hostId: daemonConfig?.hostId, workDir: resolve(directory, "workdir"), runtimePid };
  if (phase !== "ready") return value;
  const checks = await Promise.allSettled([
    api(coreConfig.publicOrigin, coreConfig.managementToken, "listHosts"),
    api(teamConfig.publicOrigin, teamConfig.operatorToken, "listHosts"),
  ]);
  const coreReady = checks[0].status === "fulfilled";
  const connected = coreReady && checks[0].value.hosts.some(host => host.hostId === daemonConfig.hostId && host.status === "connected");
  const teamReady = checks[1].status === "fulfilled" && checks[1].value.hosts.some(host => host.hostId === daemonConfig.hostId && host.status === "connected");
  return { ...value, status: coreReady && connected && teamReady ? "ready" : "degraded", services: { core: coreReady ? "ready" : "unavailable", team: teamReady ? "ready" : "unavailable", daemon: connected ? "connected" : "unavailable" } };
}

async function released(port) {
  const listener = createProbe();
  try {
    await new Promise((accept, reject) => { listener.once("error", reject); listener.listen(port, "127.0.0.1", accept); });
    await new Promise(accept => listener.close(accept));
    return true;
  } catch { return false; }
}

async function stop() {
  if (stopPromise) return stopPromise;
  stopping = true; phase = "stopping"; cancellation.abort();
  stopPromise = (async () => {
    runtimePid ??= nativePid();
    // Stop through the owned runtime object, never by killing a journaled PID.
    let nativeFailure;
    try { await daemon?.stop(); } catch { nativeFailure = true; }
    await startPromise?.catch(() => {});
    const closed = await Promise.allSettled([
      plane?.stop(),
      team && new Promise((accept, reject) => { team.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : accept()); team.closeAllConnections(); }),
    ]);
    teamStore?.close(); teamStore = undefined;
    const ports = [coreStarted ? coreConfig.port : null, teamStarted ? teamConfig.port : null].filter(port => port !== null);
    const portsReleased = (await Promise.all(ports.map(released))).every(Boolean);
    if (nativeFailure || closed.some(value => value.status === "rejected") || runtimePid && alive(runtimePid) || !portsReleased) {
      phase = "shutdownFailed"; failure = "Owned resources did not confirm shutdown. Inspect the private state and recovery runbook.";
      stopPromise = undefined;
      throw new Error(failure);
    }
    phase = "stopped";
    const result = { instanceId, status: phase, stoppedAt: new Date().toISOString(), runtimeExited: true, portsReleased: true };
    if (owned) { releaseController(directory, instanceId, result); owned = false; }
    return result;
  })();
  return stopPromise;
}

async function closeController() {
  if (control?.listening) await new Promise(accept => { control.close(accept); control.closeIdleConnections(); });
  if (process.connected) process.disconnect();
}

async function shutdown() {
  try { await stop(); await closeController(); }
  catch { send({ type: "failed", message: failure }); process.exitCode = 1; }
}

async function start() {
  guard();
  coreConfig = readControlPlaneConfig(readLocalEnvironment(directory, "control-plane.env"));
  teamConfig = readConfig(readLocalEnvironment(directory, "team.env"));
  daemonConfig = readHostDaemonConfig({ ...process.env, ...readLocalEnvironment(directory, "host-daemon.env") });
  const target = new URL(teamConfig.coreUrl);
  if (coreConfig.host !== "127.0.0.1" || teamConfig.host !== "127.0.0.1" || coreConfig.publicOrigin !== `http://127.0.0.1:${coreConfig.port}`
    || teamConfig.publicOrigin !== `http://127.0.0.1:${teamConfig.port}` || daemonConfig.controlPlaneUrl !== coreConfig.publicOrigin
    || target.origin !== coreConfig.publicOrigin || target.pathname !== "/" || target.search || target.hash || target.username || target.password
    || teamConfig.coreToken !== coreConfig.managementToken || coreConfig.port === teamConfig.port) {
    throw new Error("The live stack needs matching, distinct loopback Core and Team configuration.");
  }
  plane = new ControlPlane(coreConfig); await plane.start(); coreStarted = true; guard();
  teamStore = new TeamStore(teamConfig.databasePath);
  const apiService = new TeamApi(teamStore, new CoreClient(teamConfig.coreUrl, teamConfig.coreToken));
  team = createTeamServer(teamConfig, (operation, input, caller) => apiService.execute(operation, input, caller));
  team.listen(teamConfig.port, teamConfig.host); await once(team, "listening"); teamStarted = true; guard();
  daemon = new HostDaemon(daemonConfig);
  daemon.onRuntimeFailure = () => { failure = "The owned native runtime exited."; if (!stopping) void shutdown(); };
  await daemon.start(); runtimePid = nativePid(); guard();
  for (let i = 0; i < 30; i++) {
    guard();
    try {
      const hosts = await api(coreConfig.publicOrigin, coreConfig.managementToken, "listHosts");
      if (hosts.hosts.some(host => host.hostId === daemonConfig.hostId && host.status === "connected")) {
        phase = "ready"; const ready = await status();
        if (ready.status === "ready") return ready;
        phase = "starting";
      }
    } catch { guard(); }
    await delay(500, undefined, { signal: cancellation.signal });
  }
  throw new Error("The real host connection did not become ready.");
}

process.on("message", value => {
  if (value?.type === "handoff" && phase === "ready") handedOff = true;
  if (value?.type === "stop") void shutdown();
});
process.on("disconnect", () => { if (!handedOff) void shutdown(); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown(); });

try {
  if (!createPrivateFile(controllerPath(directory), JSON.stringify(record))) throw new Error("Another local controller owns this state directory.");
  owned = true;
  control = createServer(async (request, response) => {
    const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(request.headers.authorization ?? "");
    const valid = expected.length === supplied.length && timingSafeEqual(expected, supplied) && request.headers["x-dewbow-instance"] === instanceId
      && request.headers.host === new URL(record.controlOrigin).host && (!request.headers.origin || request.headers.origin === record.controlOrigin);
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", "application/json");
    if (!valid) { response.writeHead(403); response.end('{}'); return; }
    request.resume();
    try {
      if (request.method === "GET" && request.url === "/status") response.end(JSON.stringify(await status()));
      else if (request.method === "POST" && request.url === "/stop") {
        response.setHeader("Connection", "close");
        response.end(JSON.stringify(await stop()));
        void closeController();
      } else { response.writeHead(404); response.end('{}'); }
    } catch { response.writeHead(500); response.end(JSON.stringify({ instanceId, status: phase })); }
  });
  control.requestTimeout = 5000; control.headersTimeout = 5000;
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  record.controlOrigin = `http://127.0.0.1:${control.address().port}`; writePrivateJson(controllerPath(directory), record);
  startPromise = start();
  const ready = await startPromise; guard(); send({ type: "ready", status: ready });
} catch {
  failure ??= "Live startup failed. Check the private configuration, available ports, Codex login and live.log.";
  console.error(failure);
  if (owned) {
    try { await stop(); await closeController(); } catch { /* Retain ownership for explicit recovery. */ }
  }
  send({ type: "failed", message: failure });
  if (!owned && process.connected) process.disconnect();
  process.exitCode = 1;
}
