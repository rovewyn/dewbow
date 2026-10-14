import { validateInput, type HistoryPosition, type SessionDetails, type SessionHistory, type SessionUpdates } from "@dewbow/core-protocol";
import { observeChanges } from "@dewbow/core-protocol/stream";
import type { Caller, Management } from "./management.js";

export async function subscribeSessionUpdates(management: Management, sessionId: string, position: HistoryPosition, caller: Caller,
  emit: (event: "snapshot" | "update", value: SessionUpdates) => void, signal: AbortSignal): Promise<void> {
  let cursor = position.cursor ?? 0, updateCursor = position.updateCursor, contextCursor = position.contextCursor;
  let observedHostId: string | undefined;
  const subscribe = (notify: () => void) => management.store.changes.subscribe(topic => {
    const hostId = observedHostId ?? management.store.get<{ hostId: string }>("session", sessionId)?.hostId;
    if (topic === `session:${sessionId}` || topic === `host:${hostId}`) notify();
  });
  await observeChanges(subscribe, async initial => {
    const details = await management.call("getSession", { sessionId }, caller) as SessionDetails;
    observedHostId = details.session.hostId;
    let first = initial;
    do {
      const input = validateInput("readSessionHistory", { sessionId, cursor, limit: 50, ...(updateCursor ? { updateCursor } : {}), ...(contextCursor !== undefined ? { contextCursor } : {}) });
      const history = await management.call("readSessionHistory", input, caller) as SessionHistory;
      if (signal.aborted) return;
      emit(first ? "snapshot" : "update", management.protectUpdates({ contractVersion: "v1", details, history }, caller));
      first = false;
      if (!history.eventsError) cursor = Math.max(cursor, history.nextCursor);
      if (!history.historyError) { updateCursor = history.updateCursor ?? updateCursor; contextCursor = history.contextCursor ?? contextCursor; }
      if (history.historyError || history.eventsError || !history.hasMore && !history.hasMoreUpdates && !history.hasMoreContexts) break;
    } while (!signal.aborted);
  }, signal);
}
