import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { ControlPlane } from "../../apps/core-control-plane/dist/index.js";
import { TeamApi } from "../../apps/team-backend/dist/api.js";
import { CoreClient } from "../../apps/team-backend/dist/core-client.js";
import { createTeamServer } from "../../apps/team-backend/dist/server.js";
import { TeamStore } from "../../apps/team-backend/dist/store.js";

async function until(read) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for synthetic Core state.");
}

test("independent Team and Core HTTP services preserve frozen requests and execution authority", async t => {
  const directory = mkdtempSync(join(tmpdir(), "dewbow-team-core-"));
  const hostsFile = join(directory, "hosts.json");
  const hostCredential = "synthetic-host-credential";
  const coreCredential = "synthetic-core-management-credential";
  const teamCredential = "synthetic-team-operator-credential";
  writeFileSync(hostsFile, JSON.stringify([{ hostId: "synthetic-host", name: "Synthetic host", token: hostCredential }]));
  const coreConfig = {
    host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1:0",
    statePath: join(directory, "core.sqlite"), hostsFile, webRoot: directory,
    managementToken: coreCredential, operatorPassword: "synthetic-core-operator-password",
  };
  const core = new ControlPlane(coreConfig);
  const store = new TeamStore(join(directory, "team.sqlite"));
  let server, socket;
  t.after(async () => {
    socket?.terminate();
    if (server?.listening) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
    await core.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await core.start();
  coreConfig.publicOrigin = `http://127.0.0.1:${core.address().port}`;
  const api = new TeamApi(store, new CoreClient(coreConfig.publicOrigin, coreCredential));
  const teamConfig = { publicOrigin: "http://127.0.0.1:0", operatorToken: teamCredential, webDir: directory };
  server = createTeamServer(teamConfig, (operation, input, caller) => api.execute(operation, input, caller));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  teamConfig.publicOrigin = `http://127.0.0.1:${server.address().port}`;
  const post = async (origin, credential, operation, input = {}) => {
    const response = await fetch(`${origin}/api/${operation}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
    });
    return response.json();
  };
  const teamCall = (operation, input) => post(teamConfig.publicOrigin, teamCredential, operation, input);
  const coreCall = (operation, input) => post(coreConfig.publicOrigin, coreCredential, operation, input);
  assert.equal((await post(teamConfig.publicOrigin, coreCredential, "listTeams")).error.code, "UNAUTHORIZED");
  assert.equal((await post(coreConfig.publicOrigin, teamCredential, "listHosts")).error.code, "UNAUTHORIZED");

  const commands = [];
  socket = new WebSocket(`${coreConfig.publicOrigin.replace("http", "ws")}/hosts/connect`, {
    headers: { Authorization: `Bearer ${hostCredential}` },
  });
  socket.on("message", raw => {
    const frame = JSON.parse(raw);
    if (frame.type === "sync") socket.send(JSON.stringify({ type: "report", report: { sessions: [], turns: [], approvals: [], operations: [] } }));
    if (frame.type === "command") commands.push(frame.command);
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", hostId: "synthetic-host" }));
  await until(async () => (await teamCall("listHosts")).result.hosts[0]?.status === "connected");

  const options = { model: "synthetic-model", reasoningEffort: "high", instructionsAppend: "Original synthetic instructions." };
  const { definition } = (await teamCall("createAgentDefinition", { name: "Synthetic writer", sessionOptions: options, requestId: "definition" })).result;
  const { team } = (await teamCall("createTeam", { name: "Synthetic team", requestId: "team" })).result;
  const { member } = (await teamCall("addTeamMember", { teamId: team.teamId, name: "Writer", definitionId: definition.definitionId, requestId: "member" })).result;
  const input = { memberId: member.memberId, hostId: "synthetic-host", workDir: "/synthetic/workspace", requestId: "create" };
  const first = (await teamCall("createMemberSession", input)).result;
  assert.equal(first.error, null);
  assert.equal(first.operation.status, "accepted");
  await until(() => commands.length === 1);
  assert.deepEqual(commands[0].input.sessionOptions, options);
  await teamCall("updateAgentDefinition", { definitionId: definition.definitionId, expectedRevision: "1", sessionOptions: { instructionsAppend: "Changed instructions." }, requestId: "edit" });
  const retry = (await teamCall("retryMemberSessionCreation", { bindingId: first.binding.bindingId })).result;
  assert.equal(retry.binding.sessionId, first.binding.sessionId);
  assert.equal(retry.operation.requestId, first.operation.requestId);
  assert.equal(commands.length, 1);
  const details = (await teamCall("getSessionBinding", { bindingId: first.binding.bindingId })).result;
  assert.deepEqual(details.requestedOptions, options);
  assert.deepEqual(details.core.session.sessionConfig.overrides, options);
  assert.equal(details.core.operations.length, 1);
  assert.equal(commands.length, 1, "reading a binding must not execute recovery");
  assert.ok(!JSON.stringify(details).includes(coreCredential));
  assert.equal((await teamCall("createMemberSession", { ...input, workDir: "/synthetic/changed" })).error.code, "REQUEST_CONFLICT");
  assert.equal((await coreCall("decideApproval", { sessionId: first.binding.sessionId, turnId: "synthetic-turn", approvalId: "synthetic-approval", decision: "allow" })).error.code, "FORBIDDEN");

  socket.terminate();
  await core.stop();
  const offline = (await teamCall("getSessionBinding", { bindingId: first.binding.bindingId })).result;
  assert.equal(offline.core, null);
  assert.equal(offline.coreError.code, "CORE_UNAVAILABLE");
  assert.deepEqual(offline.requestedOptions, options);
  assert.equal((await teamCall("createTeam", { name: "Offline team", requestId: "offline-team" })).result.team.name, "Offline team");
  assert.equal((await teamCall("listAgentDefinitions")).result.definitions.length, 2);
});
