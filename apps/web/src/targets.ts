import type { SessionSummary } from "@dewbow/protocol";

export interface RemoteTarget { networkId: string; hostId: string; membershipId: string }
export interface SessionEntry extends SessionSummary { target?: RemoteTarget }
export interface Selection { sessionId: string; target?: RemoteTarget }
export const selectionKey = (value: Selection) => value.target
  ? JSON.stringify([value.target.networkId, value.target.hostId, value.target.membershipId, value.sessionId]) : value.sessionId;
export const sessionKey = (value: SessionEntry) => selectionKey(value);
export function parseSelection(key: string): Selection {
  if (key.startsWith("[")) {
    try {
      const fields: unknown = JSON.parse(key);
      if (Array.isArray(fields) && fields.length === 4 && fields.every(field => typeof field === "string" && field.length)) {
        return { sessionId: fields[3], target: { networkId: fields[0], hostId: fields[1], membershipId: fields[2] } };
      }
    } catch { /* Opaque local IDs remain valid. */ }
  }
  return { sessionId: key };
}
export function selectionFragment(key: string) {
  const { sessionId, target } = parseSelection(key);
  return new URLSearchParams({ session: sessionId, ...(target ? { network: target.networkId, host: target.hostId, member: target.membershipId } : {}) }).toString();
}
export function readSelection(fragment: string) {
  const fields = new URLSearchParams(fragment);
  const sessionId = fields.get("session") ?? "";
  if (["network", "host", "member"].some(key => fields.has(key))) {
    return selectionKey({ sessionId, target: { networkId: fields.get("network") ?? "invalid", hostId: fields.get("host") ?? "invalid", membershipId: fields.get("member") ?? "invalid" } });
  }
  return sessionId;
}
export function selectionInput(key: string): Record<string, string> {
  const { sessionId, target } = parseSelection(key);
  return { sessionId, ...(target ? { networkId: target.networkId, hostId: target.hostId } : {}) };
}
