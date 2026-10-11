import { resolve } from "node:path";
import { canonicalHome, checkAbort, context, report } from "./internal.js";
import { readDatabase } from "./database.js";
import { inspectCli } from "./cli.js";
import { inspectProcesses } from "./processes.js";
import { readAppServer } from "./app-server.js";
import { inspectLineage } from "./lineage.js";
import { inspectWriters } from "./writers.js";
import type { CodexProcess, CodexSession, DiscoverOptions, DiscoverySnapshot, RuntimeReport, SourceName, SourceReport } from "./types.js";

export function selectEndpoints(processes: readonly CodexProcess[], explicit: readonly string[]): RuntimeReport[] {
  const selected = new Map<string, number[]>(), runtimes: RuntimeReport[] = [];
  const endpoints = [...new Set(explicit.map(path => resolve(path)))];
  const base = { state: "unavailable" as const, error: null, codexHome: null, loadedSessions: null, listedSessions: null };
  for (const item of processes.filter(process => process.mode === "app-server")) {
    const candidates = endpoints.length ? item.controlSockets.filter(path => endpoints.includes(path)) : item.controlSockets;
    if (candidates.length !== 1) {
      runtimes.push({ ...base, id: "pid:" + item.pid, endpoint: null, pids: [item.pid],
        error: candidates.length ? "Multiple sockets found; select an existing endpoint explicitly." : "No public endpoint was selected." });
    } else {
      const path = candidates[0]!;
      selected.set(path, [...(selected.get(path) ?? []), item.pid]);
    }
  }
  for (const path of endpoints) if (!selected.has(path)) selected.set(path, []);
  for (const [endpoint, pids] of selected) runtimes.push({ ...base, id: "socket:" + endpoint, endpoint, pids });
  return runtimes;
}
function priority(session: CodexSession): number[] {
  return [Number(session.sources.includes("app-server")), Number(session.runtimeReports.some(row => row.loaded)),
    Number(session.runtimeStatus === "active"), Number(session.sources.includes("database")), session.updatedAt ?? 0];
}
function higher(a: CodexSession, b: CodexSession): boolean {
  const left = priority(a), right = priority(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}
function copyField<K extends keyof CodexSession>(target: CodexSession, source: CodexSession, key: K): void {
  target[key] = source[key]; target.fieldSources[key] = source.fieldSources[key]!;
}
export function mergeSessions(previous: CodexSession | undefined, incoming: CodexSession): CodexSession {
  if (!previous) return incoming;
  const [preferred, other] = higher(incoming, previous) ? [incoming, previous] : [previous, incoming];
  const merged = { ...preferred, fieldSources: { ...preferred.fieldSources } };
  for (const key of Object.keys(other.fieldSources) as (keyof CodexSession)[]) if (!merged.fieldSources[key]) copyField(merged, other, key);
  merged.sources = [...new Set([...previous.sources, ...incoming.sources])].sort();
  merged.cliInspectionStates = [...new Set([...previous.cliInspectionStates, ...incoming.cliInspectionStates])].sort();
  merged.runtimeReports = [...previous.runtimeReports, ...incoming.runtimeReports];
  merged.pids = [...new Set(merged.runtimeReports.flatMap(row => row.pids))].sort((a, b) => a - b);
  if (merged.parentId && ["session", "unknown"].includes(merged.kind)) {
    merged.kind = "child_session"; if (merged.fieldSources.parentId) merged.fieldSources.kind = merged.fieldSources.parentId;
  }
  return merged;
}

/** A one-shot read-only snapshot. No listeners, timers, HTTP server, or model turns remain after return. */
export async function discoverSessions(options: DiscoverOptions = {}): Promise<DiscoverySnapshot> {
  const ctx = await context(options), reports: SourceReport[] = [];
  const configuredHomes = [...new Set([ctx.home, ...await Promise.all((options.additionalHomes ?? []).map(canonicalHome))])];
  const inventory = new Map<string, CodexSession>();
  const add = (sessions: readonly CodexSession[]) => {
    for (const session of sessions) {
      const key = session.codexHome + "\0" + session.id;
      if (!inventory.has(key) && inventory.size >= ctx.maxSessions) throw new RangeError("Combined session inventory exceeded the configured limit.");
      inventory.set(key, mergeSessions(inventory.get(key), session));
    }
  };
  for (const source of ["database", "app-server", "cli", "lineage", "writers", "processes"] as SourceName[]) {
    if (!ctx.sources.has(source)) reports.push({ ...report(source, null), state: "disabled" });
  }
  let processes: CodexProcess[] = [];
  if (ctx.sources.has("processes")) { const result = await inspectProcesses(ctx); processes = result.processes; reports.push(result.report); }
  if (ctx.sources.has("cli")) for (const home of configuredHomes) {
    const result = await inspectCli({ ...ctx, home }); add(result.sessions); reports.push(result.report);
  }
  const runtimes = ctx.sources.has("app-server") ? selectEndpoints(processes, options.sockets ?? []) : [];
  if (ctx.sources.has("app-server")) {
    const apiSessions = new Set<string>();
    for (const runtime of runtimes) {
      checkAbort(ctx.signal);
      if (runtime.endpoint) {
        const sessions = await readAppServer(runtime, ctx);
        for (const session of sessions) apiSessions.add(session.codexHome + "\0" + session.id);
        add(sessions);
      }
    }
    const status = report("app-server", null), connected = runtimes.filter(runtime => runtime.state === "connected").length;
    status.state = connected ? connected === runtimes.length ? "success" : "partial" : runtimes.some(runtime => runtime.state === "error") ? "error" : "unavailable";
    status.error = status.state === "success" ? null : "Some or all public runtimes could not be queried; runtime states remain unknown.";
    status.counts = { connected, runtimes: runtimes.length, sessions: connected ? apiSessions.size : null };
    reports.push(status);
  }
  const homes = [...new Set([...configuredHomes,
    ...runtimes.flatMap(runtime => runtime.codexHome ? [runtime.codexHome] : [])])];
  if (ctx.sources.has("database")) for (const home of homes) { const result = await readDatabase(home, ctx); add(result.sessions); reports.push(result.report); }
  const sessions = [...inventory.values()].sort((a, b) => Number(b.runtimeReports.some(row => row.loaded)) - Number(a.runtimeReports.some(row => row.loaded)) ||
    Number(b.runtimeStatus === "active") - Number(a.runtimeStatus === "active") || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
  if (ctx.sources.has("lineage")) for (const home of homes) reports.push(await inspectLineage(home, sessions, ctx));
  if (ctx.sources.has("writers")) reports.push(...await inspectWriters(sessions, ctx));
  checkAbort(ctx.signal);
  const connected = runtimes.filter(runtime => runtime.state === "connected").length;
  const inventoryKnown = reports.some(row => ["database", "cli", "app-server"].includes(row.source) && ["success", "partial"].includes(row.state));
  const emptyKnown = inventoryKnown && sessions.length === 0;
  return { observedAt: new Date().toISOString(), sessions, processes, runtimes, sources: reports,
    warnings: [...new Set([...reports.flatMap(row => row.error ? [row.error] : []), ...runtimes.flatMap(row => row.error ? [row.error] : [])])],
    summary: {
      sessions: inventoryKnown ? sessions.length : null,
      archived: emptyKnown || sessions.some(row => row.archived !== null) ? sessions.filter(row => row.archived).length : null,
      childSessions: emptyKnown || sessions.some(row => row.kind !== "unknown") ? sessions.filter(row => ["child_session", "review_session"].includes(row.kind)).length : null,
      parentRelationships: sessions.filter(row => row.parentId).length, forkRelationships: sessions.filter(row => row.forkedFromId).length,
      loadedSessions: connected ? sessions.filter(row => row.runtimeReports.some(scope => scope.loaded)).length : null,
      activeSessions: connected ? sessions.filter(row => row.runtimeReports.some(scope => scope.loaded && scope.status === "active")).length : null,
      activeWriters: (emptyKnown && ctx.sources.has("writers")) || sessions.some(row => row.hasActiveWriter !== null) ? sessions.filter(row => row.hasActiveWriter).length : null,
      unknownWriters: sessions.filter(row => row.hasActiveWriter === null).length, connectedRuntimes: connected,
    } };
}
