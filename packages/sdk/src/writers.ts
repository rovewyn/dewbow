import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { endianness } from "node:os";
import { basename, dirname, join } from "node:path";
import { checkAbort, isMissing, report, runCommand, uuid } from "./internal.js";
import type { Context } from "./internal.js";
import { parseOpenFiles } from "./processes.js";
import type { CodexSession, SourceReport } from "./types.js";

let nativeQuery: ((fd: number, command: number, type: string, buffer: Buffer) => number) | undefined;
export function queryWriterLock(path: string): { held: boolean; pid: number | null } {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || endianness() !== "LE") throw new Error("Unsupported writer lock ABI.");
  if (!nativeQuery) {
    const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
    nativeQuery = koffi.load("/usr/lib/libSystem.B.dylib").func("int fcntl(int fd, int command, ...)");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error("Unsupported lock file.");
    // Darwin 64-bit struct flock: off_t start/length, int pid, short type/whence.
    const request = Buffer.alloc(24);
    request.writeInt16LE(3, 20); // F_WRLCK; SEEK_SET, start=0, len=0 means whole file.
    // F_GETLK is a query only. No flock(), F_SETLK, or writes are issued.
    if (nativeQuery(fd, 7, "void *", request) !== 0) throw new Error("Writer lock query failed.");
    const type = request.readInt16LE(20), pid = request.readInt32LE(16);
    if (type === 2) return { held: false, pid: null }; // F_UNLCK.
    if (type === 3) return { held: true, pid: pid > 0 ? pid : null };
    throw new Error("Unsupported lock state.");
  } finally { closeSync(fd); }
}

export async function inspectWriters(sessions: CodexSession[], ctx: Context): Promise<SourceReport[]> {
  const groups = new Map<string, CodexSession[]>();
  for (const session of sessions) {
    const group = groups.get(session.codexHome) ?? [];
    group.push(session); groups.set(session.codexHome, group);
  }
  const reports: SourceReport[] = [];
  for (const [home, rows] of groups) {
    const status = report("writers", home), directory = join(home, "thread-writer-locks");
    status.counts = { checked: 0, held: 0, unknown: 0, openFilePidLookup: null };
    try {
      if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || endianness() !== "LE") throw new Error("Unsupported platform.");
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error("Unavailable namespace.");
    } catch {
      status.state = "unavailable"; status.error = "Writer lock inspection requires 64-bit macOS and an available writer lock directory.";
    }
    const deadline = Date.now() + ctx.sourceBudgetMs;
    for (const session of rows) {
      checkAbort(ctx.signal);
      session.writerObservedAt = status.observedAt;
      if (status.state !== "unavailable" && Date.now() <= deadline) {
        try {
          const id = uuid(session.id);
          if (!id) throw new Error("Invalid session ID.");
          let lock: { held: boolean; pid: number | null };
          try { lock = queryWriterLock(join(directory, id + ".lock")); }
          catch (error) { if (!isMissing(error)) throw error; lock = { held: false, pid: null }; }
          session.hasActiveWriter = lock.held; session.writerPid = lock.pid;
          session.fieldSources.hasActiveWriter = "writers";
          if (lock.pid !== null) session.fieldSources.writerPid = "writers";
          if (!session.sources.includes("writers")) session.sources.push("writers");
          status.counts.checked!++; status.counts.held! += Number(lock.held);
        } catch { /* Unknown remains null; no alternate lock probe is attempted. */ }
      }
      if (session.hasActiveWriter === null) status.counts.unknown!++;
    }
    if (status.state !== "unavailable") {
      try {
        const result = await runCommand("lsof", ["-nP", "-a", "-u", String(process.getuid?.()), "+d", directory, "-Fpftn"],
          { ...ctx, commandTimeoutMs: Math.min(ctx.commandTimeoutMs, ctx.sourceBudgetMs) });
        if (![0, 1].includes(result.code) || (result.code === 1 && result.hasDiagnostics)) throw new Error("Open-file lookup failed.");
        const files = parseOpenFiles(result.stdout).filter(file => file.type === "REG" && dirname(file.path) === directory);
        const holders = new Map<string, Set<number>>();
        for (const file of files) {
          if (!file.path.endsWith(".lock")) continue;
          const id = uuid(basename(file.path, ".lock"));
          if (id) { const pids = holders.get(id) ?? new Set<number>(); pids.add(file.pid); holders.set(id, pids); }
        }
        for (const session of rows) {
          session.writerOpenPids = [...(holders.get(session.id) ?? [])].sort((a, b) => a - b);
          session.writerOpenPidSource = "os-open-files";
          session.fieldSources.writerOpenPids = "writers";
        }
        status.counts.openFilePidLookup = 1;
      } catch { checkAbort(ctx.signal); status.counts.openFilePidLookup = null; }
      if (status.counts.unknown || status.counts.openFilePidLookup === null) {
        status.state = "partial"; status.error = "Some writer locks or open-file PID observations could not be inspected.";
      }
    }
    reports.push(status);
  }
  return reports;
}
