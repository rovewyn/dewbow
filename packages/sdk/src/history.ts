import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalHome, isMissing, object, uuid } from "./internal.js";
import type { ReadSessionHistoryOptions, SessionHistoryErrorCode, SessionHistoryPage,
  SessionMessage, SessionMessageContent } from "./types.js";

const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export class SessionHistoryError extends Error {
  constructor(public readonly code: SessionHistoryErrorCode, message: string) {
    super(message);
    this.name = "SessionHistoryError";
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Session history read was aborted.", "AbortError");
}

interface Cursor { version: 1; home: string; sessionId: string; direction: "asc" | "desc"; ordinal: number; }

function decodeCursor(value: string | undefined, expected: Omit<Cursor, "ordinal">): number | null {
  if (value === undefined) return null;
  try {
    if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.version !== expected.version || cursor.home !== expected.home
      || cursor.sessionId !== expected.sessionId || cursor.direction !== expected.direction
      || !Number.isSafeInteger(cursor.ordinal) || (cursor.ordinal as number) < 0) throw new Error();
    return cursor.ordinal as number;
  } catch { throw new TypeError("Invalid history cursor for this home, session, or sort direction."); }
}

function readMessage(row: Record<string, unknown>): SessionMessage {
  const invalid = () => new SessionHistoryError("INVALID_HISTORY", "A saved chat message is invalid.");
  if (typeof row.item_id !== "string" || !row.item_id || typeof row.turn_id !== "string" || !row.turn_id
    || !Number.isSafeInteger(row.rollout_ordinal) || (row.rollout_ordinal as number) < 0
    || !Number.isSafeInteger(row.created_at_ms) || (row.created_at_ms as number) < 0
    || (row.turn_status !== null && typeof row.turn_status !== "string")) throw invalid();
  let item: Record<string, unknown>;
  try { item = object(JSON.parse(row.item_json as string)); } catch { throw invalid(); }
  if (item.type !== row.item_type || item.id !== row.item_id) throw invalid();
  const user = row.item_type === "userMessage";
  let content: SessionMessageContent[];
  if (user) {
    if (!Array.isArray(item.content)) throw invalid();
    content = item.content.map(value => {
      const part = object(value);
      if (typeof part.type !== "string" || !part.type
        || (part.type === "text" && typeof part.text !== "string")
        || (part.text !== undefined && typeof part.text !== "string")) throw invalid();
      return part as SessionMessageContent;
    });
  } else {
    if (typeof item.text !== "string" || (item.phase != null && typeof item.phase !== "string")) throw invalid();
    content = [{ type: "text", text: item.text }];
  }
  return { id: row.item_id, turnId: row.turn_id, role: user ? "user" : "assistant",
    text: content.filter(part => part.type === "text").map(part => part.text).join("\n"), content,
    phase: user ? null : (item.phase as string | null | undefined) ?? null,
    createdAtMs: row.created_at_ms as number, turnStatus: row.turn_status as string | null };
}

/** Reads saved chat messages only. Does not resume sessions or start a Codex process. */
export async function readSessionHistory(sessionId: string, options: ReadSessionHistoryOptions = {}): Promise<SessionHistoryPage> {
  const id = uuid(sessionId);
  if (!id) throw new TypeError("Session ID must be a UUID.");
  const limit = options.limit ?? 100, direction = options.sortDirection ?? "asc";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("History limit must be from 1 to 1,000.");
  if (direction !== "asc" && direction !== "desc") throw new TypeError("Invalid history sort direction.");
  checkAbort(options.signal);
  const home = await canonicalHome(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const cursorContext: Omit<Cursor, "ordinal"> = { version: 1,
    home: createHash("sha256").update(home).digest("hex"), sessionId: id, direction };
  const ordinal = decodeCursor(options.cursor, cursorContext);
  let database: DatabaseSync | undefined;
  try {
    checkAbort(options.signal);
    const candidates = (await readdir(home)).flatMap(name => {
      const match = /^thread_history_(\d+)\.sqlite$/.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    }).sort((a, b) => b.version - a.version);
    const selected = candidates[0];
    if (!selected) throw new SessionHistoryError("UNAVAILABLE", "No Codex history database was found.");
    const path = join(home, selected.name), info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid?.()) {
      throw new SessionHistoryError("UNAVAILABLE", "The history database must be a regular file owned by the current user.");
    }
    checkAbort(options.signal);
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const required: Record<string, string[]> = {
      thread_items: ["thread_id", "turn_id", "item_id", "rollout_ordinal", "created_at_ms", "item_json", "item_type"],
      thread_turns: ["thread_id", "turn_id", "status"], thread_history_projection_state: ["thread_id"],
    };
    for (const [table, fields] of Object.entries(required)) {
      const columns = new Set(database.prepare("SELECT name FROM pragma_table_info(?)").all(table).map(row => row.name));
      if (fields.some(field => !columns.has(field))) {
        throw new SessionHistoryError("UNSUPPORTED_SCHEMA", "The Codex history database schema is unsupported.");
      }
    }
    const exists = database.prepare(`SELECT 1 FROM thread_history_projection_state WHERE thread_id=?
      UNION ALL SELECT 1 FROM thread_turns WHERE thread_id=?
      UNION ALL SELECT 1 FROM thread_items WHERE thread_id=? LIMIT 1`).get(id, id, id);
    if (!exists) throw new SessionHistoryError("SESSION_NOT_FOUND", "The session is not present in this history database.");
    const comparison = direction === "asc" ? ">" : "<";
    const statement = database.prepare(`SELECT i.item_id, i.turn_id, i.rollout_ordinal, i.created_at_ms, i.item_type,
      length(CAST(i.item_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(i.item_json AS BLOB)) <= ? THEN i.item_json ELSE NULL END AS item_json,
      t.status AS turn_status FROM thread_items i
      LEFT JOIN thread_turns t ON t.thread_id=i.thread_id AND t.turn_id=i.turn_id
      WHERE i.thread_id=? AND i.item_type IN ('userMessage','agentMessage')
      ${ordinal === null ? "" : `AND i.rollout_ordinal ${comparison} ?`}
      ORDER BY i.rollout_ordinal ${direction} LIMIT ?`);
    const args = [MAX_PAGE_BYTES, id, ...(ordinal === null ? [] : [ordinal]), limit + 1];
    const messages: SessionMessage[] = [];
    let bytes = 0, lastOrdinal = ordinal, more = false;
    for (const row of statement.iterate(...args)) {
      checkAbort(options.signal);
      if (messages.length === limit) { more = true; break; }
      if (!Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0) {
        throw new SessionHistoryError("INVALID_HISTORY", "A saved chat message is invalid.");
      }
      if ((row.bytes as number) > MAX_PAGE_BYTES) {
        throw new SessionHistoryError("LIMIT_EXCEEDED", "A saved chat message exceeds the 8 MiB size limit.");
      }
      bytes += row.bytes as number;
      if (bytes > MAX_PAGE_BYTES) throw new SessionHistoryError("LIMIT_EXCEEDED", "History page exceeds 8 MiB. Request fewer messages.");
      messages.push(readMessage(row));
      lastOrdinal = row.rollout_ordinal as number;
    }
    checkAbort(options.signal);
    return { sessionId: id, codexHome: home, source: "database", observedAt: new Date().toISOString(), messages,
      nextCursor: more ? Buffer.from(JSON.stringify({ ...cursorContext, ordinal: lastOrdinal })).toString("base64url") : null };
  } catch (error) {
    checkAbort(options.signal);
    if (error instanceof SessionHistoryError) throw error;
    if (isMissing(error)) throw new SessionHistoryError("UNAVAILABLE", "No Codex history database was found.");
    throw new SessionHistoryError("READ_FAILED", "The Codex history database could not be read.");
  } finally { database?.close(); }
}
