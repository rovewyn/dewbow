import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TeamManagement } from "../dist/management.js";
import { TeamStore } from "../dist/store.js";

test("default resolves without querying definitions and member edits preserve omitted selection", t => {
  const store = new TeamStore(":memory:");
  t.after(() => store.close());
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    if (/SELECT.+agent_definitions/i.test(sql)) throw new Error("Default must not query definitions.");
    return prepare(sql);
  };
  const service = new TeamManagement(store);
  for (const definitionId of [undefined, null, "", "default"]) {
    const input = definitionId === undefined ? {} : { definitionId };
    assert.deepEqual(service.execute("getAgentDefinition", input).definition.sessionOptions, {});
  }
  const { team } = service.execute("createTeam", { name: "Writing", requestId: "team" });
  for (const [index, definitionId] of [undefined, null, "", "default"].entries()) {
    const { member } = service.execute("addTeamMember", { teamId: team.teamId, name: "Writer", requestId: `member-${index}`, ...(definitionId === undefined ? {} : { definitionId }) });
    assert.equal(member.definitionId, null);
  }
  assert.equal(prepare("SELECT COUNT(*) AS count FROM agent_definitions").get().count, 0);
  assert.throws(() => service.execute("createAgentDefinition", { name: "Invalid", sessionOptions: { mcpServers: {} }, requestId: "invalid" }), /Unknown field/);
  assert.throws(() => service.execute("updateAgentDefinition", { definitionId: "default", expectedRevision: "1", requestId: "default-edit" }), error => error.detail.code === "DEFAULT_READ_ONLY");
});

test("custom revisions, reference protection and request deduplication survive restart", t => {
  const dir = mkdtempSync(join(tmpdir(), "dewbow-team-test-"));
  const path = join(dir, "team.sqlite");
  let store = new TeamStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  // Windows file modes do not represent POSIX owner-only access.
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  let service = new TeamManagement(store);
  const input = { name: "Editor", sessionOptions: {}, requestId: "definition" };
  const { definition } = service.execute("createAgentDefinition", input);
  assert.equal(definition.source, "custom");
  const { team } = service.execute("createTeam", { name: "Writing", requestId: "team" });
  const { member } = service.execute("addTeamMember", { teamId: team.teamId, name: "Editor", definitionId: definition.definitionId, requestId: "member" });
  assert.equal(service.execute("updateTeamMember", { memberId: member.memberId, name: "Senior editor", requestId: "rename" }).member.definitionId, definition.definitionId);
  assert.throws(() => service.execute("deleteAgentDefinition", { definitionId: definition.definitionId, expectedRevision: "1", requestId: "delete" }), error => error.detail.code === "DEFINITION_IN_USE");
  assert.throws(() => service.execute("addTeamMember", { teamId: team.teamId, name: "Missing", definitionId: "missing", requestId: "missing" }), error => error.detail.code === "NOT_FOUND");
  const update = { definitionId: definition.definitionId, expectedRevision: "1", sessionOptions: { instructionsAppend: "Review drafts." }, requestId: "update" };
  assert.equal(service.execute("updateAgentDefinition", update).definition.revision, "2");
  assert.equal(service.execute("updateAgentDefinition", update).definition.revision, "2");
  assert.throws(() => service.execute("updateAgentDefinition", { ...update, requestId: "stale" }), error => error.detail.code === "REVISION_CONFLICT");
  store.close();
  store = new TeamStore(path);
  service = new TeamManagement(store);
  assert.equal(service.execute("createAgentDefinition", input).definition.definitionId, definition.definitionId);
  assert.throws(() => service.execute("createAgentDefinition", { ...input, name: "Changed" }), error => error.detail.code === "REQUEST_CONFLICT");
  assert.equal(service.execute("updateTeamMember", { memberId: member.memberId, definitionId: "", requestId: "reset" }).member.definitionId, null);
  service.execute("deleteAgentDefinition", { definitionId: definition.definitionId, expectedRevision: "2", requestId: "deleted" });
  assert.throws(() => store.getDefinition(definition.definitionId), error => error.detail.code === "NOT_FOUND");
  service.execute("archiveTeam", { teamId: team.teamId, requestId: "archive" });
  assert.deepEqual(service.execute("listTeams", {}).teams, []);
  assert.throws(() => service.execute("addTeamMember", { teamId: team.teamId, name: "Writer", requestId: "archived-member" }), error => error.detail.code === "TEAM_ARCHIVED");
});
