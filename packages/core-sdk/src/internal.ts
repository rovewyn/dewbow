import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { CodexSession, DiscoverOptions, SourceName, SourceReport } from "./types.js";

export interface Context {
  home: string;
  sources: Set<SourceName>;
  signal: AbortSignal | undefined;
  maxSessions: number;
  commandTimeoutMs: number;
  sourceBudgetMs: number;
  codexExecutable: string;
}

export function uuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized) ? normalized : null;
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function text(value: unknown, limit = 1000): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}
export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function boolean(value: unknown): boolean | null {
  return value === true || value === 1 ? true : value === false || value === 0 ? false : null;
}
export async function canonicalHome(path: string): Promise<string> {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
  try { return await realpath(expanded); } catch { return expanded; }
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Session discovery was aborted.", "AbortError");
}
export async function context(options: DiscoverOptions): Promise<Context> {
  const all: SourceName[] = ["database", "app-server", "cli", "lineage", "writers", "processes"];
  if (options.sources?.some(source => !all.includes(source))) throw new TypeError("Unknown discovery source.");
  const bound = (value: number | undefined, fallback: number, maximum: number) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new RangeError("Invalid discovery limit.");
    return result;
  };
  checkAbort(options.signal);
  return { home: await canonicalHome(options.codexHome ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex")),
    sources: new Set(options.sources ?? all), signal: options.signal,
    maxSessions: bound(options.limits?.maxSessions, 50000, 50000),
    commandTimeoutMs: bound(options.limits?.commandTimeoutMs, 30000, 30000),
    sourceBudgetMs: bound(options.limits?.sourceBudgetMs, 3000, 20000), codexExecutable: options.codexExecutable ?? "codex" };
}
export function report(source: SourceName, home: string | null): SourceReport {
  return { source, codexHome: home, state: "success", error: null, observedAt: new Date().toISOString(), counts: {} };
}
export function emptySession(id: string, home: string): CodexSession {
  return { id, codexHome: home, name: "Session " + id.slice(0, 8), title: null, nickname: null,
    kind: "unknown", parentId: null, forkedFromId: null, workspace: null, model: null,
    modelProvider: null, role: null, reasoningEffort: null, source: null, originator: null,
    cliVersion: null, createdAt: null, updatedAt: null, archived: null, archivedAt: null,
    pinned: null, tokensUsed: null, ephemeral: null, runtimeStatus: "unknown", activeFlags: [], pids: [],
    runtimeReports: [], hasActiveWriter: null, writerPid: null, writerOpenPids: null,
    writerObservedAt: null, writerOpenPidSource: null, lineageObservedAt: null,
    cliInspectionStates: [], sources: [], fieldSources: {} };
}
export function attribute(session: CodexSession, source: SourceName, fields: readonly (keyof CodexSession)[]): void {
  for (const field of fields) if (session[field] !== null && session[field] !== "unknown") session.fieldSources[field] = source;
  if (!session.sources.includes(source)) session.sources.push(source);
}
export interface CommandResult { stdout: string; code: number; hasDiagnostics: boolean; }
/** Run Node CLI entry points directly, without a shell or platform command shim. */
export function nativeCommand(executable: string, args: readonly string[]): { executable: string; args: string[] } {
  if (process.platform === "win32" && basename(executable).toLowerCase() === "codex.js") {
    // The npm wrapper forwards signals on POSIX; Windows kills its Node process
    // directly. Require the native process instead of leaving a child untracked.
    throw new TypeError("Select the actual codex.exe instead of its Node wrapper on Windows.");
  }
  return [".js", ".mjs", ".cjs"].includes(extname(executable).toLowerCase())
    ? { executable: process.execPath, args: [executable, ...args] }
    : { executable, args: [...args] };
}
export function runCommand(executable: string, args: readonly string[], ctx: Context, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  checkAbort(ctx.signal);
  return new Promise((resolve, reject) => {
    const command = nativeCommand(executable, args);
    const child = execFile(command.executable, command.args, { timeout: ctx.commandTimeoutMs, maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8", windowsHide: true, signal: ctx.signal, env: env ?? process.env }, (error, stdout, stderr) => {
      if (ctx.signal?.aborted) { reject(new DOMException("Session discovery was aborted.", "AbortError")); return; }
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ stdout, code: error ? error.code as number : 0, hasDiagnostics: Boolean(stderr.trim()) });
    });
    child.stdin?.end();
  });
}
export function isMissing(error: unknown): boolean { return object(error).code === "ENOENT"; }
