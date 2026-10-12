import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readSessionHistory, readSessionItems, readSessionItem, SessionHistoryError } from "../dist/index.js";

const session = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const empty = "00000000-0000-4000-8000-000000000003";
const databases = new Map();

async function home(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dewbow-history-test-")));
  t.after(async () => { const db = databases.get(path); if (db?.isOpen) db.close(); databases.delete(path); await rm(path, { recursive: true, force: true }); });
  return path;
}
function database(path) {
  const db = new DatabaseSync(join(path, "thread_history_1.sqlite"));
  databases.set(path, db);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY);
    CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
      created_at_ms INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,PRIMARY KEY(thread_id,turn_id,item_id));
    CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id,rollout_ordinal)`);
  db.prepare("INSERT INTO thread_turns VALUES(?,?,?)").run(session, "turn-a", "completed");
  db.prepare("INSERT INTO thread_history_projection_state VALUES(?)").run(empty);
  return db;
}
function insert(db, id, ordinal, item) {
  db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    id,"turn-a",item.id,ordinal,1700000000000+ordinal,JSON.stringify(item),item.type,ordinal,1700000000000+ordinal,1700000000000+ordinal);
}
async function digest(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

test("history reads one session from WAL without writes and pages saved chat content in both directions", async t => {
  const path = await home(t), db = database(path);
  t.after(() => { if (db.isOpen) db.close(); });
  insert(db, session, 30, { type: "agentMessage", id: "final", text: "Done.\n", phase: "final_answer", private: "PRIVATE_METADATA_MARKER" });
  const content = [{ type: "text", text: "  Hello\n", text_elements: [] },
    { type: "localImage", path: "/path/to/synthetic-image.png" }, { type: "text", text: "World" }];
  insert(db, session, 10, { type: "userMessage", id: "request", content });
  insert(db, session, 20, { type: "commandExecution", id: "command", aggregatedOutput: "PRIVATE_TOOL_MARKER" });
  insert(db, session, 21, { type: "agentMessage", id: "progress", text: "Working.", phase: "commentary" });
  insert(db, other, 1, { type: "userMessage", id: "other", content: [{ type: "text", text: "PRIVATE_OTHER_SESSION_MARKER" }] });
  const files = [join(path, "thread_history_1.sqlite"), join(path, "thread_history_1.sqlite-wal")];
  const before = await Promise.all(files.map(digest));
  const options = { codexHome: path, limit: 2 };
  const first = await readSessionHistory(session, options);
  assert.deepEqual(first.messages.map(row => row.id), ["request", "progress"]);
  assert.equal(first.messages[0].text, "  Hello\n\nWorld");
  assert.deepEqual(first.messages[0].content, content);
  assert.equal(first.messages[0].createdAtMs, 1700000000010);
  assert.equal(first.messages[0].turnStatus, "completed");
  assert.equal(first.messages[1].phase, "commentary");
  assert.ok(first.nextCursor);
  const last = await readSessionHistory(session, { ...options, cursor: first.nextCursor });
  assert.equal(last.messages[0].role, "assistant");
  assert.equal(last.messages[0].phase, "final_answer");
  assert.equal(last.messages[0].text, "Done.\n");
  assert.equal(last.nextCursor, null);
  let cursor, reversed = [];
  do {
    const page = await readSessionHistory(session, { codexHome: path, limit: 1, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
    reversed.push(...page.messages.map(row => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(reversed, ["final", "progress", "request"]);
  assert.equal(JSON.stringify([first, last]).includes("PRIVATE_"), false);
  assert.deepEqual(await Promise.all(files.map(digest)), before);
  await assert.rejects(readSessionHistory(other, { ...options, cursor: first.nextCursor }), TypeError);
  await assert.rejects(readSessionHistory(session, { ...options, cursor: first.nextCursor, sortDirection: "desc" }), TypeError);
  await assert.rejects(readSessionHistory(session, { ...options, codexHome: await home(t), cursor: first.nextCursor }), TypeError);
});

test("history distinguishes empty sessions from unavailable stores and rejects incomplete or oversized reads", async t => {
  const path = await home(t);
  const read = (id = session, options = {}) => readSessionHistory(id, { codexHome: path, ...options });
  const error = code => value => value instanceof SessionHistoryError && value.code === code;
  await assert.rejects(read(), error("UNAVAILABLE"));
  const db = database(path);
  t.after(() => { if (db.isOpen) db.close(); });
  assert.deepEqual((await read(empty)).messages, []);
  await assert.rejects(read(other), error("SESSION_NOT_FOUND"));
  insert(db, session, 1, { type: "userMessage", id: "valid", content: [{ type: "text", text: "Synthetic request" }] });
  await writeFile(join(path, "thread_history_2.sqlite"), "broken synthetic database");
  await assert.rejects(read(), error("READ_FAILED"));
  await rm(join(path, "thread_history_2.sqlite"));
  const unsupported = new DatabaseSync(join(path, "thread_history_2.sqlite"));
  unsupported.exec("CREATE TABLE different_schema(id TEXT)");
  unsupported.close();
  await assert.rejects(read(), error("UNSUPPORTED_SCHEMA"));
  await rm(join(path, "thread_history_2.sqlite"));
  await symlink(process.platform === "win32" ? path : join(path, "thread_history_1.sqlite"), join(path, "thread_history_2.sqlite"), process.platform === "win32" ? "junction" : "file");
  await assert.rejects(read(), error("UNAVAILABLE"));
  await rm(join(path, "thread_history_2.sqlite"));
  db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?,?)").run(session,"turn-a","invalid",2,1700000000002,"invalid JSON","agentMessage",2,1700000000002,null);
  await assert.rejects(read(), error("INVALID_HISTORY"));
  db.prepare("DELETE FROM thread_items WHERE item_id='invalid'").run();
  insert(db, session, 2, { type: "agentMessage", id: "large", text: "x".repeat(8 * 1024 * 1024), phase: "final_answer" });
  await assert.rejects(read(), error("LIMIT_EXCEEDED"));
  await assert.rejects(read(session, { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("recent native items page in both directions and update old IDs without losing tied update positions", async t => {
  const path = await home(t), db = database(path);
  for (let ordinal=1;ordinal<=70;ordinal++) insert(db,session,ordinal,{type:"agentMessage",id:`item-${String(ordinal).padStart(3,"0")}`,text:`Saved ${ordinal}`,phase:"commentary"});
  insert(db,session,71,{type:"reasoning",id:"private-reasoning",summary:["PRIVATE_REASONING_MARKER"]});
  const latest = await readSessionItems(session,{codexHome:path});
  assert.equal(latest.items.length,50); assert.equal(latest.items[0].ordinal,21); assert.equal(latest.afterCursor,null);
  assert.ok(latest.beforeCursor); assert.ok(latest.updateCursor);
  const older = await readSessionItems(session,{codexHome:path,beforeCursor:latest.beforeCursor,limit:10});
  assert.deepEqual(older.items.map(item=>item.ordinal),[11,12,13,14,15,16,17,18,19,20]);
  const newer = await readSessionItems(session,{codexHome:path,afterCursor:older.afterCursor,limit:2});
  assert.deepEqual(newer.items.map(item=>item.ordinal),[21,22]);
  await assert.rejects(readSessionItems(other,{codexHome:path,beforeCursor:latest.beforeCursor}),TypeError);
  await assert.rejects(readSessionItems(session,{codexHome:path,afterCursor:latest.beforeCursor}),TypeError);
  db.prepare("UPDATE thread_items SET item_json=?,updated_at_ordinal=100,completed_at_ms=? WHERE item_id='item-001'").run(JSON.stringify({type:"agentMessage",id:"item-001",text:"Short final",phase:"final_answer"}),1700000000100);
  db.prepare("UPDATE thread_items SET updated_at_ordinal=100 WHERE item_id='item-002'").run();
  const firstUpdate = await readSessionItems(session,{codexHome:path,updateCursor:latest.updateCursor,limit:1});
  assert.equal(firstUpdate.items[0].id,"item-001"); assert.equal(firstUpdate.items[0].ordinal,100); assert.equal(firstUpdate.hasMoreUpdates,true);
  const secondUpdate = await readSessionItems(session,{codexHome:path,updateCursor:firstUpdate.updateCursor,limit:1});
  assert.equal(secondUpdate.items[0].id,"item-002"); assert.equal(secondUpdate.hasMoreUpdates,false);
  assert.equal((await readSessionItems(session,{codexHome:path})).items.at(-1).item.text,"Short final");
  assert.equal((await readSessionItem(session,"item-001",{codexHome:path})).item.text,"Short final");
  db.prepare("UPDATE thread_items SET item_type='plan',item_json=?,updated_at_ordinal=110,completed_at_ms=? WHERE item_id='item-002'").run(JSON.stringify({type:"plan",id:"item-002",text:"Completed plan"}),1700000000110);
  const plan = await readSessionItems(session,{codexHome:path,limit:1});
  assert.equal(plan.items[0].item.type,"plan"); assert.equal(plan.items[0].ordinal,110);
  assert.equal((await readSessionItems(session,{codexHome:path,beforeCursor:plan.beforeCursor,limit:1})).items[0].ordinal,100);
  await assert.rejects(readSessionItem(other,"item-001",{codexHome:path}),error=>error.code === "SESSION_NOT_FOUND");
  assert.equal(JSON.stringify(latest).includes("PRIVATE_REASONING_MARKER"),false);
});
