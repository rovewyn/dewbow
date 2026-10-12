import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { discoverSessions, getParentSession, getForkSourceSession } from "../dist/index.js";
import { readLineageHeader } from "../dist/lineage.js";

const parent = "00000000-0000-4000-8000-000000000001";
const child = "00000000-0000-4000-8000-000000000002";
const fork = "00000000-0000-4000-8000-000000000003";
async function home(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dewbow-test-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function database(path, ids = [parent]) {
  const db = new DatabaseSync(join(path, "state_5.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT, title TEXT, archived INTEGER, source TEXT, rollout_path TEXT, first_user_message TEXT)");
  const insert = db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)");
  for (const id of ids) insert.run(id, "Synthetic title", id === child ? 1 : 0, "cli", "PRIVATE_PATH_MARKER", "PRIVATE_PROMPT_MARKER");
  return db;
}
async function digest(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

test("database and lineage discovery preserve WAL data, privacy, and distinct relationships", async t => {
  const path = await home(t), other = await home(t);
  const db = database(path, [parent, child, fork]);
  const otherDb = database(other, [parent]);
  t.after(() => { db.close(); otherDb.close(); });
  db.exec("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT)");
  db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?)").run(parent, child);
  await mkdir(join(path, "sessions"));
  await writeFile(join(path, "sessions", "rollout-synthetic.jsonl"), JSON.stringify({ type: "session_meta", payload: {
    id: child, parent_thread_id: parent, forked_from_id: fork, private: "PRIVATE_HEADER_MARKER" } }) + "\nPRIVATE_LATER_RECORD\n");
  const files = [join(path, "state_5.sqlite"), join(path, "state_5.sqlite-wal")];
  const before = await Promise.all(files.map(digest));
  const snapshot = await discoverSessions({ codexHome: path, additionalHomes: [other], sources: ["database", "lineage"] });
  const session = snapshot.sessions.find(row => row.id === child);
  assert.equal(snapshot.sessions.length, 4);
  assert.equal(session.name, "Synthetic title");
  assert.equal(session.archived, true);
  assert.equal(session.runtimeStatus, "unknown");
  assert.equal(session.hasActiveWriter, null);
  assert.equal(getParentSession(snapshot, session).codexHome, path);
  assert.equal(getForkSourceSession(snapshot, session).id, fork);
  assert.equal(getParentSession({ ...snapshot, sessions: snapshot.sessions.filter(row => row.codexHome !== path) }, session), null);
  assert.equal(session.fieldSources.parentId, "database");
  assert.equal(session.fieldSources.forkedFromId, "lineage");
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_"), false);
  assert.deepEqual(await Promise.all(files.map(digest)), before);
});

test("missing, empty, corrupt newest, and bounded databases retain failure semantics", async t => {
  const path = await home(t);
  const inspect = (codexHome = path, limits) => discoverSessions({ codexHome, sources: ["database"], ...(limits ? { limits } : {}) });
  assert.equal((await inspect(join(path, "absent"))).summary.sessions, null);
  const db = database(path, []);
  db.close();
  assert.equal((await inspect()).summary.sessions, 0);
  await writeFile(join(path, "state_6.sqlite"), "broken synthetic database");
  const failed = await inspect();
  assert.equal(failed.sources.find(row => row.source === "database").state, "error");
  assert.equal(failed.summary.sessions, null);
  await rm(join(path, "state_6.sqlite"));
  const writer = new DatabaseSync(join(path, "state_5.sqlite"));
  writer.prepare("INSERT INTO threads(id) VALUES(?)").run(parent);
  writer.prepare("INSERT INTO threads(id) VALUES(?)").run(child);
  writer.close();
  const bounded = await inspect(path, { maxSessions: 1 });
  assert.equal(bounded.sessions.length, 0);
  assert.equal(bounded.summary.sessions, null);
});

test("lineage reads reject external symlinks, oversized headers, and self relationships", async t => {
  const path = await home(t), external = await home(t);
  const metadata = join(external, "rollout-external.jsonl");
  await writeFile(metadata, JSON.stringify({ type: "session_meta", payload: { id: child } }));
  const link = join(path, "rollout-link.jsonl");
  await symlink(metadata, link);
  await assert.rejects(readLineageHeader(link, path));
  const file = join(path, "rollout-local.jsonl");
  await writeFile(file, "x".repeat(65537));
  await assert.rejects(readLineageHeader(file, path));
  await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: child, parent_thread_id: child } }));
  await assert.rejects(readLineageHeader(file, path));
});

test("CLI inspection uses report mode, filters private data, and exposes execution failures", async t => {
  const path = await home(t), other = await home(t), executable = join(path, "synthetic-codex");
  await writeFile(executable, `#!${process.execPath}\nconst assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['migrate-rollouts', '--json']);
assert.ok(${JSON.stringify([path, other])}.includes(process.env.CODEX_HOME));
console.log(JSON.stringify({outcomes:[{thread_id:'${child}', status:'already_sqlite', private:'PRIVATE_CLI_MARKER'}]}));\n`, { mode: 0o700 });
  const options = { codexHome: path, sources: ["cli"], codexExecutable: executable };
  const snapshot = await discoverSessions(options);
  assert.equal(snapshot.sessions[0].id, child);
  assert.equal(snapshot.sessions[0].archived, null);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_CLI_MARKER"), false);
  const multiple = await discoverSessions({ ...options, additionalHomes: [other, path] });
  assert.equal(multiple.sessions.length, 2);
  assert.equal(multiple.sources.filter(row => row.source === "cli").length, 2);
  await writeFile(executable, `#!${process.execPath}\nconsole.error('PRIVATE_ERROR_MARKER'); process.exit(1);\n`);
  const failed = await discoverSessions(options);
  assert.equal(failed.summary.sessions, null);
  assert.equal(failed.sources.find(row => row.source === "cli").state, "error");
  assert.equal(JSON.stringify(failed).includes("PRIVATE_ERROR_MARKER"), false);
  await assert.rejects(discoverSessions({ ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("macOS writer query distinguishes held locks from multiple open-file PIDs and releases", {
  skip: process.platform !== "darwin"
}, async t => {
  const path = await home(t), db = database(path);
  db.close();
  const directory = join(path, "thread-writer-locks");
  await mkdir(directory);
  const lock = join(directory, parent + ".lock");
  await writeFile(lock, "");
  const open = async exclusive => {
    const worker = spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      const flock = require('koffi').load('/usr/lib/libSystem.B.dylib').func('int flock(int fd, int operation)');
      const fd = fs.openSync(process.argv[1], 'r');
      if (process.argv[2] === 'true' && flock(fd, 2) !== 0) process.exit(1);
      console.log('ready');
      process.stdin.once('data', () => { if(process.argv[2] === 'true') flock(fd, 8); fs.closeSync(fd); process.exit(0); });
    `, lock, String(exclusive)], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => worker.kill());
    await new Promise((resolve, reject) => {
      worker.stdout.once("data", resolve);
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error("Synthetic lock worker exited: " + code)));
    });
    return worker;
  };
  const owner = await open(true), observer = await open(false);
  const options = { codexHome: path, sources: ["database", "writers"] };
  const held = (await discoverSessions(options)).sessions[0];
  assert.equal(held.hasActiveWriter, true);
  assert.equal(held.writerPid, null);
  assert.deepEqual(held.writerOpenPids, [owner.pid, observer.pid].sort((a, b) => a - b));
  await Promise.all([owner, observer].map(worker => new Promise(resolve => { worker.once("exit", resolve); worker.stdin.end("release\n"); })));
  const released = (await discoverSessions(options)).sessions[0];
  assert.equal(released.hasActiveWriter, false);
  assert.deepEqual(released.writerOpenPids, []);
});
