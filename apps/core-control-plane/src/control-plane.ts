import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { ManagementError, fail, validateInput } from "@dewbow/core-protocol";
import { Store } from "@dewbow/core-protocol/store";
import { createEventStream } from "@dewbow/core-protocol/stream";
import type { ControlPlaneConfig } from "./config.js";
import { Gateway } from "./gateway.js";
import { json, jsonBody, sameSecret } from "./http.js";
import { Management } from "./management.js";
import type { Caller } from "./management.js";
import { mcp } from "./mcp.js";
import { subscribeSessionUpdates } from "./updates.js";

export class ControlPlane {
  private server: Server | undefined;
  private gateway: Gateway | undefined;
  private store: Store | undefined;
  constructor(readonly config: ControlPlaneConfig) {}
  async start(): Promise<void> {
    if (!this.config.managementToken || !this.config.operatorPassword || sameSecret(this.config.managementToken, this.config.operatorPassword)) throw new TypeError("Set separate DEWBOW_MANAGEMENT_TOKEN and DEWBOW_OPERATOR_PASSWORD credentials.");
    this.store = new Store(this.config.statePath, false);
    try {
      const management = new Management(this.store);
      this.gateway = new Gateway(this.config, management);
      const handler = (request: IncomingMessage, response: ServerResponse) => { void this.handle(request, response, management).catch(error => {
        const detail = error instanceof ManagementError ? error.detail : { code: "INTERNAL_ERROR", message: "Request failed.", retryable: false };
        json(response, detail.code === "UNAUTHORIZED" ? 401 : detail.code === "FORBIDDEN" ? 403 : detail.code === "NOT_FOUND" ? 404 : detail.code === "INTERNAL_ERROR" ? 500 : 400, { error: detail });
      }); };
      this.server = this.config.tlsCert && this.config.tlsKey ? createHttpsServer({ cert: readFileSync(this.config.tlsCert), key: readFileSync(this.config.tlsKey) }, handler) : createServer(handler);
      this.server.on("upgrade", (request, socket, head) => {
        if (request.url !== "/hosts/connect" || !this.originAllowed(request)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
        this.gateway!.upgrade(request, socket, head);
      });
      await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.config.port, this.config.host, resolve); });
    } catch (error) { await this.stop(); throw error; }
  }
  address(): ReturnType<Server["address"]> { return this.server?.address() ?? null; }
  private originAllowed(request: IncomingMessage): boolean {
    return request.headers.host === new URL(this.config.publicOrigin).host && (!request.headers.origin || request.headers.origin === this.config.publicOrigin);
  }
  private caller(request: IncomingMessage, management: Management): Caller {
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (sameSecret(token, this.config.managementToken)) return { id: "agent", operator: false };
    const cookie = request.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("dewbow_operator="))?.slice("dewbow_operator=".length);
    const record = cookie ? management.store.get<{ expires: number }>("operator", createHash("sha256").update(cookie).digest("hex")) : undefined;
    if (record && record.expires > Date.now()) return { id: "operator", operator: true };
    return fail("UNAUTHORIZED", "Authentication required.");
  }
  private async handle(request: IncomingMessage, response: ServerResponse, management: Management): Promise<void> {
    if (!this.originAllowed(request)) fail("FORBIDDEN", "Unrecognized host or origin.");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    const path = request.url?.split("?")[0] ?? "/";
    if (path === "/api/subscribeSessionUpdates" && request.method === "GET") {
      const caller = this.caller(request, management), params = new URL(request.url!, this.config.publicOrigin).searchParams;
      for (const key of params.keys()) if (!["sessionId", "cursor", "updateCursor", "contextCursor"].includes(key) || params.getAll(key).length !== 1) fail("INVALID_INPUT", "Invalid subscription parameters.");
      const sessionId = params.get("sessionId") ?? "";
      const position = { ...(params.has("cursor") ? { cursor: Number(params.get("cursor")) } : {}), ...(params.has("updateCursor") ? { updateCursor: params.get("updateCursor")! } : {}), ...(params.has("contextCursor") ? { contextCursor: Number(params.get("contextCursor")) } : {}) };
      validateInput("readSessionHistory", { sessionId, ...position });
      await management.call("getSession", { sessionId }, caller);
      if (response.destroyed) return;
      const stream = createEventStream(response, () => { this.caller(request, management); });
      try { await subscribeSessionUpdates(management, sessionId, position, caller, stream.send, stream.signal); }
      catch { stream.error(); }
      finally { stream.close(); }
      return;
    }
    if (path === "/health" && request.method === "GET") { json(response, 200, { status: "ok" }); return; }
    if (path === "/auth/login" && request.method === "POST") {
      const input = await jsonBody(request) as { password?: string };
      if (typeof input?.password !== "string" || !sameSecret(input.password, this.config.operatorPassword)) fail("UNAUTHORIZED", "Invalid operator credentials.");
      const token = randomBytes(32).toString("base64url");
      management.store.put("operator", createHash("sha256").update(token).digest("hex"), { expires: Date.now() + 12 * 3600000 });
      response.setHeader("Set-Cookie", `dewbow_operator=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.config.publicOrigin.startsWith("https:") ? "; Secure" : ""}`);
      json(response, 200, { result: { authenticated: true } }); return;
    }
    if (path === "/auth/logout" && request.method === "POST") {
      const caller = this.caller(request, management);
      if (!caller.operator) fail("FORBIDDEN", "Operator authentication required.");
      const cookie = request.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("dewbow_operator="))?.slice("dewbow_operator=".length);
      if (cookie) management.store.remove("operator", createHash("sha256").update(cookie).digest("hex"));
      response.setHeader("Set-Cookie", "dewbow_operator=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      json(response, 200, { result: { authenticated: false } }); return;
    }
    if (path.startsWith("/api/") || path === "/mcp") {
      const caller = this.caller(request, management);
      if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }); response.end(); return; }
      this.gateway!.permissions();
      const body = await jsonBody(request);
      if (path === "/mcp") {
        const value = await mcp(body, management, { ...caller, operator: false });
        if (value === null) { response.writeHead(202); response.end(); } else json(response, 200, value);
      } else json(response, 200, { result: await management.call(path.slice(5), body, caller) });
      return;
    }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    const root = resolve(this.config.webRoot), file = resolve(root, path === "/" ? "index.html" : `.${decodeURIComponent(path)}`);
    if (!file.startsWith(root + sep)) fail("NOT_FOUND", "File not found.");
    let data: Buffer;
    try { data = await readFile(file); } catch { fail("NOT_FOUND", "Web build not found. Build @dewbow/core-web first."); }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" }); response.end(data);
  }
  async stop(): Promise<void> {
    this.gateway?.close(); this.gateway = undefined;
    if (this.server?.listening) {
      const server = this.server;
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
    this.server = undefined; this.store?.close(); this.store = undefined;
  }
}
