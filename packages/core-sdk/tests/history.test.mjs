import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readSessionHistory, SessionHistoryError } from "../dist/index.js";

const session = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const empty = "00000000-0000-4000-8000-000000000003";

async function home(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dewbow-history-test-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function database(path) {
  const db = new DatabaseSync(join(path, "thread_history_1.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY);
    CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
      created_at_ms INTEGER, item_json TEXT, item_type TEXT, PRIMARY KEY(thread_id,turn_id,item_id));
    CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id,rollout_ordinal)`);
  db.prepare("INSERT INTO thread_turns VALUES(?,?,?)").run(session, "turn-a", "completed");
  db.prepare("INSERT INTO thread_history_projection_state VALUES(?)").run(empty);
  return db;
}
function insert(db, id, ordinal, item) {
  db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)").run(
    id, "turn-a", item.id, ordinal, 1700000000000 + ordinal, JSON.stringify(item), item.type);
}
async function digest(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

test("history reads one session from WAL without writes and pages saved chat content in both directions", async t => {
  const path = await home(t), db = database(path);
  t.after(() => db.close());
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
  t.after(() => db.close());
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
  await symlink(join(path, "thread_history_1.sqlite"), join(path, "thread_history_2.sqlite"));
  await assert.rejects(read(), error("UNAVAILABLE"));
  await rm(join(path, "thread_history_2.sqlite"));
  db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)").run(session, "turn-a", "invalid", 2, 1700000000002, "invalid JSON", "agentMessage");
  await assert.rejects(read(), error("INVALID_HISTORY"));
  db.prepare("DELETE FROM thread_items WHERE item_id='invalid'").run();
  insert(db, session, 2, { type: "agentMessage", id: "large", text: "x".repeat(8 * 1024 * 1024), phase: "final_answer" });
  await assert.rejects(read(), error("LIMIT_EXCEEDED"));
  await assert.rejects(read(session, { signal: AbortSignal.abort() }), { name: "AbortError" });
});
