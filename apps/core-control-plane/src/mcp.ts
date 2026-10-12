import { ManagementError, tools } from "@dewbow/core-protocol";
import type { Caller, Management } from "./management.js";

export async function mcp(message: unknown, management: Management, caller: Caller): Promise<unknown> {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
  const rpc = message as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };
  const error = (code: number, text: string) => ({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message: text } });
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return error(-32600, "Invalid request.");
  if (rpc.id === undefined) return null;
  let result: unknown;
  switch (rpc.method) {
    case "initialize": result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "dewbow-core", version: "0.1.0" } }; break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools }; break;
    case "tools/call": {
      const name = rpc.params?.name;
      if (typeof name !== "string" || !tools.some(t => t.name === name)) return error(-32602, "Unknown tool.");
      try {
        const value = await management.call(name, rpc.params?.arguments ?? {}, caller);
        result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      } catch (cause) {
        if (!(cause instanceof ManagementError)) throw cause;
        result = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: cause.detail }) }] };
      }
      break;
    }
    default: return error(-32601, "Method not found.");
  }
  return { jsonrpc: "2.0", id: rpc.id, result };
}
