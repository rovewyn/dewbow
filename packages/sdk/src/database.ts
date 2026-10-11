import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attribute, boolean, checkAbort, emptySession, isMissing, number, object, report, text, uuid } from "./internal.js";
import type { Context } from "./internal.js";
import type { CodexSession, SourceReport } from "./types.js";

const textFields: Record<string, number> = { name: 1000, title: 1000, agent_nickname: 256, agent_role: 256,
  model: 256, model_provider: 256, cwd: 4096, cli_version: 128, reasoning_effort: 128,
  agent_path: 4096, originator: 256, source: 8192, thread_source: 128 };
const numericFields = ["created_at", "updated_at", "created_at_ms", "updated_at_ms", "archived", "archived_at", "is_pinned", "tokens_used"];

function sourceData(raw: unknown): { source: string | null; parent: string | null; nickname: string | null; role: string | null; child: boolean; review: boolean } {
  let parsed: unknown = raw;
  try { if (typeof raw === "string") parsed = JSON.parse(raw); } catch { /* Plain source tags are allowed. */ }
  const child = object(parsed).subagent ?? object(parsed).subAgent;
  const spawn = object(object(child).thread_spawn);
  const other = object(child).other;
  const known = ["cli", "vscode", "exec", "appServer", "app_server", "unknown"];
  return { source: child !== undefined ? "subAgent" : typeof parsed === "string" && known.includes(parsed) ? parsed : null,
    parent: uuid(spawn.parent_thread_id), nickname: text(spawn.agent_nickname, 256), role: text(spawn.agent_role, 256),
    child: child !== undefined, review: child === "review" || other === "guardian" || other === "guardian_review" };
}

export async function readDatabase(home: string, ctx: Context): Promise<{ report: SourceReport; sessions: CodexSession[] }> {
  const status = report("database", home);
  let database: DatabaseSync | undefined;
  try {
    checkAbort(ctx.signal);
    const candidates = (await readdir(home)).flatMap(name => {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    }).sort((a, b) => b.version - a.version);
    const selected = candidates[0];
    if (!selected) { status.state = "unavailable"; status.error = "No Codex state database was found."; return { report: status, sessions: [] }; }
    const path = join(home, selected.name);
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error("Unsupported database file.");
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has("threads")) throw new Error("Unsupported schema.");
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map(row => row.name));
    if (!columns.has("id")) throw new Error("Missing session ID.");
    const selection = ['"id"', ...Object.entries(textFields).filter(([field]) => columns.has(field)).map(([field, limit]) => `substr("${field}",1,${limit}) AS "${field}"`),
      ...numericFields.filter(field => columns.has(field)).map(field => `"${field}"`)];
    const parents = new Map<string, string>();
    const deadline = Date.now() + ctx.sourceBudgetMs;
    const budget = () => { checkAbort(ctx.signal); if (Date.now() > deadline) throw new Error("Database time limit."); };
    if (tables.has("thread_spawn_edges")) {
      const edges = new Set(database.prepare("PRAGMA table_info(thread_spawn_edges)").all().map(row => row.name));
      if (edges.has("parent_thread_id") && edges.has("child_thread_id")) {
        let count = 0;
        for (const row of database.prepare("SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges LIMIT ?").iterate(ctx.maxSessions + 1)) {
          budget();
          if (++count > ctx.maxSessions) throw new Error("Relationship limit.");
          const parent = uuid(row.parent_thread_id), child = uuid(row.child_thread_id);
          if (!parent || !child || parent === child) throw new Error("Invalid relationship.");
          parents.set(child, parent);
        }
      }
    }
    const sessions: CodexSession[] = [];
    for (const row of database.prepare("SELECT " + selection.join(",") + " FROM threads LIMIT ?").iterate(ctx.maxSessions + 1)) {
      budget();
      if (sessions.length >= ctx.maxSessions) throw new Error("Session limit.");
      const id = uuid(row.id);
      if (!id) throw new Error("Invalid session ID.");
      const session = emptySession(id, home), source = sourceData(row.source);
      session.title = text(row.title);
      session.nickname = text(row.agent_nickname, 256) ?? source.nickname;
      const savedName = text(row.name) ?? session.title ?? session.nickname;
      session.name = savedName ?? session.name;
      session.parentId = parents.get(id) ?? source.parent;
      session.source = source.source;
      session.kind = source.review || row.thread_source === "guardian_review" ? "review_session"
        : source.child || session.parentId || row.thread_source === "subagent" ? "child_session" : source.source ? "session" : "unknown";
      session.workspace = text(row.cwd, 4096); session.model = text(row.model, 256);
      session.modelProvider = text(row.model_provider, 256); session.role = text(row.agent_role, 256) ?? source.role;
      session.reasoningEffort = text(row.reasoning_effort, 128); session.originator = text(row.originator, 256);
      session.cliVersion = text(row.cli_version, 128);
      session.createdAt = number(row.created_at_ms) !== null ? Number(row.created_at_ms) / 1000 : number(row.created_at);
      session.updatedAt = number(row.updated_at_ms) !== null ? Number(row.updated_at_ms) / 1000 : number(row.updated_at);
      session.archived = boolean(row.archived); session.archivedAt = number(row.archived_at);
      session.pinned = boolean(row.is_pinned); session.tokensUsed = number(row.tokens_used);
      attribute(session, "database", ["title", "nickname", "kind", "parentId", "workspace", "model", "modelProvider", "role",
        "reasoningEffort", "source", "originator", "cliVersion", "createdAt", "updatedAt", "archived", "archivedAt", "pinned", "tokensUsed"]);
      if (savedName) session.fieldSources.name = "database";
      sessions.push(session);
    }
    status.counts = { sessions: sessions.length, databaseVersion: selected.version };
    return { report: status, sessions };
  } catch (error) {
    checkAbort(ctx.signal);
    status.state = isMissing(error) ? "unavailable" : "error";
    status.error = isMissing(error) ? "No Codex state database was found." : "Database inspection failed: unreadable file, incompatible schema, or query limit.";
    status.counts.sessions = null;
    return { report: status, sessions: [] };
  } finally { database?.close(); }
}
