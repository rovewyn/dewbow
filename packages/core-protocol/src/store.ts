import { DatabaseSync } from "node:sqlite";
import { ensurePrivateFile } from "./files.js";
import { fail } from "./index.js";
import type { Event } from "./index.js";

/** Small shared SQLite journal. Callers own record semantics and transactions. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly eventHistory = true) {
    ensurePrivateFile(path);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    const version = 1;
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get();
    const owner = existing ? this.get<{ daemonPid: number | null; runtimePid: number | null }>("meta", "owner") : undefined;
    const validPid = (pid: unknown) => pid === null || (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);
    if (owner !== undefined && (!owner || !validPid(owner.daemonPid) || !validPid(owner.runtimePid))) {
      this.db.close();
      fail("RECOVERY_REQUIRED", "Unsupported process ownership record. Verify and stop owned processes locally, then start with fresh Dewbow state.");
    }
    if (this.db.prepare("PRAGMA user_version").get()!.user_version !== version) {
      if (owner && [owner.daemonPid, owner.runtimePid].some(pid => {
        if (pid === null || !Number.isSafeInteger(pid) || pid < 1) return false;
        try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      })) {
        this.db.close();
        fail("RECOVERY_REQUIRED", "Stop the recorded daemon and runtime before recreating obsolete Dewbow tables.");
      }
      // Early development: recreate Dewbow tables instead of migrating old records.
      this.db.exec("BEGIN; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS records; COMMIT");
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id))");
    if (eventHistory) this.db.exec("CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, cursor INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,cursor))");
    else this.db.exec("DROP TABLE IF EXISTS events");
    this.db.exec(`PRAGMA user_version=${version}`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  list<T>(kind: string): T[] {
    return this.db.prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid").all(kind).map(row => JSON.parse(String(row.value)) as T);
  }
  put(kind: string, id: string, value: unknown): void {
    let encoded = JSON.stringify(value);
    if (kind === "operation" || kind === "command") {
      const record = JSON.parse(encoded);
      delete (kind === "command" ? record.command.input : record.input).message;
      encoded = JSON.stringify(record);
    }
    this.db.prepare("INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value").run(kind, id, encoded);
  }
  remove(kind: string, id: string): void { this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id); }
  append(event: Event): boolean {
    if (!this.eventHistory) throw new Error("Event history belongs to the host daemon.");
    const { text: _text, ...payload } = event.payload;
    if (event.type === "progress") { delete payload.plan; delete payload.explanation; }
    const saved = { ...event, payload };
    return Number(this.db.prepare("INSERT OR IGNORE INTO events VALUES (?,?,?)").run(event.sessionId, event.cursor, JSON.stringify(saved)).changes) === 1;
  }
  history(sessionId: string, cursor = 0, limit = 100): Event[] {
    if (!this.eventHistory) throw new Error("Event history belongs to the host daemon.");
    return this.db.prepare("SELECT value FROM events WHERE session_id=? AND cursor>? ORDER BY cursor LIMIT ?").all(sessionId, cursor, limit).map(row => JSON.parse(String(row.value)) as Event);
  }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
