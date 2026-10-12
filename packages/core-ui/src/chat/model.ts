import type { Event, Interaction, NativeMessage, SessionActivity, Turn } from "@dewbow/core-protocol";
import { maskPrivateActivity, maskPrivateEvents, maskPrivateMessages } from "@dewbow/core-protocol";
import type { ChatEntry, ChatMessage, ChatModel, ChatOrder, ChatRequest, ChatTurn } from "./types.js";
export type * from "./types.js";

export const isMessageComplete = (message: NativeMessage): boolean => message.itemComplete === true || ["completed", "interrupted", "failed"].includes(message.turnStatus ?? "");

/** Source versions and completion protect final text; text length is never a version. */
export function mergeNativeMessages(previous: NativeMessage[], incoming: NativeMessage[]): NativeMessage[] {
  const saved = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) {
    const existing = saved.get(message.id);
    if (message.availability === "restricted") { saved.set(message.id, message); continue; }
    if (existing?.availability === "restricted") continue;
    if (existing?.updatedOrdinal !== undefined && message.updatedOrdinal !== undefined && existing.updatedOrdinal > message.updatedOrdinal) continue;
    if (!existing || !isMessageComplete(existing) || isMessageComplete(message)) saved.set(message.id, message);
  }
  return stableSourceOrder([...saved.values()]);
}

export function mergeActivities(previous: SessionActivity[], incoming: SessionActivity[]): SessionActivity[] {
  const saved = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) {
    const existing = saved.get(item.id);
    if (existing?.availability === "restricted" || item.availability === "restricted") {
      const base = existing && (existing.itemComplete && !item.itemComplete || existing.updatedOrdinal != null && (item.updatedOrdinal == null || existing.updatedOrdinal > item.updatedOrdinal)) ? existing : item;
      saved.set(item.id, maskPrivateActivity({ ...base, ordinal: base.ordinal ?? existing?.ordinal ?? null, updatedOrdinal: base.updatedOrdinal ?? existing?.updatedOrdinal ?? null }));
      continue;
    }
    if (existing?.itemComplete && !item.itemComplete) continue;
    if (existing?.itemComplete && existing.updatedOrdinal != null && item.updatedOrdinal == null) continue;
    if (existing?.updatedOrdinal != null && item.updatedOrdinal != null && existing.updatedOrdinal > item.updatedOrdinal) continue;
    const protectedIds = new Set(existing?.contents.filter(ref => ref.authority === "operator").map(ref => ref.contentId));
    saved.set(item.id, { ...item, ordinal: item.ordinal ?? existing?.ordinal ?? null, updatedOrdinal: item.updatedOrdinal ?? existing?.updatedOrdinal ?? null,
      contents: item.contents.map(ref => protectedIds.has(ref.contentId) ? { ...ref, authority: "operator" } : ref) });
  }
  return stableSourceOrder([...saved.values()]);
}

/** Missing source positions retain their input slots instead of inventing timestamp order. */
function stableSourceOrder<T extends { ordinal?: number | null; id: string }>(items: T[]): T[] {
  const ordered = items.filter(item => item.ordinal != null).sort((a, b) => a.ordinal! - b.ordinal! || compareNativeIds(a.id, b.id));
  let index = 0;
  return items.map(item => item.ordinal != null ? ordered[index++]! : item);
}

/** Match the native SQLite BINARY cursor tie order in browsers as well as Node. */
function compareNativeIds(left: string, right: string): number {
  const encoder = new TextEncoder(), a = encoder.encode(left), b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

export function visibleMessages(saved: NativeMessage[], live: NativeMessage[]): NativeMessage[] {
  const finalIds = new Set(saved.filter(isMessageComplete).map(item => item.id));
  return mergeNativeMessages(saved, live.filter(item => !finalIds.has(item.id) || item.availability === "restricted"));
}

export interface ChatHistoryState {
  saved: Record<string, NativeMessage>; live: Record<string, NativeMessage>; activities: Record<string, SessionActivity>;
  events: Event[]; eventCursor: number; updateCursor: string | undefined; beforeCursor: string | null; restricted: boolean;
}
export interface ChatHistoryPage {
  messages: NativeMessage[]; liveMessages: NativeMessage[]; activities: SessionActivity[]; events: Event[];
  nextCursor: number; updateCursor: string | null; beforeCursor: string | null;
  historyError?: unknown; eventsError?: unknown;
}
export const emptyHistory = (): ChatHistoryState => ({ saved: Object.create(null), live: Object.create(null), activities: Object.create(null), events: [], eventCursor: 0, updateCursor: undefined, beforeCursor: null, restricted: false });
/** An agent host applies this once when Core reports operator-only context. */
export function restrictHistory(state: ChatHistoryState): ChatHistoryState {
  const protect = (rows: Record<string, NativeMessage>) => Object.assign(Object.create(null), Object.fromEntries(Object.values(rows).map(item => [item.id, { ...item, text: "", availability: "restricted" as const }])));
  return { ...state, restricted: true, saved: protect(state.saved), live: protect(state.live),
    activities: Object.assign(Object.create(null), Object.fromEntries(Object.values(state.activities).map(item => [item.id, maskPrivateActivity(item)]))),
    events: maskPrivateEvents(state.events, new Set(state.events.flatMap(event => [event.turnId ?? "", (event.payload.turn as Turn | undefined)?.codexTurnId ?? ""]))),
  };
}
export function mergeHistory(state: ChatHistoryState, page: ChatHistoryPage, direction: "initial" | "older" | "newer" = "initial"): ChatHistoryState {
  const record = <T extends { id: string }>(items: T[]): Record<string, T> => Object.assign(Object.create(null), Object.fromEntries(items.map(item => [item.id, item])));
  const events = new Map(state.events.map(event => [event.eventId, event]));
  if (!page.eventsError) for (const event of page.events) events.set(event.eventId, event);
  const merged: ChatHistoryState = {
    saved: page.historyError ? state.saved : record(mergeNativeMessages(Object.values(state.saved), page.messages)),
    activities: page.historyError ? state.activities : record(mergeActivities(Object.values(state.activities), page.activities)),
    live: page.eventsError || page.nextCursor < state.eventCursor ? state.live : record(page.liveMessages),
    events: [...events.values()].sort((a, b) => a.cursor - b.cursor),
    eventCursor: page.eventsError ? state.eventCursor : Math.max(state.eventCursor, page.nextCursor),
    updateCursor: page.historyError || direction === "older" ? state.updateCursor : page.updateCursor ?? state.updateCursor,
    beforeCursor: page.historyError || direction === "newer" ? state.beforeCursor : page.beforeCursor,
    restricted: state.restricted,
  };
  return state.restricted ? restrictHistory(merged) : merged;
}

/** Replay supplements loaded native turns and the active turn, never unloaded historical fragments. */
export function projectHistoryWindow(history: ChatHistoryState, turns: Turn[], activeTurnId: string | null) {
  const messages = Object.values(history.saved), liveMessages = Object.values(history.live), activities = Object.values(history.activities);
  const loaded = new Set([...messages, ...liveMessages, ...activities].map(item => item.turnId));
  const visible = new Set(turns.filter(turn => turn.codexTurnId && loaded.has(turn.codexTurnId) || turn.turnId === activeTurnId).map(turn => turn.turnId));
  for (const event of history.events) {
    const observed = event.payload.turn as Turn | undefined;
    const turn = turns.find(turn => turn.turnId === event.turnId);
    if (turn && observed?.turnId === turn.turnId && observed.sessionId === turn.sessionId && event.sessionId === turn.sessionId && observed.codexTurnId && loaded.has(observed.codexTurnId) && (!turn.codexTurnId || turn.codexTurnId === observed.codexTurnId)) visible.add(turn.turnId);
  }
  return { messages, liveMessages, activities, events: history.events.filter(event => event.type === "history_gap" || event.turnId && visible.has(event.turnId)) };
}

export interface BuildChatModelInput {
  sessionKey: string; turns: Turn[]; messages: NativeMessage[]; liveMessages?: NativeMessage[];
  activities?: SessionActivity[]; events?: Event[]; interactions: Interaction[]; requests?: ChatRequest[];
  restricted?: boolean;
}
const unavailableOrder = (): ChatOrder => ({ source: "unavailable", value: null });
const active = (item: Interaction) => ["pending", "requested", "delivered"].includes(item.status);

/** Associate only exact native/management IDs, never matching text or wall clocks. */
export function buildChatModel(input: BuildChatModelInput): ChatModel {
  if (input.restricted) {
    const events = input.events ?? [], messages = [...input.messages, ...(input.liveMessages ?? [])];
    input = { ...input, messages: maskPrivateMessages(input.messages, new Set(messages.map(item => item.turnId))),
      liveMessages: maskPrivateMessages(input.liveMessages ?? [], new Set(messages.map(item => item.turnId))),
      activities: (input.activities ?? []).map(maskPrivateActivity),
      events: maskPrivateEvents(events, new Set(events.flatMap(event => [event.turnId ?? "", (event.payload.turn as Turn | undefined)?.codexTurnId ?? ""]))),
      interactions: input.interactions.map(item => { const { details: _details, ...metadata } = item; return metadata; }),
    };
  }
  const groups = new Map<string, ChatTurn>(), core = new Map<string, ChatTurn>(), native = new Map<string, ChatTurn>();
  const notices: string[] = [];
  const coreSources = new Map(input.turns.map(turn => [turn.turnId, turn]));
  const create = (key: string, turnId: string | null, nativeTurnId: string | null): ChatTurn => {
    const group: ChatTurn = { key, turnId, nativeTurnId, state: null, mode: null, messages: [], progress: [], activities: [], activityOrders: new Map(), interactions: [], entries: [], order: unavailableOrder(), orderIncomplete: false };
    groups.set(key, group); return group;
  };
  const candidates = new Map(input.turns.map(turn => [turn.turnId, new Set(turn.codexTurnId ? [turn.codexTurnId] : [])]));
  for (const event of input.events ?? []) {
    const source = coreSources.get(event.turnId ?? ""), observed = event.payload.turn as Turn | undefined;
    if (source && observed?.turnId === source.turnId && observed.sessionId === source.sessionId && event.sessionId === source.sessionId && observed.codexTurnId) candidates.get(source.turnId)!.add(observed.codexTurnId);
  }
  const bindings = new Map([...candidates].map(([id, values]) => [id, values.size === 1 ? [...values][0]! : null]));
  const counts = new Map<string, number>();
  for (const values of candidates.values()) for (const id of values) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const turn of input.turns) {
    const binding = bindings.get(turn.turnId);
    const group = create(`core:${turn.turnId}`, turn.turnId, binding && counts.get(binding) === 1 ? binding : null);
    group.state = turn.state; group.mode = turn.mode; core.set(turn.turnId, group);
    if (group.nativeTurnId) native.set(group.nativeTurnId, group);
  }
  if ([...counts.values()].some(count => count > 1) || [...candidates.values()].some(values => values.size > 1)) notices.push("A native turn has ambiguous management associations. Its content is shown separately.");
  const byNative = (id: string) => {
    if (!id) return groups.get("unassociated") ?? create("unassociated", null, null);
    let group = native.get(id);
    if (!group) { group = create(`native:${id}`, null, id); native.set(id, group); }
    return group;
  };
  const eventMatches = (event: Event, group: ChatTurn): boolean => {
    const payloadTurn = event.payload.turn as Turn | undefined;
    const exactCore = group.turnId !== null && event.turnId === group.turnId;
    const exactNative = group.nativeTurnId !== null && payloadTurn?.codexTurnId === group.nativeTurnId;
    return (exactCore || group.turnId === null && exactNative) && (!payloadTurn?.turnId || event.turnId === payloadTurn.turnId)
      && (!group.turnId || coreSources.get(group.turnId)?.sessionId === event.sessionId)
      && (!payloadTurn || payloadTurn.sessionId === event.sessionId)
      && (group.nativeTurnId === null || (counts.get(group.nativeTurnId) ?? 0) <= 1)
      && (!payloadTurn?.codexTurnId || !group.nativeTurnId || payloadTurn.codexTurnId === group.nativeTurnId);
  };
  const messages = visibleMessages(input.messages, input.liveMessages ?? []);
  const matchedUserEvents = new Set<string>();
  const eventPositions = new Map<string, number>();
  for (const item of messages) {
    const group = byNative(item.turnId);
    const matching = (input.events ?? []).filter(event => eventMatches(event, group) && (item.role === "user" ? event.type === "user_message" && item.clientId != null && event.payload.clientId === item.clientId : event.payload.itemId === item.id && ["assistant_message", "assistant_delta"].includes(event.type)));
    const uniqueUser = matching.length === 1 && messages.filter(message => message.turnId === item.turnId && message.clientId === item.clientId).length === 1;
    const event = item.role === "user" ? uniqueUser ? matching[0] : undefined : item.phase === "final_answer" ? matching.findLast(event => event.payload.stage === "completed") ?? matching[0] : matching[0];
    if (item.role === "user" && event) matchedUserEvents.add(event.eventId);
    if (event) eventPositions.set(`message:${item.id}`, event.cursor);
    const order: ChatOrder = item.ordinal !== undefined ? { source: "native", value: item.ordinal } : event ? { source: "event", value: event.cursor } : unavailableOrder();
    const message: ChatMessage = { id: item.id, kind: item.role === "user" ? event?.payload.steering === true ? "instruction" : "user" : item.phase === "final_answer" ? "final" : "progress", text: item.text, createdAt: item.createdAt, complete: isMessageComplete(item), restricted: item.availability === "restricted", order };
    group.messages.push(message); if (group.state === null) group.state = item.turnStatus;
  }
  for (const item of mergeActivities([], input.activities ?? [])) {
    const group = byNative(item.turnId); group.activities.push(item);
    (group.activityOrders as Map<string, ChatOrder>).set(item.id, item.ordinal === null ? unavailableOrder() : { source: "native", value: item.ordinal });
  }
  for (const event of input.events ?? []) {
    const payloadTurn = event.payload.turn as Turn | undefined;
    const group = core.get(event.turnId ?? "") ?? (payloadTurn?.codexTurnId ? byNative(payloadTurn.codexTurnId) : groups.get("unassociated") ?? create("unassociated", null, null));
    const order: ChatOrder = { source: "event", value: event.cursor };
    if (event.type === "user_message" && typeof event.payload.text === "string" && !matchedUserEvents.has(event.eventId)) {
      group.messages.push({ id: event.eventId, kind: event.payload.steering ? "instruction" : "user", text: event.payload.text, createdAt: event.timestamp, complete: true, restricted: false, order });
    }
    if (event.type === "progress") {
      const steps = Array.isArray(event.payload.plan) ? event.payload.plan.map((step: { step?: string; status?: string }) => [step.status, step.step].filter(Boolean).join(": ")).join("\n") : "";
      const text = [typeof event.payload.explanation === "string" ? event.payload.explanation : "", steps].filter(Boolean).join("\n");
      if (text) group.progress.push({ id: event.eventId, text, order });
    }
    if (event.type === "tool_activity" && event.payload.activity) {
      const item = event.payload.activity as SessionActivity;
      const activityGroup = byNative(item.turnId);
      activityGroup.activities = mergeActivities(activityGroup.activities, [item]);
      const current = activityGroup.activities.find(value => value.id === item.id)!;
      const priorOrder = activityGroup.activityOrders.get(item.id);
      const eventOrder: ChatOrder = { source: "event", value: Math.min(event.cursor, priorOrder?.source === "event" ? priorOrder.value! : event.cursor) };
      (activityGroup.activityOrders as Map<string, ChatOrder>).set(item.id, current.ordinal === null ? eventOrder : { source: "native", value: current.ordinal });
      const activityKey = `activity:${item.id}`;
      eventPositions.set(activityKey, Math.min(event.cursor, eventPositions.get(activityKey) ?? event.cursor));
    }
    if (event.type === "history_gap") notices.push(`Unavailable events ${event.payload.fromCursor}–${event.payload.toCursor}.`);
  }
  for (const item of input.interactions) {
    const group = core.get(item.turnId) ?? groups.get(`unbound:${item.turnId}`) ?? create(`unbound:${item.turnId}`, item.turnId, null);
    group.interactions.push(item);
  }
  for (const group of groups.values()) {
    // Native ordinals are already completion positions for final answers.
    const nativeMessages = group.messages.filter(item => item.order.source === "native").sort((a, b) => a.order.value! - b.order.value!);
    const observed = group.messages.filter(item => item.order.source !== "native").sort((a, b) => (a.order.value ?? Infinity) - (b.order.value ?? Infinity));
    group.messages = [...nativeMessages];
    for (const item of observed) {
      const next = group.messages.findIndex(message => eventPositions.has(`message:${message.id}`) && eventPositions.get(`message:${message.id}`)! > (item.order.value ?? Infinity));
      const previous = group.messages.findLastIndex(message => eventPositions.has(`message:${message.id}`) && eventPositions.get(`message:${message.id}`)! <= (item.order.value ?? -Infinity));
      const finalIndex = group.messages.findIndex(message => message.kind === "final");
      const slot = next >= 0 ? next : previous >= 0 ? previous + 1 : finalIndex >= 0 ? finalIndex : group.messages.length;
      group.messages.splice(slot, 0, item);
      if (item.order.value !== null) eventPositions.set(`message:${item.id}`, item.order.value);
    }
    let users = 0;
    for (const message of group.messages) if (message.kind === "user" && users++ > 0) message.kind = "instruction";
    const ordinals = [...nativeMessages.map(item => item.order.value!), ...group.activities.flatMap(item => item.ordinal === null ? [] : [item.ordinal])];
    const cursors = [...observed.flatMap(item => item.order.value === null ? [] : [item.order.value]), ...group.progress.map(item => item.order.value!), ...[...group.activityOrders.values()].flatMap(order => order.source === "event" ? [order.value!] : [])];
    group.order = ordinals.length ? { source: "native", value: Math.min(...ordinals) } : cursors.length ? { source: "event", value: Math.min(...cursors) } : unavailableOrder();
    group.orderIncomplete = group.messages.some(item => item.order.source !== "native") || group.activities.some(item => item.ordinal === null) || group.progress.length > 0;
    const entries: { entry: ChatEntry; order: ChatOrder; cursor: number | null }[] = group.messages.map(message => ({ entry: { kind: "message", id: `message:${message.id}`, message }, order: message.order, cursor: eventPositions.get(`message:${message.id}`) ?? null }));
    for (const activity of group.activities) entries.push({ entry: { kind: "activity", id: `activity:${activity.id}`, activity }, order: group.activityOrders.get(activity.id) ?? unavailableOrder(), cursor: eventPositions.get(`activity:${activity.id}`) ?? null });
    const progress = group.progress.at(-1);
    if (progress) entries.push({ entry: { kind: "progress", id: `progress:${progress.id}`, progress }, order: progress.order, cursor: progress.order.value });
    for (const interaction of group.interactions.filter(active)) {
      const event = input.events?.find(event => event.turnId === interaction.turnId && event.sessionId === interaction.sessionId && (event.payload.interaction as Interaction | undefined)?.interactionId === interaction.interactionId);
      entries.push({ entry: { kind: "interaction", id: `interaction:${interaction.interactionId}`, interaction }, order: event ? { source: "event", value: event.cursor } : unavailableOrder(), cursor: event?.cursor ?? null });
    }
    const ordered = entries.filter(item => item.order.source === "native").sort((a, b) => a.order.value! - b.order.value! || compareNativeIds(a.entry.id.split(":").slice(1).join(":"), b.entry.id.split(":").slice(1).join(":")));
    for (const item of entries.filter(item => item.order.source !== "native").sort((a, b) => (a.order.value ?? Infinity) - (b.order.value ?? Infinity))) {
      const next = item.cursor === null ? -1 : ordered.findIndex(value => value.cursor !== null && value.cursor > item.cursor!);
      const previous = item.cursor === null ? -1 : ordered.findLastIndex(value => value.cursor !== null && value.cursor <= item.cursor!);
      const final = ordered.findIndex(value => value.entry.kind === "message" && value.entry.message.kind === "final");
      ordered.splice(next >= 0 ? next : previous >= 0 ? previous + 1 : final >= 0 ? final : ordered.length, 0, item);
    }
    group.entries = ordered.map(item => item.entry);
  }
  const visible = [...groups.values()].filter(group => group.messages.length || group.activities.length || group.progress.length || group.interactions.length || group.state && !["completed", "interrupted", "error"].includes(group.state));
  // Compare positions only within the same source; mixed sources retain stable slots.
  for (const source of ["native", "event"] as const) {
    const ordered = visible.filter(group => group.order.source === source).sort((a, b) => a.order.value! - b.order.value!);
    let index = 0; for (let slot = 0; slot < visible.length; slot++) if (visible[slot]!.order.source === source) visible[slot] = ordered[index++]!;
  }
  for (const group of visible) group.interactions.sort((a, b) => Number(active(b)) - Number(active(a)));
  return { sessionKey: input.sessionKey, turns: visible, requests: input.requests ?? [], notices: [...new Set(notices)] };
}
