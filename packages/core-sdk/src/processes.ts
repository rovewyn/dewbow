import { basename } from "node:path";
import { checkAbort, report, runCommand } from "./internal.js";
import type { Context } from "./internal.js";
import type { CodexProcess, SourceReport } from "./types.js";

export function processMode(command: string): CodexProcess["mode"] {
  const tokens = command.split(/\s+/);
  if (tokens.includes("--experimental-vm-modules")) return "execution-helper";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "app-server") return tokens[index + 1] === "daemon" ? "supervisor" : tokens[index + 1] === "proxy" ? "transport-proxy" : "app-server";
    if (token === "exec-server") return "execution-helper";
    if (token === "exec" || token === "mcp-server") return token;
  }
  return "unclassified";
}
export interface OpenFile { pid: number; path: string; type: string; }
export function parseOpenFiles(output: string): OpenFile[] {
  const files: OpenFile[] = [];
  let pid = 0, type = "";
  for (const line of output.split("\n")) {
    const key = line[0], value = line.slice(1);
    if (key === "p") { pid = Number(value); type = ""; }
    else if (key === "f") type = "";
    else if (key === "t") type = value;
    else if (key === "n" && Number.isSafeInteger(pid) && pid > 0) files.push({ pid, path: value, type });
  }
  return files;
}
export async function inspectProcesses(ctx: Context): Promise<{ report: SourceReport; processes: CodexProcess[] }> {
  const status = report("processes", null);
  const processes: CodexProcess[] = [];
  if (!["darwin", "linux"].includes(process.platform)) {
    status.state = "unavailable"; status.error = "Process discovery supports macOS and Linux.";
    return { report: status, processes };
  }
  try {
    const result = await runCommand("ps", ["-u", String(process.getuid?.()), "-o", "pid=,ppid=,comm="], ctx);
    if (result.code !== 0) throw new Error("Process inspection failed.");
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match || !["codex", "codex.exe"].includes(basename(match[3]!))) continue;
      const item: CodexProcess = { pid: Number(match[1]), parentPid: Number(match[2]), executable: match[3]!, mode: "unclassified", controlSockets: [] };
      try {
        const args = await runCommand("ps", ["-p", String(item.pid), "-o", "args="], ctx);
        if (args.code === 0) item.mode = processMode(args.stdout);
      } catch { checkAbort(ctx.signal); }
      processes.push(item);
    }
    if (processes.length) {
      const files = await runCommand("lsof", ["-nP", "-a", "-p", processes.map(p => p.pid).join(","), "-Fpftn"], ctx);
      if (files.code !== 0 && (files.code !== 1 || files.hasDiagnostics)) throw new Error("Socket inspection failed.");
      const sockets = parseOpenFiles(files.stdout).filter(file => file.type === "unix" && file.path.startsWith("/"));
      for (const item of processes) item.controlSockets = [...new Set(sockets.filter(file => file.pid === item.pid).map(file => file.path))].sort();
    }
    status.counts.processes = processes.length;
    return { report: status, processes };
  } catch {
    checkAbort(ctx.signal);
    status.state = processes.length ? "partial" : "error"; status.error = "OS process or socket inspection failed.";
    status.counts.processes = processes.length || null;
    return { report: status, processes };
  }
}
