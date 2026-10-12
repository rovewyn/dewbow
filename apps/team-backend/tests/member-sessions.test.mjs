import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TeamError } from "@dewbow/team-protocol";
import { TeamApi } from "../dist/api.js";
import { TeamStore } from "../dist/store.js";

class SyntheticCore {
  url = "http://synthetic-core.invalid/";
  calls = [];
  operations = new Map();
  sessions = new Map();
  loseNextCreate = false;
  status = "delivered";
  async call(operation, input) {
    this.calls.push({ operation, input: structuredClone(input) });
    if (operation === "getSession") return structuredClone(this.sessions.get(input.sessionId));
    if (operation === "readSessionHistory") return { messages:[],activities:[],liveMessages:[],events:[],nextCursor:input.cursor ?? 0,beforeCursor:null,afterCursor:null,updateCursor:null,hasMoreUpdates:false,hasMore:false,historyError:null };
    const key = `${operation}:${input.requestId}`;
    let result = this.operations.get(key);
    if (!result) {
      const sessionId = input.sessionId ?? `session-${this.sessions.size + 1}`;
      result = { commandId: key, operation, sessionId, turnId: operation === "sendMessage" ? `turn-${input.requestId}` : null, requestId: input.requestId, status: this.status, createdAt: new Date().toISOString(), error: null };
      this.operations.set(key, result);
      if (operation === "createSession") this.sessions.set(sessionId, {
        session: { sessionId, hostId: input.hostId, workDir: input.workDir, connectionState: "connected", runtimeState: "idle", activeTurnId: null,
          sessionConfig: { agentRef: input.agentRef, overrides: input.sessionOptions, resolved: { developerInstructions: `Host baseline.\n\n${input.sessionOptions.instructionsAppend ?? ""}` } } },
        operations: [], turns: [], interactions: [],
      });
      this.sessions.get(sessionId).operations.push(result);
    }
    if (operation === "createSession" && this.loseNextCreate) {
      this.loseNextCreate = false;
      throw new TeamError({ code: "DELIVERY_UNCERTAIN", message: "Synthetic response was lost.", retryable: true });
    }
    return structuredClone(result);
  }
}

test("uncertain creation freezes configuration across definition edits, deletion, archiving and Team restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dewbow-team-session-"));
  const path = join(dir, "team.sqlite");
  let store = new TeamStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const core = new SyntheticCore();
  let api = new TeamApi(store, core);
  const { definition } = api.execute("createAgentDefinition", { name: "Editor", sessionOptions: { instructionsAppend: "Review the original draft." }, requestId: "definition" });
  const { team } = api.execute("createTeam", { name: "Writing", requestId: "team" });
  const { member } = api.execute("addTeamMember", { teamId: team.teamId, name: "Editor", definitionId: definition.definitionId, requestId: "member" });
  core.loseNextCreate = true;
  const input = { memberId: member.memberId, hostId: "host-1", workDir: "/synthetic/article", requestId: "create" };
  const first = await api.execute("createMemberSession", input);
  assert.equal(first.binding.sessionId, null);
  assert.equal(first.error.code, "DELIVERY_UNCERTAIN");
  const view = await api.execute("getSessionBinding", { bindingId: first.binding.bindingId });
  assert.deepEqual(view.requestedOptions, { instructionsAppend: "Review the original draft." });
  assert.equal(core.calls.length, 1, "reads must not retry creation or resume");
  api.execute("updateAgentDefinition", { definitionId: definition.definitionId, expectedRevision: "1", sessionOptions: { instructionsAppend: "Changed instructions." }, requestId: "edit" });
  api.execute("updateTeamMember", { memberId: member.memberId, definitionId: null, requestId: "reset" });
  api.execute("deleteAgentDefinition", { definitionId: definition.definitionId, expectedRevision: "2", requestId: "delete" });
  api.execute("archiveTeam", { teamId: team.teamId, requestId: "archive" });
  store.close();
  store = new TeamStore(path);
  api = new TeamApi(store, core);
  const retried = await api.execute("retrySessionBindingCreation", { bindingId: first.binding.bindingId });
  assert.equal(retried.binding.bindingId, first.binding.bindingId);
  assert.equal(retried.binding.sessionId, "session-1");
  assert.deepEqual(core.calls[0].input, core.calls[1].input);
  assert.equal(core.sessions.size, 1);
  const beforeRead = core.calls.filter(call => call.operation === "connectSession").length;
  const details = await api.execute("getSessionBinding", { bindingId: retried.binding.bindingId });
  assert.equal(details.core.session.sessionConfig.resolved.developerInstructions, "Host baseline.\n\nReview the original draft.");
  assert.equal(core.calls.filter(call => call.operation === "connectSession").length, beforeRead);
  await api.execute("connectSessionBinding", { bindingId: retried.binding.bindingId, requestId: "connect" });
  const resume = core.calls.at(-1);
  assert.equal(resume.operation, "connectSession");
  assert.deepEqual(Object.keys(resume.input).sort(), ["requestId", "sessionId"]);
  await assert.rejects(async () => api.execute("createMemberSession", { ...input, requestId: "another" }), error => error.detail.code === "TEAM_ARCHIVED");
  await assert.rejects(async () => api.execute("createMemberSession", { ...input, workDir: "/different" }), error => error.detail.code === "REQUEST_CONFLICT");
});

test("default creation avoids definition queries; send retries keep message bodies out of durable records", async t => {
  const store = new TeamStore(":memory:");
  t.after(() => store.close());
  const core = new SyntheticCore();
  let api = new TeamApi(store, core);
  const { team } = api.execute("createTeam", { name: "Writing", requestId: "team" });
  const { member } = api.execute("addTeamMember", { teamId: team.teamId, name: "Writer", requestId: "member" });
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { if (/SELECT.+agent_definitions/i.test(sql)) throw new Error("Unexpected default lookup."); return prepare(sql); };
  const { binding } = await api.execute("createMemberSession", { memberId: member.memberId, hostId: "host-1", workDir: "/synthetic/workspace", requestId: "create" });
  assert.deepEqual(core.calls[0].input.sessionOptions, {});
  assert.deepEqual(core.calls[0].input.agentRef, { id: "default", revision: "1" });
  const message = "PRIVATE_SYNTHETIC_MESSAGE_DO_NOT_PERSIST";
  core.status = "accepted";
  const send = { bindingId: binding.bindingId, message, requestId: "send" };
  const [first, duplicate] = await Promise.all([api.execute("sendBindingMessage", send), api.execute("sendBindingMessage", send)]);
  assert.equal(first.operation.turnId, duplicate.operation.turnId);
  assert.equal(core.calls.filter(call => call.operation === "sendMessage").length, 1);
  api = new TeamApi(store, core);
  const retry = await api.execute("sendBindingMessage", send);
  assert.equal(retry.operation.turnId, first.operation.turnId);
  assert.deepEqual(core.calls.filter(call => call.operation === "sendMessage").map(call => call.input.requestId), [first.operation.requestId, first.operation.requestId]);
  assert.ok(!JSON.stringify(prepare("SELECT * FROM operation_requests").all()).includes(message));
  const steering={bindingId:binding.bindingId,turnId:first.operation.turnId,message:"Synthetic appended instruction",requestId:"steering"};
  const steered=await api.execute("steerBindingTurn",steering);
  await api.execute("steerBindingTurn",steering);
  assert.deepEqual(core.calls.filter(call=>call.operation === "steerTurn").map(call=>call.input.requestId),[steered.operation.requestId,steered.operation.requestId]);
  const question={bindingId:binding.bindingId,turnId:first.operation.turnId,interactionId:"synthetic-question",requestId:"answers",answers:[{questionId:"constructor",answers:["Synthetic structured answer"]}]};
  const answered=await api.execute("answerBindingQuestions",question);await api.execute("answerBindingQuestions",question);
  assert.deepEqual(core.calls.filter(call=>call.operation === "answerQuestions").map(call=>call.input.requestId),[answered.operation.requestId,answered.operation.requestId]);
  assert.ok(!JSON.stringify(prepare("SELECT * FROM operation_requests").all()).includes("Synthetic structured answer"));
  assert.ok(!JSON.stringify(prepare("SELECT * FROM operation_requests").all()).includes(steering.message));
  await api.execute("interruptBindingTurn", { bindingId: binding.bindingId, turnId: first.operation.turnId, requestId: "interrupt" });
  const recorded = await api.execute("getSessionBinding", { bindingId: binding.bindingId });
  assert.equal(recorded.requests.find(request => request.operation === "interruptBindingTurn").turnId, first.operation.turnId);
  await assert.rejects(async () => api.execute("sendBindingMessage", { ...send, message: "Changed" }), error => error.detail.code === "REQUEST_CONFLICT");
  const replacement = { ...core, url: "http://different-core.invalid/", call: core.call.bind(core) };
  const moved = new TeamApi(store, replacement);
  const details = await moved.execute("getSessionBinding", { bindingId: binding.bindingId });
  assert.equal(details.coreError.code, "CORE_TARGET_CHANGED");
  await assert.rejects(async () => moved.execute("connectSessionBinding", { bindingId: binding.bindingId, requestId: "moved" }), error => error.detail.code === "CORE_TARGET_CHANGED");
  assert.throws(() => api.execute("createMemberSession", { memberId: member.memberId, hostId: "host-1", workDir: "/synthetic/workspace", requestId: "invalid", sessionOptions: {} }), /Unknown field/);
});
