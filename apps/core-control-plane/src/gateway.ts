import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { fail, ManagementError, now } from "@dewbow/core-protocol";
import { randomUUID } from "node:crypto";
import type { Command, Host, HostQuery, Session, ToControlPlane } from "@dewbow/core-protocol";
import type { ControlPlaneConfig } from "./config.js";
import { Management } from "./management.js";
import { sameSecret } from "./http.js";

interface HostPermission { hostId: string; name: string; token: string; revoked?: boolean }
interface Connection { socket: WebSocket; ready: boolean; lastPong: number; token: string }
export class Gateway {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  private readonly connections = new Map<string, Connection>();
  private readonly timer: NodeJS.Timeout;
  private readonly queries = new Map<string, { hostId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly config: ControlPlaneConfig, private readonly management: Management) {
    this.permissions();
    management.dispatch = (hostId, command) => this.send(hostId, command);
    management.query = (hostId, operation, input) => this.query(hostId, operation, input);
    this.timer = setInterval(() => this.heartbeat(), 10000);
  }
  permissions(): HostPermission[] {
    const values: unknown = JSON.parse(readFileSync(this.config.hostsFile, "utf8"));
    if (!Array.isArray(values)) throw new TypeError("Hosts file must contain an array.");
    const ids = new Set<string>(), tokens = new Set<string>();
    for (const host of values as HostPermission[]) {
      if (!host.hostId || !host.name || !host.token || ids.has(host.hostId) || tokens.has(host.token) || sameSecret(host.token, this.config.managementToken) || sameSecret(host.token, this.config.operatorPassword)) throw new TypeError("Hosts require unique IDs and separate credentials.");
      ids.add(host.hostId); tokens.add(host.token);
      const existing = this.management.store.get<Host>("host", host.hostId);
      this.management.store.put("host", host.hostId, { hostId: host.hostId, name: host.name, status: host.revoked ? "revoked" : existing?.status ?? "disconnected", lastSeenAt: existing?.lastSeenAt ?? null } satisfies Host);
    }
    for (const host of this.management.store.list<Host>("host")) {
      const permission = (values as HostPermission[]).find(p => p.hostId === host.hostId);
      if (!permission || permission.revoked) this.management.disconnect(host.hostId, true);
    }
    for (const [id, connection] of this.connections) {
      const permission = (values as HostPermission[]).find(p => p.hostId === id && !p.revoked && sameSecret(p.token, connection.token));
      if (!permission) { this.management.disconnect(id, true); connection.socket.terminate(); }
    }
    return values as HostPermission[];
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const permission = this.permissions().find(p => !p.revoked && sameSecret(p.token, token));
      if (!permission) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
      this.server.handleUpgrade(request, socket, head, connection => this.connect(connection, permission));
    } catch { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); }
  }
  private connect(socket: WebSocket, permission: HostPermission): void {
    if (this.connections.has(permission.hostId)) { socket.close(1008, "Host already connected"); return; }
    const connection: Connection = { socket, ready: false, lastPong: Date.now(), token: permission.token };
    this.connections.set(permission.hostId, connection);
    let initialized = false;
    const helloTimer = setTimeout(() => { if (!initialized) socket.terminate(); }, 10000);
    socket.on("error", () => {});
    socket.on("pong", () => { connection.lastPong = Date.now(); this.seen(permission.hostId); });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (this.connections.get(permission.hostId) !== connection) return;
      this.connections.delete(permission.hostId);
      const revoked = this.management.store.get<Host>("host", permission.hostId)?.status === "revoked";
      this.management.disconnect(permission.hostId, revoked);
      for (const [id, query] of this.queries) if (query.hostId === permission.hostId) {
        clearTimeout(query.timer); this.queries.delete(id);
        query.reject(new ManagementError({ code: "HOST_UNAVAILABLE", message: "Host disconnected during the native read.", retryable: true }));
      }
    });
    socket.on("message", bytes => {
      try {
        const frame = JSON.parse(bytes.toString()) as ToControlPlane;
        if (!initialized) {
          if (frame.type !== "hello" || frame.hostId !== permission.hostId) fail("UNAUTHORIZED", "Invalid host identity.");
          initialized = true; clearTimeout(helloTimer);
          const cursors = Object.fromEntries(this.management.store.list<Session>("session").filter(s => s.hostId === permission.hostId).map(s => [s.sessionId, s.latestCursor]));
          socket.send(JSON.stringify({ type: "sync", cursors })); return;
        }
        if (frame.type === "event") this.management.event(permission.hostId, frame.event);
        else if (frame.type === "result") this.management.result(permission.hostId, frame.result);
        else if (frame.type === "query_result") {
          const query = this.queries.get(frame.response.queryId);
          if (!query || query.hostId !== permission.hostId) return;
          clearTimeout(query.timer); this.queries.delete(frame.response.queryId);
          if (frame.response.error) query.reject(new ManagementError(frame.response.error));
          else query.resolve(frame.response.result);
        }
        else if (frame.type === "report") {
          this.management.reconcile(permission.hostId, frame.report);
          connection.ready = true; this.seen(permission.hostId, true);
          socket.send(JSON.stringify({ type: "ready" }));
          this.management.resumeCommands(permission.hostId, frame.report);
        } else fail("INVALID_INPUT", "Invalid host frame.");
      } catch { socket.close(1008, "Invalid host frame"); }
    });
  }
  private query(hostId: string, operation: HostQuery["operation"], input: HostQuery["input"]): Promise<unknown> {
    this.permissions();
    this.management.available(hostId);
    const connection = this.connections.get(hostId);
    if (!connection?.ready || connection.socket.readyState !== WebSocket.OPEN) fail("HOST_UNAVAILABLE", "Host is unavailable for native reads.", true);
    const queryId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.queries.delete(queryId); reject(new ManagementError({ code: "READ_TIMEOUT", message: "Native read timed out.", retryable: true })); }, 25000);
      this.queries.set(queryId, { hostId, resolve, reject, timer });
      connection.socket.send(JSON.stringify({ type: "query", query: { queryId, operation, input } }));
    });
  }
  private seen(hostId: string, connected = false): void {
    const host = this.management.store.get<Host>("host", hostId)!;
    host.lastSeenAt = now(); if (connected) host.status = "connected";
    this.management.store.put("host", hostId, host);
  }
  private send(hostId: string, command: Command): void {
    const connection = this.connections.get(hostId);
    let permission: HostPermission | undefined;
    try { permission = this.permissions().find(p => p.hostId === hostId); } catch { /* Invalid configuration disables delivery. */ }
    if (!permission || permission.revoked || !connection || !sameSecret(connection.token, permission.token)) {
      this.management.disconnect(hostId, !permission || permission.revoked === true); connection?.socket.terminate(); return;
    }
    if (connection.ready && connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({ type: "command", command }));
  }
  private heartbeat(): void {
    let permissions: HostPermission[] = [];
    try { permissions = this.permissions(); } catch { /* Fail closed until the operator fixes configuration. */ }
    for (const [hostId, connection] of this.connections) {
      const permission = permissions.find(p => p.hostId === hostId && !p.revoked && sameSecret(p.token, connection.token));
      if (!permission || Date.now() - connection.lastPong > 30000) {
        this.management.disconnect(hostId, !permission); connection.socket.terminate();
      } else connection.socket.ping();
    }
    this.management.expireDeliveries();
  }
  close(): void {
    clearInterval(this.timer);
    for (const query of this.queries.values()) { clearTimeout(query.timer); query.reject(new ManagementError({ code: "HOST_UNAVAILABLE", message: "Control Plane stopped.", retryable: true })); }
    this.queries.clear();
    for (const connection of this.connections.values()) connection.socket.terminate();
    this.connections.clear(); this.server.close();
  }
}
