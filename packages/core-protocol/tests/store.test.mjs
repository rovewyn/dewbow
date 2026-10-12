import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/store.js";

test("journal persists records, rolls back failed operations, and deduplicates ordered replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "dewbow-store-"));
  const path = join(directory, "journal.sqlite");
  let store = new Store(path);
  try {
    store.put("request", "caller:send:request-1", { turnId: "turn-1" });
    const event = cursor => ({ eventId: `session-1:${cursor}`, sessionId: "session-1", turnId: "turn-1", cursor, timestamp: "2026-01-01T00:00:00Z", type: "message", payload: { text: "synthetic" } });
    store.append(event(2)); store.append(event(1));
    assert.equal(store.history("session-1")[0].payload.text, undefined);
    store.put("operation", "pending", { input: { message: "Synthetic private input", requestId: "send-1" }, status: "accepted" });
    assert.equal(store.get("operation", "pending").input.message, undefined);
    assert.equal(store.append(event(1)), false);
    assert.throws(() => store.transaction(() => { store.put("request", "rolled-back", {}); store.append(event(3)); throw new Error("failure"); }));
    store.close(); store = new Store(path);
    assert.deepEqual(store.get("request", "caller:send:request-1"), { turnId: "turn-1" });
    assert.equal(store.get("request", "rolled-back"), undefined);
    assert.deepEqual(store.history("session-1").map(e => e.cursor), [1, 2]);
    assert.deepEqual(store.history("session-1", 1, 1).map(e => e.cursor), [2]);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(database.prepare("PRAGMA table_info(events)").all().map(column => column.name), ["session_id", "cursor", "value"]);
      const row = database.prepare("SELECT session_id,value FROM events WHERE cursor=1").get();
      const saved = JSON.parse(row.value);
      assert.equal(row.session_id, saved.sessionId);
      assert.equal(saved.turnId, "turn-1");
      assert.equal(saved.eventId, "session-1:1");
      assert.equal(saved.session_id, undefined);
    } finally { database.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unsupported ownership is preserved and obsolete tables require stopped recorded processes", () => {
  const directory = mkdtempSync(join(tmpdir(), "dewbow-reset-")), path = join(directory, "control.sqlite");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE records(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id)); CREATE TABLE events(session_id TEXT,cursor INTEGER,value TEXT)");
  old.prepare("INSERT INTO records VALUES(?,?,?)").run("meta", "owner", JSON.stringify({ daemon_pid: process.pid, runtime_pid: null }));
  old.prepare("INSERT INTO events VALUES(?,?,?)").run("obsolete", 1, "{}");
  try {
    for (const version of [1, 0]) {
      old.exec(`PRAGMA user_version=${version}`);
      assert.throws(() => new Store(path, false), e => e.detail.code === "RECOVERY_REQUIRED");
      assert.equal(JSON.parse(old.prepare("SELECT value FROM records WHERE kind='meta'").get().value).daemon_pid, process.pid);
      assert.equal(old.prepare("SELECT count(*) AS n FROM events").get().n, 1);
    }
    old.prepare("UPDATE records SET value=? WHERE kind='meta'").run(JSON.stringify({ daemonPid: process.pid, runtimePid: null }));
    assert.throws(() => new Store(path, false), e => e.detail.code === "RECOVERY_REQUIRED");
    assert.equal(old.prepare("SELECT count(*) AS n FROM events").get().n, 1);
    old.exec("DELETE FROM records WHERE kind='meta'"); old.close();
    const central = new Store(path, false);
    assert.throws(() => central.append({}), /belongs to the host/);
    assert.throws(() => central.history("obsolete"), /belongs to the host/);
    central.put("operation", "own-request", { input: { requestId: "request-1", message: "Volatile input" }, status: "accepted" }); central.close();
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='events'").get().n, 0); check.close();
    const reopened = new Store(path, false);
    assert.equal(reopened.get("operation", "own-request").input.message, undefined);
    assert.equal(reopened.get("operation", "own-request").status, "accepted"); reopened.close();
  } finally { if (old.isOpen) old.close(); rmSync(directory, { recursive: true, force: true }); }
});
