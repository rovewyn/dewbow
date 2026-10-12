import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fail } from "@dewbow-core/protocol";

export function sameSecret(a: string, b: string): boolean {
  return Boolean(a && b) && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
export async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) fail("INVALID_INPUT", "Request body exceeds 1 MiB.");
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("INVALID_INPUT", "Request body must be JSON."); }
}
export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
}
