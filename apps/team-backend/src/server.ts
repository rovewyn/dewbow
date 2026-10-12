import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { contractVersion, fail, TeamError } from "@dewbow/team-protocol";
import type { Config } from "./config.js";

export type Handler = (operation: string, input: unknown, caller: string) => Promise<unknown> | unknown;

function sameSecret(a: string, b: string): boolean {
  return Boolean(a && b) && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) fail("INVALID_INPUT", "Request body exceeds 1 MiB.");
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("INVALID_INPUT", "Request body must be JSON."); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export function createTeamServer(config: Config, handle: Handler = () => fail("NOT_FOUND", "Unknown operation.")) {
  const sessions = new Map<string, number>();
  const cookieName = "dewbowTeamOperator";
  const cookie = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.publicOrigin.startsWith("https:") ? "; Secure" : ""}`;
  const authenticate = (request: IncomingMessage): boolean => {
    if (sameSecret(request.headers.authorization?.replace(/^Bearer /, "") ?? "", config.operatorToken)) return true;
    const value = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return Boolean(value && (sessions.get(value) ?? 0) > Date.now());
  };
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const pathname = new URL(request.url ?? "/", config.publicOrigin).pathname;
      if (pathname === "/health" && request.method === "GET") {
        json(response, 200, { result: { service: "dewbow-team", contractVersion } });
        return;
      }
      if (pathname === "/auth/session" && request.method === "GET") {
        json(response, 200, { result: { authenticated: authenticate(request) } });
        return;
      }
      if ((pathname.startsWith("/auth/") || pathname.startsWith("/api/")) && request.method === "POST") {
        if (request.headers.origin && request.headers.origin !== config.publicOrigin) fail("FORBIDDEN", "Origin is not permitted.");
        if (!request.headers.authorization && request.headers.origin !== config.publicOrigin) fail("FORBIDDEN", "A same-origin request is required.");
        if (pathname === "/auth/login") {
          const input = await body(request) as { token?: unknown };
          if (!input || typeof input.token !== "string" || !sameSecret(input.token, config.operatorToken)) fail("UNAUTHORIZED", "Invalid operator token.");
          for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
          const session = randomBytes(32).toString("hex");
          sessions.set(session, Date.now() + 24 * 60 * 60 * 1000);
          response.setHeader("Set-Cookie", cookie(session, 86400));
          json(response, 200, { result: { authenticated: true } });
          return;
        }
        if (!authenticate(request)) fail("UNAUTHORIZED", "Authentication is required.");
        if (pathname === "/auth/logout") {
          const value = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
          if (value) sessions.delete(value);
          response.setHeader("Set-Cookie", cookie("", 0));
          json(response, 200, { result: {} });
          return;
        }
        if (pathname.startsWith("/api/")) {
          json(response, 200, { result: await handle(pathname.slice(5), await body(request), "operator") });
          return;
        }
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
        json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use the documented method.", retryable: false } });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") fail("NOT_FOUND", "Not found.");
      const decoded = decodeURIComponent(pathname);
      const target = resolve(config.webDir, `.${decoded}`);
      if (target !== config.webDir && !target.startsWith(`${config.webDir}${sep}`)) fail("NOT_FOUND", "Not found.");
      let contents: Buffer;
      let extension = extname(target);
      try { contents = await readFile(target); }
      catch {
        if (extension) fail("NOT_FOUND", "Asset not found.");
        contents = await readFile(resolve(config.webDir, "index.html"));
        extension = ".html";
      }
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
      response.writeHead(200, { "Content-Type": types[extension] ?? "application/octet-stream", "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600" });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch (error) {
      const detail = error instanceof TeamError ? error.detail : { code: "INTERNAL_ERROR", message: "The request could not be completed.", retryable: false };
      const status = detail.code === "UNAUTHORIZED" ? 401 : detail.code === "FORBIDDEN" ? 403 : detail.code === "NOT_FOUND" ? 404 : detail.code === "INTERNAL_ERROR" ? 500 : 400;
      json(response, status, { error: detail });
    }
  });
}
