import type { CoreHistory, NativeMessage } from "@dewbow-team/protocol";

export interface HistoryState {
  saved: Record<string, NativeMessage>;
  live: Record<string, NativeMessage>;
  eventCursor: number;
  messageCursor: string | undefined;
}

export const emptyHistory = (): HistoryState => ({ saved: Object.create(null) as Record<string, NativeMessage>, live: Object.create(null) as Record<string, NativeMessage>, eventCursor: 0, messageCursor: undefined });

export function mergeHistory(state: HistoryState, page: CoreHistory, requestedMessageCursor: string | undefined): HistoryState {
  const saved = Object.assign(Object.create(null) as Record<string, NativeMessage>, state.saved);
  if (!page.historyError) for (const item of page.messages) saved[item.id] = item;
  const live = page.eventsError ? state.live : Object.fromEntries(page.liveMessages.map(item => [item.id, item]));
  return {
    saved, live, eventCursor: page.eventsError ? state.eventCursor : page.nextCursor,
    messageCursor: page.historyError ? state.messageCursor : page.nextMessageCursor ?? requestedMessageCursor,
  };
}

export function visibleMessages(state: HistoryState): NativeMessage[] {
  const messages = Object.assign(Object.create(null) as Record<string, NativeMessage>, state.saved);
  for (const [id, item] of Object.entries(state.live)) {
    const saved = state.saved[id];
    if (!saved || (!["completed", "interrupted", "failed"].includes(saved.turnStatus ?? "") && saved.phase !== "final_answer")) messages[id] = item;
  }
  return Object.values(messages).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
