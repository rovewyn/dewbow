import { setTimeout as delay } from "node:timers/promises";
import type { HistoryPosition, SessionUpdates } from "@dewbow/core-protocol";
import { maskPrivateActivity, maskPrivateEvents, maskPrivateMessages } from "@dewbow/core-protocol";
import { observeChanges } from "@dewbow/core-protocol/stream";
import { contractVersion, fail, type BindingUpdates, type ChannelConversationDetails, type ChannelConversationUpdates } from "@dewbow/team-protocol";
import type { CoreApi } from "./core-client.js";
import type { SessionService } from "./session-service.js";
import type { TeamStore } from "./store.js";
import type { ChannelRuntime } from "./channels/runtime.js";

export async function subscribeTeamUpdates(store: TeamStore, sessions: SessionService, channels: ChannelRuntime, core: CoreApi,
  input: { bindingId?: string; conversationId?: string } & HistoryPosition, caller: string,
  emit: (event: "snapshot" | "update", value: BindingUpdates | ChannelConversationUpdates) => void, signal: AbortSignal): Promise<void> {
  let bindingId = input.bindingId, currentSessionId: string | null = null, upstream: AbortController | undefined;
  let latest: SessionUpdates | undefined, coreUnavailable = false, notify = () => {}, position: HistoryPosition = input;
  const frames: { value: SessionUpdates; bytes: number }[] = [], tasks = new Set<Promise<void>>();
  let queuedBytes = 0;
  function follow(sessionId: string | null) {
    if (sessionId === currentSessionId) return;
    upstream?.abort(); latest = undefined; frames.length = 0; queuedBytes = 0; coreUnavailable = false; currentSessionId = sessionId;
    if (!sessionId || signal.aborted) return;
    const controller = upstream = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
    position = input.resumeSessionId === sessionId ? input : {};
    const task = (async () => {
      while (!combined.aborted) {
        try {
          if (!core.subscribeSessionUpdates) fail("CORE_UNAVAILABLE", "Core subscriptions are unavailable.", true);
          await core.subscribeSessionUpdates(sessionId, position, value => {
            if (combined.aborted) return;
            const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
            if (frames.length >= 64 || queuedBytes + bytes > 16 * 1024 * 1024) throw new Error("Subscription consumer must resynchronize.");
            frames.push({ value, bytes }); queuedBytes += bytes; latest = value; coreUnavailable = false;
            const history = value.history;
            position = { resumeSessionId: sessionId, cursor: history.eventsError ? position.cursor : history.nextCursor,
              updateCursor: history.historyError ? position.updateCursor : history.updateCursor ?? position.updateCursor,
              contextCursor: history.historyError ? position.contextCursor : history.contextCursor ?? position.contextCursor };
            notify();
          }, combined);
          if (!combined.aborted) throw new Error("Subscription ended.");
        } catch { if (!combined.aborted) { coreUnavailable = true; notify(); } }
        if (!combined.aborted) await delay(1500, undefined, { signal: combined }).catch(() => {});
      }
    })().finally(() => tasks.delete(task));
    tasks.add(task);
  }
  try {
    await observeChanges(callback => {
      notify = callback;
      return store.changes.subscribe(topic => {
        if (topic === `binding:${bindingId}` || input.conversationId && topic === `conversation:${input.conversationId}`) callback();
      });
    }, async initial => {
      let conversation: ChannelConversationDetails | undefined;
      if (input.conversationId) {
        const saved = channels.store.get<{ bindingId: string | null }>("channel_conversations", input.conversationId) ?? fail("NOT_FOUND", "Conversation not found.");
        bindingId = saved.bindingId ?? undefined;
      }
      const binding = bindingId ? store.getBinding(bindingId) : null;
      let targetValid = true;
      try { if (binding) sessions.assertTarget(binding, caller); } catch { targetValid = false; }
      follow(targetValid ? binding?.sessionId ?? null : null);
      const entry = frames.shift(), frame = entry?.value;
      if (entry) queuedBytes -= entry.bytes;
      const details = binding ? await sessions.getDetails(binding, caller, coreUnavailable ? { core: null, coreError: { code: "CORE_UNAVAILABLE", message: "Core updates are unavailable. Reconnecting…", retryable: true } } : frame || latest ? { core: (frame ?? latest)!.details, coreError: null } : undefined, signal) : undefined;
      if (input.conversationId) conversation = await channels.readConversation(input.conversationId, details);
      if (signal.aborted) return;
      if (conversation && conversation.conversation.bindingId !== (binding?.bindingId ?? null)) { notify(); return; }
      if (frame && latest?.details.contextAuthority === "operator") {
        frame.details = { ...frame.details, contextAuthority: "operator", interactions: frame.details.interactions.map(({ details: _details, ...item }) => item) };
        const history = frame.history, turns = new Set([...history.messages, ...history.liveMessages, ...history.activities].map(item => item.turnId));
        for (const event of history.events) { if (event.turnId) turns.add(event.turnId); }
        frame.history = { ...history, messages: maskPrivateMessages(history.messages, turns), liveMessages: maskPrivateMessages(history.liveMessages, turns),
          events: maskPrivateEvents(history.events, turns), activities: history.activities.map(maskPrivateActivity),
          ...(history.contextRecords ? { contextRecords: history.contextRecords.map(record => ({ ...record, text: "", availability: "restricted" as const })) } : {}) };
      }
      if (details?.core && latest?.details.contextAuthority === "operator") details.core = { ...details.core, contextAuthority: "operator", interactions: details.core.interactions.map(({ details: _details, ...item }) => item) };
      const value = { contractVersion, ...(conversation ? { conversation } : {}), ...(details ? { details } : {}), ...(frame ? { history: frame.history } : {}) };
      emit(initial ? "snapshot" : "update", value as BindingUpdates | ChannelConversationUpdates);
      if (frames.length) notify();
    }, signal);
  } finally { upstream?.abort(); await Promise.allSettled(tasks); }
}
