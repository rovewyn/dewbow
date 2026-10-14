import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionTree, projectSessionTree } from "../src/components/session-tree/model.ts";

const hosts = ["studio", "build"].map(hostId => ({ hostId, name: hostId, status: "connected", lastSeenAt: null }));
const session = (id, { host = "studio", home = "/synthetic/codex", nativeId = id, parent = null, fork = null, name = id } = {}) => ({
  sessionId: id, hostId: host, name, workDir: "/synthetic/workspace", codexThreadId: nativeId,
  managed: id === "managed-root", runtimeState: "idle", connectionState: "disconnected", lastKnownState: "idle",
  native: { id: nativeId, codexHome: home, parentId: parent, forkedFromId: fork, archived: false },
});
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);

test("lineage resolves native IDs within host/home and retains forks, missing parents and cycles", () => {
  const sessions = [session("managed-root", { nativeId: "native-root" }),
    session("child", { parent: "native-root" }), session("grandchild", { parent: "child" }),
    session("other-home", { home: "/synthetic/other", nativeId: "native-root" }),
    session("other-host", { host: "build", nativeId: "native-root" }),
    session("isolated", { home: "/synthetic/missing", parent: "native-root" }),
    session("fork", { fork: "native-root" }), session("orphan", { parent: "absent" }),
    session("cycle-a", { parent: "cycle-b" }), session("cycle-b", { parent: "cycle-a" }),
    session("cycle-descendant", { parent: "cycle-a" })];
  const tree = buildSessionTree(hosts, sessions);
  const all = flatten(tree), root = all.find(node => node.sessionId === "managed-root");
  assert.deepEqual(root.children.map(node => node.sessionId), ["child"]);
  assert.equal(root.children[0].children[0].sessionId, "grandchild");
  assert.equal(all.filter(node => node.kind === "session").length, sessions.length);
  const top = tree[0].children;
  for (const id of ["fork", "isolated", "orphan", "cycle-a", "cycle-b"]) assert.ok(top.some(node => node.sessionId === id));
  assert.match(all.find(node => node.sessionId === "isolated").parentWarning, /unavailable/);
  assert.match(all.find(node => node.sessionId === "cycle-a").parentWarning, /cycle/);
  assert.equal(all.find(node => node.sessionId === "cycle-a").children[0].sessionId, "cycle-descendant");
});

test("search retains only matching sessions and their ancestors without losing selection or mutating the tree", () => {
  const tree = buildSessionTree(hosts, [session("root"), session("child", { parent: "root" }),
    session("leaf", { parent: "child", name: "Check database" }), session("sibling", { parent: "root" }), session("selected-elsewhere", { host: "build" })]);
  const model = projectSessionTree(tree, "  DATABASE  ", "selected-elsewhere");
  assert.equal(model.matchCount, 1);
  assert.deepEqual(flatten(model.nodes).map(node => node.id), ["host:studio", "session:root", "session:child", "session:leaf"]);
  assert.equal(model.selected.sessionId, "selected-elsewhere");
  assert.deepEqual(model.selectedPath, ["host:build"]);
  assert.equal(flatten(tree).length, 7);
  const parentMatch = projectSessionTree(tree, "root", "leaf");
  assert.deepEqual(flatten(parentMatch.nodes).map(node => node.id), ["host:studio", "session:root"]);
  assert.deepEqual(parentMatch.selectedPath, ["host:studio", "session:root", "session:child"]);
});

test("a connection failure has a scoped label without changing the runtime observation", () => {
  const item = { ...session("external"), runtimeState: "running", connectionState: "error", managed: true };
  const node = buildSessionTree(hosts, [item])[0].children[0];
  assert.equal(node.statusLabel, "Connection failed");
  assert.ok(node.metadata.includes("Runtime: Running"));
  assert.ok(!node.metadata.includes("Managed"));
  assert.equal(item.runtimeState, "running");
});
