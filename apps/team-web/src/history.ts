import type { CoreHistory, NativeMessage, SessionActivity } from "@dewbow/team-protocol";

export interface HistoryState {
  saved: Record<string, NativeMessage>;
  live: Record<string, NativeMessage>;
  eventCursor: number;
  updateCursor: string | undefined;
  beforeCursor: string | null;
  activities: Record<string,SessionActivity>;
}

export const emptyHistory = (): HistoryState => ({ saved:Object.create(null) as Record<string,NativeMessage>,live:Object.create(null) as Record<string,NativeMessage>,eventCursor:0,updateCursor:undefined,beforeCursor:null,activities:Object.create(null) as Record<string,SessionActivity> });

export function mergeHistory(state: HistoryState, page: CoreHistory, direction: "initial" | "older" | "newer" = "initial"): HistoryState {
  const saved = Object.assign(Object.create(null) as Record<string, NativeMessage>, state.saved);
  if (!page.historyError) for (const item of page.messages) {
    const previous = saved[item.id], final = (value: NativeMessage) => value.itemComplete === true || ["completed","interrupted","failed"].includes(value.turnStatus ?? "");
    if (previous?.updatedOrdinal !== undefined && item.updatedOrdinal !== undefined && previous.updatedOrdinal > item.updatedOrdinal) continue;
    if (!previous || !final(previous) || final(item)) saved[item.id] = item;
  }
  const activities = Object.assign(Object.create(null) as Record<string,SessionActivity>,state.activities);
  if (!page.historyError) for (const activity of page.activities) {
    const previous = activities[activity.id];
    if (previous?.itemComplete && !activity.itemComplete) continue;
    if (previous?.updatedOrdinal != null && activity.updatedOrdinal != null && previous.updatedOrdinal > activity.updatedOrdinal) continue;
    activities[activity.id] = activity;
  }
  const live = page.eventsError || page.nextCursor < state.eventCursor ? state.live : Object.fromEntries(page.liveMessages.map(item => [item.id, item]));
  return {
    saved, live, eventCursor: page.eventsError ? state.eventCursor : Math.max(state.eventCursor,page.nextCursor),
    activities,updateCursor:page.historyError || direction === "older" ? state.updateCursor : page.updateCursor ?? state.updateCursor,
    beforeCursor:page.historyError || direction === "newer" ? state.beforeCursor : page.beforeCursor,
  };
}

export function visibleMessages(state: HistoryState): NativeMessage[] {
  const messages = Object.assign(Object.create(null) as Record<string, NativeMessage>, state.saved);
  for (const [id, item] of Object.entries(state.live)) {
    const saved = state.saved[id];
    if (!saved || (!["completed","interrupted","failed"].includes(saved.turnStatus ?? "") && saved.itemComplete !== true)) messages[id] = item;
  }
  return Object.values(messages).sort((a,b)=>a.ordinal !== undefined && b.ordinal !== undefined ? a.ordinal-b.ordinal : a.createdAt.localeCompare(b.createdAt));
}
