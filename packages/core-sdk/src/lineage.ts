import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { checkAbort, object, report, uuid } from "./internal.js";
import type { Context } from "./internal.js";
import type { CodexSession, SourceReport } from "./types.js";

const MAX_HEADER_BYTES = 65536;
async function* files(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    checkAbort(signal);
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, signal);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield path;
    else if (entry.isSymbolicLink() && /^rollout-.*\.jsonl$/.test(entry.name)) yield path;
  }
}
export async function readLineageHeader(path: string, root: string): Promise<{ id: string; parentId: string | null; forkedFromId: string | null }> {
  const rel = relative(root, await realpath(path));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || (await lstat(path)).isSymbolicLink()) throw new Error("Unsupported metadata path.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let line: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error("Unsupported metadata file.");
    // Read incrementally and stop at the first newline, without parsing later records.
    let buffer = Buffer.alloc(0);
    while (true) {
      const chunk = Buffer.alloc(Math.min(1024, MAX_HEADER_BYTES + 1 - buffer.length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      const end = buffer.indexOf(10);
      if (end >= 0) { line = buffer.subarray(0, end); break; }
      if (buffer.length > MAX_HEADER_BYTES) throw new Error("Header limit.");
      if (!bytesRead) { line = buffer; break; }
    }
  } finally { await handle.close(); }
  if (line.length > MAX_HEADER_BYTES) throw new Error("Header limit.");
  const record = object(JSON.parse(line.toString("utf8"))), payload = object(record.payload);
  const id = record.type === "session_meta" ? uuid(payload.id) : null;
  if (!id) throw new Error("Invalid session metadata.");
  const relation = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const related = uuid(value);
    if (!related || related === id) throw new Error("Invalid relationship.");
    return related;
  };
  return { id, parentId: relation(payload.parent_thread_id), forkedFromId: relation(payload.forked_from_id) };
}

export async function inspectLineage(home: string, sessions: CodexSession[], ctx: Context): Promise<SourceReport> {
  const status = report("lineage", home), deadline = Date.now() + ctx.sourceBudgetMs;
  status.counts = { headers: 0, unknown: 0, parents: 0, forks: 0 };
  const byId = new Map(sessions.filter(session => session.codexHome === home).map(session => [session.id, session]));
  const relationships = new Map<string, Awaited<ReturnType<typeof readLineageHeader>>>();
  const conflicting = new Set<string>();
  let roots = 0, count = 0;
  try {
    for (const name of ["sessions", "archived_sessions"]) {
      const root = join(home, name);
      try { if (!(await lstat(root)).isDirectory()) continue; } catch { continue; }
      roots++;
      for await (const path of files(root, ctx.signal)) {
        if (++count > ctx.maxSessions || Date.now() > deadline) throw new Error("Metadata limit.");
        try {
          const row = await readLineageHeader(path, root), previous = relationships.get(row.id);
          if (conflicting.has(row.id)) continue;
          if (previous && (previous.parentId !== row.parentId || previous.forkedFromId !== row.forkedFromId)) {
            conflicting.add(row.id); relationships.delete(row.id); status.counts.unknown!++; continue;
          }
          relationships.set(row.id, row); status.counts.headers!++;
        } catch { checkAbort(ctx.signal); status.counts.unknown!++; }
      }
    }
  } catch { checkAbort(ctx.signal); status.counts.unknown!++; }
  for (const row of relationships.values()) {
    status.counts.parents! += Number(row.parentId !== null); status.counts.forks! += Number(row.forkedFromId !== null);
    const session = byId.get(row.id);
    if (!session) continue;
    session.lineageObservedAt = status.observedAt;
    for (const field of ["parentId", "forkedFromId"] as const) {
      if (!session[field] && row[field]) {
        session[field] = row[field]; session.fieldSources[field] = "lineage";
        if (!session.sources.includes("lineage")) session.sources.push("lineage");
      }
    }
    if (session.parentId && ["session", "unknown"].includes(session.kind)) session.kind = "child_session";
  }
  if (status.counts.unknown) { status.state = "partial"; status.error = "Some session metadata headers were unavailable, invalid, conflicting, or outside the inspection limit."; }
  else if (!roots) { status.state = "unavailable"; status.error = "No session metadata directories were found."; }
  return status;
}
