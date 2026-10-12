export { CodexRuntime, CodexRuntimeError } from "./runtime.js";
export type { RpcMessage, ConnectSessionOptions, ConnectedSession } from "./runtime.js";
export { discoverSessions } from "./discovery.js";
export { readSessionHistory, SessionHistoryError } from "./history.js";
export { readSessionItems, readSessionItem } from "./items.js";
export { readSessionToolOrigin } from "./tool-origin.js";
export type { ReadSessionItemsOptions, SessionItemRecord, SessionItemsPage } from "./items.js";
export type { DiscoverOptions, DiscoverySnapshot, CodexSession, CodexProcess, RuntimeReport,
  RuntimeSessionReport, RuntimeStatus, SessionKind, SourceName, SourceReport, SourceState,
  ReadSessionHistoryOptions, SessionHistoryPage, SessionMessage, SessionMessageContent, SessionHistoryErrorCode } from "./types.js";

import type { CodexSession, DiscoverySnapshot } from "./types.js";

/** Relationships resolve within the same Codex home; duplicate UUIDs across homes remain distinct. */
export function getParentSession(snapshot: DiscoverySnapshot, session: CodexSession): CodexSession | null {
  return snapshot.sessions.find(row => row.id === session.parentId && row.codexHome === session.codexHome) ?? null;
}
export function getForkSourceSession(snapshot: DiscoverySnapshot, session: CodexSession): CodexSession | null {
  return snapshot.sessions.find(row => row.id === session.forkedFromId && row.codexHome === session.codexHome) ?? null;
}
