import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalHome, object, uuid } from "./internal.js";
import { isOwnedFile } from "./file-trust.js";
import { SessionHistoryError } from "./history.js";

export interface ReadSessionItemsOptions {
  codexHome?: string; beforeCursor?: string; afterCursor?: string; updateCursor?: string; limit?: number; signal?: AbortSignal;
}
export interface SessionItemRecord {
  id: string; turnId: string; ordinal: number; createdAtMs: number; turnStatus: string | null;
  updatedOrdinal: number; completedAtMs: number | null;
  itemJson: string;
  item: Record<string, unknown>;
}
export interface SessionItemsPage {
  sessionId: string; codexHome: string; observedAt: string; items: SessionItemRecord[];
  beforeCursor: string | null; afterCursor: string | null;
  updateCursor: string | null; hasMoreUpdates: boolean;
}

/** Read native item order, including tool records, without resuming a conversation. */
export function readSessionItems(sessionId: string, options: ReadSessionItemsOptions = {}): Promise<SessionItemsPage> { return readItems(sessionId,options); }
export async function readSessionItem(sessionId: string, itemId: string, options: Pick<ReadSessionItemsOptions,"codexHome" | "signal"> = {}): Promise<SessionItemRecord> {
  if (!itemId || Buffer.byteLength(itemId,"utf8") > 384) throw new TypeError("Invalid native item identifier.");
  const page = await readItems(sessionId,{...options,itemId,limit:2});
  if (!page.items.length) throw new SessionHistoryError("SESSION_NOT_FOUND","Native activity is unavailable in this conversation.");
  if (page.items.length !== 1) throw new SessionHistoryError("INVALID_HISTORY","Native item identity is ambiguous.");
  return page.items[0]!;
}
async function readItems(sessionId: string, options: ReadSessionItemsOptions & { itemId?: string }): Promise<SessionItemsPage> {
  const id = uuid(sessionId), limit = options.limit ?? 50;
  if (!id) throw new TypeError("Session ID must be a UUID.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("History limit must be from 1 to 500.");
  if ([options.beforeCursor,options.afterCursor,options.updateCursor].filter(value=>value !== undefined).length > 1) throw new TypeError("Choose one history cursor.");
  const check = () => { if (options.signal?.aborted) throw new DOMException("Item history read was aborted.", "AbortError"); };
  check();
  const home = await canonicalHome(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const scope = createHash("sha256").update(JSON.stringify([process.platform === "win32" ? home.toLowerCase() : home,id])).digest("hex");
  const direction = options.updateCursor ? "updates" : options.afterCursor ? "after" : "before", cursor = options.updateCursor ?? options.afterCursor ?? options.beforeCursor;
  let anchor: number | null = null;
  let anchorId = "";
  if (cursor !== undefined) {
    try {
      if (!/^[a-zA-Z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
      const value = object(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (value.version !== 1 || value.scope !== scope || value.direction !== direction || !Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0 || typeof value.id !== "string" || Buffer.byteLength(value.id,"utf8") > 384) throw new Error();
      anchor = Number(value.ordinal); anchorId = value.id;
    } catch { throw new TypeError("Invalid item cursor for this conversation or direction."); }
  }
  const encode = (ordinal: number, id: string, direction: "before" | "after" | "updates") => Buffer.from(JSON.stringify({ version:1,scope,ordinal,id,direction })).toString("base64url");
  let db: DatabaseSync | undefined;
  try {
    const file = (await readdir(home)).flatMap(name => { const match = /^thread_history_(\d+)\.sqlite$/.exec(name); return match ? [{ name, version: Number(match[1]) }] : []; }).sort((a,b) => b.version-a.version)[0];
    if (!file || !isOwnedFile(join(home,file.name), await lstat(join(home,file.name)))) throw new SessionHistoryError("UNAVAILABLE", "Native item history is unavailable.");
    db = new DatabaseSync(join(home,file.name), { readOnly: true, allowExtension: false, timeout: 1000 });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const fields = { thread_items: ["thread_id","turn_id","item_id","rollout_ordinal","updated_at_ordinal","created_at_ms","completed_at_ms","item_json","item_type"], thread_turns: ["thread_id","turn_id","status"], thread_history_projection_state: ["thread_id"] };
    for (const [table,names] of Object.entries(fields)) {
      const columns = new Set(db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map(row=>row.name));
      if (names.some(name=>!columns.has(name))) throw new SessionHistoryError("UNSUPPORTED_SCHEMA", "Native item history schema is unsupported.");
    }
    if (!db.prepare("SELECT 1 FROM thread_history_projection_state WHERE thread_id=? UNION ALL SELECT 1 FROM thread_turns WHERE thread_id=? UNION ALL SELECT 1 FROM thread_items WHERE thread_id=? LIMIT 1").get(id,id,id)) throw new SessionHistoryError("SESSION_NOT_FOUND", "Conversation is absent from native item history.");
    const maximumBytes = 8 * 1024 * 1024;
    // Completion gives a final reply its authoritative position after intervening
    // activity, while ordinary progress and tools retain their original position.
    const order = "CASE WHEN i.item_type='agentMessage' AND i.completed_at_ms IS NOT NULL AND json_valid(i.item_json) THEN CASE WHEN json_extract(i.item_json,'$.phase')='final_answer' THEN i.updated_at_ordinal ELSE i.rollout_ordinal END ELSE i.rollout_ordinal END";
    const latest = db.prepare("SELECT updated_at_ordinal,item_id FROM thread_items WHERE thread_id=? AND item_type <> 'reasoning' ORDER BY updated_at_ordinal DESC,item_id DESC LIMIT 1").get(id);
    const pageOrder = direction === "updates" ? "i.updated_at_ordinal" : order, comparison = direction === "before" ? "<" : ">";
    const rows = db.prepare(`SELECT i.item_id,i.turn_id,${order} AS order_ordinal,i.updated_at_ordinal,i.completed_at_ms,i.created_at_ms,i.item_type,
      length(CAST(i.item_json AS BLOB)) AS bytes, CASE WHEN length(CAST(i.item_json AS BLOB)) <= ? THEN i.item_json ELSE NULL END AS item_json,
      t.status AS turn_status FROM thread_items i LEFT JOIN thread_turns t ON t.thread_id=i.thread_id AND t.turn_id=i.turn_id
      WHERE i.thread_id=? AND i.item_type <> 'reasoning' ${options.itemId ? "AND i.item_id=?" : ""} ${anchor === null ? "" : `AND (${pageOrder} ${comparison} ? OR (${pageOrder} = ? AND i.item_id ${comparison} ?))`}
      ORDER BY ${pageOrder} ${direction === "before" ? "DESC" : "ASC"},i.item_id ${direction === "before" ? "DESC" : "ASC"} LIMIT ?`).iterate(maximumBytes,id,...(options.itemId ? [options.itemId] : []),...(anchor === null ? [] : [anchor,anchor,anchorId]),limit);
    const items: SessionItemRecord[] = [];
    let bytes = 0;
    for (const row of rows) {
      check(); bytes += Number(row.bytes);
      if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) > maximumBytes || bytes > maximumBytes) throw new SessionHistoryError("LIMIT_EXCEEDED", "Native item page exceeds 8 MiB. Request fewer items.");
      let item: Record<string,unknown>;
      try { item = object(JSON.parse(String(row.item_json))); } catch { throw new SessionHistoryError("INVALID_HISTORY", "A native history item is invalid."); }
      if (typeof row.item_id !== "string" || !row.item_id || typeof row.turn_id !== "string" || !row.turn_id || item.id !== row.item_id || item.type !== row.item_type || !Number.isSafeInteger(row.order_ordinal) || Number(row.order_ordinal) < 0 || !Number.isSafeInteger(row.updated_at_ordinal) || Number(row.updated_at_ordinal) < 0 || !Number.isSafeInteger(row.created_at_ms) || Number(row.created_at_ms) < 0 || (row.completed_at_ms !== null && (!Number.isSafeInteger(row.completed_at_ms) || Number(row.completed_at_ms) < 0))) throw new SessionHistoryError("INVALID_HISTORY", "A native history item is invalid.");
      if (Buffer.byteLength(row.item_id,"utf8") > 384) throw new SessionHistoryError("INVALID_HISTORY","Native item identifier exceeds the cursor bound.");
      items.push({ id:row.item_id,turnId:row.turn_id,ordinal:Number(row.order_ordinal),updatedOrdinal:Number(row.updated_at_ordinal),completedAtMs:row.completed_at_ms === null ? null : Number(row.completed_at_ms),createdAtMs:Number(row.created_at_ms),turnStatus:typeof row.turn_status === "string" ? row.turn_status : null,item,itemJson:String(row.item_json) });
    }
    const updateTail = direction === "updates" && items.length ? [...items].sort((a,b)=>a.updatedOrdinal-b.updatedOrdinal || Buffer.compare(Buffer.from(a.id),Buffer.from(b.id))).at(-1)! : null;
    items.sort((a,b)=>a.ordinal-b.ordinal || Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
    const has = (expression: string, comparison: string, ordinal: number, itemId: string) => Boolean(db!.prepare(`SELECT 1 FROM thread_items i WHERE i.thread_id=? AND i.item_type <> 'reasoning' AND (${expression} ${comparison} ? OR (${expression}=? AND i.item_id ${comparison} ?)) LIMIT 1`).get(id,ordinal,ordinal,itemId));
    const tailOrdinal = direction === "updates" ? updateTail?.updatedOrdinal ?? anchor ?? 0 : Number(latest?.updated_at_ordinal ?? 0);
    const tailId = direction === "updates" ? updateTail?.id ?? anchorId : String(latest?.item_id ?? "");
    check();
    return { sessionId:id,codexHome:home,observedAt:new Date().toISOString(),items,
      beforeCursor:direction !== "updates" && items.length && has(order,"<",items[0]!.ordinal,items[0]!.id) ? encode(items[0]!.ordinal,items[0]!.id,"before") : null,
      afterCursor:direction !== "updates" && items.length && has(order,">",items.at(-1)!.ordinal,items.at(-1)!.id) ? encode(items.at(-1)!.ordinal,items.at(-1)!.id,"after") : null,
      updateCursor:latest || options.updateCursor ? encode(tailOrdinal,tailId,"updates") : null,
      hasMoreUpdates:direction === "updates" && has("i.updated_at_ordinal",">",tailOrdinal,tailId) };
  } catch (error) {
    check(); if (error instanceof SessionHistoryError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionHistoryError("UNAVAILABLE", "Native item history is unavailable.");
    throw new SessionHistoryError("READ_FAILED", "Native item history could not be read.");
  } finally { db?.close(); }
}
