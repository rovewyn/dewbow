import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { attribute, boolean, canonicalHome, checkAbort, emptySession, number, object, text, uuid } from "./internal.js";
import type { Context } from "./internal.js";
import type { CodexSession, RuntimeReport, RuntimeStatus } from "./types.js";

const MAX_MESSAGE = 8 * 1024 * 1024;
const methods = new Set(["initialize", "thread/list", "thread/loaded/list", "thread/read"]);
const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
const statuses: RuntimeStatus[] = ["notLoaded", "idle", "active", "systemError"];
const flags = new Set(["waitingOnApproval", "waitingOnUserInput"]);

class UnixWebSocket {
  private buffer: Buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private readonly socket: Socket;
  private readonly deadline: number;
  private requestId = 0;
  private readonly abort: () => void;
  constructor(path: string, private readonly ctx: Context) {
    this.deadline = Date.now() + 20000;
    this.socket = createConnection(path);
    this.socket.on("data", chunk => {
      if (this.buffer.length + chunk.length > MAX_MESSAGE + 16384) { this.fail("Public API response exceeded the size limit."); return; }
      this.buffer = Buffer.concat([this.buffer, chunk]); this.wake?.();
    });
    this.socket.on("error", () => this.fail("Public API connection failed."));
    this.socket.on("close", () => this.fail("Public API connection closed."));
    this.abort = () => this.fail("Session discovery was aborted.");
    ctx.signal?.addEventListener("abort", this.abort, { once: true });
  }
  private fail(message: string): void { this.failure ??= new Error(message); this.socket.destroy(); this.wake?.(); }
  close(): void { this.ctx.signal?.removeEventListener("abort", this.abort); this.socket.destroy(); }
  private async more(): Promise<void> {
    checkAbort(this.ctx.signal);
    if (this.failure) throw this.failure;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error("Public API snapshot exceeded its time budget.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.wake = null; reject(new Error("Public API connection timed out.")); }, Math.min(3000, remaining));
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
    checkAbort(this.ctx.signal);
    if (this.failure) throw this.failure;
  }
  private async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) await this.more();
    const result = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return result;
  }
  async initialize(): Promise<Record<string, unknown>> {
    const key = randomBytes(16).toString("base64");
    this.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n");
    let end: number;
    while ((end = this.buffer.indexOf("\r\n\r\n")) < 0) {
      if (this.buffer.length > 16384) throw new Error("Public WebSocket handshake exceeded the size limit.");
      await this.more();
    }
    if (end > 16384) throw new Error("Public WebSocket handshake exceeded the size limit.");
    const lines = this.buffer.subarray(0, end).toString("ascii").split("\r\n"); this.buffer = this.buffer.subarray(end + 4);
    const headers = new Map(lines.slice(1).flatMap(line => { const index = line.indexOf(":"); return index < 0 ? [] : [[line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()]]; }));
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    if (lines[0]?.split(" ")[1] !== "101" || headers.get("sec-websocket-accept") !== accept ||
      headers.get("upgrade")?.toLowerCase() !== "websocket" || !headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) throw new Error("Public WebSocket handshake was rejected.");
    const result = await this.request("initialize", { clientInfo: { name: "dewbow-sdk", title: "Dewbow SDK", version: "0.1.0" }, capabilities: { experimentalApi: false } });
    this.sendJson({ method: "initialized" }); return result;
  }
  private send(payload: Buffer, opcode = 1): void {
    checkAbort(this.ctx.signal);
    const mask = randomBytes(4), size = payload.length;
    const header = Buffer.alloc(size < 126 ? 2 : size < 65536 ? 4 : 10);
    header[0] = 128 | opcode;
    header[1] = 128 | (size < 126 ? size : size < 65536 ? 126 : 127);
    if (header.length === 4) header.writeUInt16BE(size, 2);
    if (header.length === 10) header.writeBigUInt64BE(BigInt(size), 2);
    const masked = Buffer.from(payload);
    for (let i = 0; i < size; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  private sendJson(value: unknown): void { this.send(Buffer.from(JSON.stringify(value))); }
  private async receive(): Promise<Record<string, unknown>> {
    const parts: Buffer[] = [];
    let started = false, total = 0;
    while (true) {
      const header = await this.read(2), first = header[0]!, second = header[1]!, opcode = first & 15, final = Boolean(first & 128);
      if ((first & 112) || (second & 128)) throw new Error("Unsupported public WebSocket frame.");
      let size = second & 127;
      if (size === 126) size = (await this.read(2)).readUInt16BE();
      else if (size === 127) { const large = (await this.read(8)).readBigUInt64BE(); if (large > BigInt(MAX_MESSAGE)) throw new Error("Public API response exceeded the size limit."); size = Number(large); }
      if (size > MAX_MESSAGE || total + size > MAX_MESSAGE) throw new Error("Public API response exceeded the size limit.");
      if (opcode >= 8 && (!final || size > 125)) throw new Error("Invalid public WebSocket control frame.");
      const payload = await this.read(size);
      if (opcode === 8) throw new Error("Public API connection closed.");
      if (opcode === 9) { this.send(payload, 10); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 && !started) started = true;
      else if (opcode !== 0 || !started) throw new Error("Expected a public API text message.");
      parts.push(payload); total += size;
      if (final) {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Malformed public API message.");
        return object(parsed);
      }
    }
  }
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!methods.has(method) || (method === "thread/read" && params.includeTurns !== false) || (method === "thread/list" && params.useStateDbOnly !== true)) throw new Error("Only read-only discovery RPCs are allowed.");
    const id = ++this.requestId;
    this.sendJson({ id, method, params });
    while (true) {
      const message = await this.receive();
      if ("method" in message) { if ("id" in message) throw new Error("Unexpected server request; no action was approved."); continue; }
      if (message.id !== id || "error" in message || !message.result || typeof message.result !== "object" || Array.isArray(message.result)) throw new Error("Public API request failed or returned an invalid result.");
      return object(message.result);
    }
  }
  async *pages(method: string, params: Record<string, unknown>): AsyncGenerator<unknown> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const result = await this.request(method, { ...params, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error("Malformed public API page.");
      yield* result.data;
      if (result.nextCursor === null || result.nextCursor === undefined) return;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) throw new Error("Invalid public API cursor.");
      cursor = result.nextCursor; seen.add(cursor);
    }
    throw new Error("Public API pagination exceeded the page limit.");
  }
}

function normalize(thread: Record<string, unknown>, home: string, archived: boolean | null, loaded: boolean, runtime: RuntimeReport): CodexSession {
  const id = uuid(thread.id);
  if (!id) throw new Error("Invalid API session ID.");
  const session = emptySession(id, home), child = object(thread.source).subAgent, spawn = object(object(child).thread_spawn);
  const status = object(thread.status), active = Array.isArray(status.activeFlags) ? status.activeFlags.filter((value): value is string => typeof value === "string" && flags.has(value)) : [];
  session.title = text(thread.title); session.nickname = text(thread.agentNickname, 256) ?? text(spawn.agent_nickname, 256);
  const name = text(thread.name) ?? session.nickname ?? session.title;
  session.name = name ?? session.name;
  session.parentId = uuid(thread.parentThreadId) ?? uuid(spawn.parent_thread_id);
  session.forkedFromId = uuid(thread.forkedFromId);
  session.kind = child === "review" || object(child).other === "guardian" || thread.threadSource === "guardian_review" ? "review_session"
    : child !== undefined || session.parentId || thread.threadSource === "subagent" ? "child_session" : typeof thread.source === "string" ? "session" : "unknown";
  session.workspace = text(thread.cwd, 4096); session.model = text(thread.model, 256); session.modelProvider = text(thread.modelProvider, 256);
  session.role = text(thread.agentRole, 256) ?? text(spawn.agent_role, 256); session.reasoningEffort = text(thread.reasoningEffort, 128);
  session.source = child !== undefined ? "subAgent" : text(thread.source, 128); session.originator = text(thread.originator, 256);
  session.cliVersion = text(thread.cliVersion, 128); session.createdAt = number(thread.createdAt); session.updatedAt = number(thread.updatedAt);
  session.archived = archived; session.ephemeral = boolean(thread.ephemeral);
  session.runtimeStatus = statuses.includes(status.type as RuntimeStatus) ? status.type as RuntimeStatus : "unknown";
  session.activeFlags = active; session.pids = loaded ? [...runtime.pids] : [];
  session.runtimeReports = [{ runtimeId: runtime.id, loaded, status: session.runtimeStatus, activeFlags: active, pids: session.pids }];
  attribute(session, "app-server", ["title", "nickname", "kind", "parentId", "forkedFromId", "workspace", "model", "modelProvider", "role", "reasoningEffort", "source", "originator", "cliVersion", "createdAt", "updatedAt", "archived", "ephemeral", "runtimeStatus"]);
  if (name) session.fieldSources.name = "app-server";
  return session;
}

export async function readAppServer(runtime: RuntimeReport, ctx: Context): Promise<CodexSession[]> {
  let client: UnixWebSocket | undefined;
  try {
    if (!runtime.endpoint) throw new Error("No endpoint selected.");
    const info = await lstat(runtime.endpoint);
    if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error("Endpoint must be a Unix socket owned by the current user.");
    checkAbort(ctx.signal);
    client = new UnixWebSocket(runtime.endpoint, ctx);
    const initialized = await client.initialize();
    const home = text(initialized.codexHome, 4096) ? await canonicalHome(String(initialized.codexHome)) : ctx.home;
    const loaded = new Set<string>(), threads = new Map<string, { thread: Record<string, unknown>; archived: boolean | null }>();
    for await (const raw of client.pages("thread/loaded/list", { limit: 100 })) {
      const id = uuid(raw); if (!id) throw new Error("Invalid loaded-session ID."); loaded.add(id);
      if (loaded.size > ctx.maxSessions) throw new Error("Session limit.");
    }
    for (const archived of [false, true]) {
      for await (const raw of client.pages("thread/list", { limit: 100, archived, modelProviders: [], sourceKinds, useStateDbOnly: true })) {
        const thread = object(raw), id = uuid(thread.id); if (!id) throw new Error("Invalid session metadata.");
        threads.set(id, { thread, archived }); if (threads.size > ctx.maxSessions) throw new Error("Session limit.");
      }
    }
    for (const id of loaded) {
      const thread = object((await client.request("thread/read", { threadId: id, includeTurns: false })).thread);
      if (uuid(thread.id) !== id) throw new Error("Invalid loaded-session metadata.");
      threads.set(id, { thread, archived: threads.get(id)?.archived ?? null });
      if (threads.size > ctx.maxSessions) throw new Error("Session limit.");
    }
    const sessions = [...threads.values()].map(({ thread, archived }) => normalize(thread, home, archived, loaded.has(String(thread.id)), runtime));
    runtime.state = "connected"; runtime.codexHome = home; runtime.loadedSessions = loaded.size; runtime.listedSessions = threads.size;
    return sessions;
  } catch {
    checkAbort(ctx.signal);
    runtime.state = "error"; runtime.error = "Public API snapshot failed: connection, protocol, or inspection limit.";
    return [];
  } finally { client?.close(); }
}
