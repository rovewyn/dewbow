import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateFile } from "@dewbow/core-protocol/files";
import { fail, type ContentPage, type ContentRef, type SessionActivity } from "@dewbow/core-protocol";

/** Output bodies are isolated from the service journal and never replayed to Core. */
export class SessionContent {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    ensurePrivateFile(path); this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS contents(content_id TEXT PRIMARY KEY,session_scope TEXT NOT NULL,body BLOB,byte_length INTEGER NOT NULL,completeness TEXT NOT NULL); CREATE TABLE IF NOT EXISTS content_chunks(content_id TEXT NOT NULL,byte_offset INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(content_id,byte_offset)); CREATE TABLE IF NOT EXISTS activities(session_scope TEXT NOT NULL,item_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_scope,item_id));");
    } catch (error) { this.db.close(); throw error; }
  }
  put(scope: string, itemId: string, kind: ContentRef["kind"], label: string, text: string | null, completeness: ContentRef["completeness"] = "unknown"): ContentRef {
    if (text === null) return { contentId:null,kind,label,byteLength:null,availability:"unavailable",completeness:"unknown" };
    const body = Buffer.from(text,"utf8"), contentId = createHash("sha256").update(JSON.stringify([scope,itemId,kind,label,completeness])).update(body).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO contents VALUES(?,?,?,?,?)").run(contentId,scope,body,body.length,completeness);
    return { contentId,kind,label,byteLength:body.length,availability:completeness === "partial" ? "partial" : "available",completeness };
  }
  startCapture(scope: string, itemId: string): ContentRef {
    const id = createHash("sha256").update(JSON.stringify([scope,itemId,"capture"])).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO contents VALUES(?,?,NULL,0,'partial')").run(id,scope);
    return this.captureRef(scope,id);
  }
  appendCapture(scope: string, id: string, text: string): void {
    const row = this.db.prepare("SELECT byte_length,completeness FROM contents WHERE content_id=? AND session_scope=? AND body IS NULL").get(id,scope);
    if (!row || row.completeness !== "partial") fail("INVALID_INPUT","Output capture is not active.");
    const data = Buffer.from(text,"utf8"), start = Number(row.byte_length);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (let offset=0;offset<data.length;offset+=65536) this.db.prepare("INSERT INTO content_chunks VALUES(?,?,?)").run(id,start+offset,data.subarray(offset,offset+65536));
      this.db.prepare("UPDATE contents SET byte_length=? WHERE content_id=?").run(start+data.length,id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finishCapture(scope: string, id: string): ContentRef {
    this.db.prepare("UPDATE contents SET completeness='complete' WHERE content_id=? AND session_scope=?").run(id,scope);
    return this.captureRef(scope,id);
  }
  captureRef(scope: string, id: string): ContentRef {
    const row = this.db.prepare("SELECT byte_length,completeness FROM contents WHERE content_id=? AND session_scope=?").get(id,scope);
    if (!row) fail("NOT_FOUND","Output capture is unavailable.");
    const completeness = String(row.completeness) as ContentRef["completeness"];
    return { contentId:id,kind:"output",label:"Command output",byteLength:Number(row.byte_length),availability:completeness === "partial" ? "partial" : "available",completeness };
  }
  isCapture(scope: string, id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM contents WHERE content_id=? AND session_scope=? AND body IS NULL").get(id,scope)); }
  saveActivity(scope: string, activity: SessionActivity): SessionActivity {
    const row = this.db.prepare("SELECT value FROM activities WHERE session_scope=? AND item_id=?").get(scope,activity.id);
    const previous = row ? JSON.parse(String(row.value)) as SessionActivity : undefined;
    if (previous?.itemComplete && !activity.itemComplete) activity = { ...previous,ordinal:activity.ordinal ?? previous.ordinal };
    else if (previous?.updatedOrdinal != null && activity.updatedOrdinal != null && previous.updatedOrdinal > activity.updatedOrdinal) activity = previous;
    this.db.prepare("INSERT INTO activities VALUES(?,?,?) ON CONFLICT(session_scope,item_id) DO UPDATE SET value=excluded.value").run(scope,activity.id,JSON.stringify(activity));
    return activity;
  }
  getActivity(scope: string, itemId: string): SessionActivity {
    const row = this.db.prepare("SELECT value FROM activities WHERE session_scope=? AND item_id=?").get(scope,itemId);
    if (!row) fail("NOT_FOUND","Activity is unavailable in this conversation.");
    return JSON.parse(String(row.value)) as SessionActivity;
  }
  read(scope: string, contentId: string, cursor?: string, limitBytes = 65536): ContentPage {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 4 || limitBytes > 262144) fail("INVALID_INPUT","Content chunks must be from 4 bytes to 256 KiB.");
    let offset = 0;
    if (cursor !== undefined) {
      try {
        if (!/^[a-zA-Z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
        if (value.version !== 1 || value.contentId !== contentId || value.scope !== scope || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
        offset = value.offset;
      } catch { fail("INVALID_INPUT","Invalid content cursor for this conversation."); }
    }
    const row = this.db.prepare("SELECT byte_length AS size,body IS NULL AS chunked,substr(body,?,?) AS data,completeness FROM contents WHERE content_id=? AND session_scope=?").get(offset+1,limitBytes+4,contentId,scope);
    if (!row) fail("NOT_FOUND","Content is unavailable in this conversation.");
    const total = Number(row.size);
    const data = row.chunked ? Buffer.concat(this.db.prepare("SELECT byte_offset,data FROM content_chunks WHERE content_id=? AND byte_offset<? AND byte_offset+length(data)>? ORDER BY byte_offset").all(contentId,offset+limitBytes+4,offset).map(chunk => Buffer.from(chunk.data as Uint8Array).subarray(Math.max(0,offset-Number(chunk.byte_offset)),Math.min(Number((chunk.data as Uint8Array).byteLength),offset+limitBytes+4-Number(chunk.byte_offset))))) : Buffer.from(row.data as Uint8Array);
    if (offset > total || (data.length && (data[0]! & 0xc0) === 0x80)) fail("INVALID_INPUT","Content cursor is not on a UTF-8 boundary.");
    let end = Math.min(limitBytes,data.length);
    while (end < data.length && (data[end]! & 0xc0) === 0x80) end--;
    const next = offset+end, completeness = String(row.completeness) as ContentRef["completeness"];
    return { contentId,text:data.subarray(0,end).toString("utf8"),byteOffset:offset,byteLength:total,
      nextCursor:next < total ? Buffer.from(JSON.stringify({ version:1,scope,contentId,offset:next })).toString("base64url") : null,
      completeness,availability:completeness === "partial" ? "partial" : "available" };
  }
  close(): void { this.db.close(); }
}
