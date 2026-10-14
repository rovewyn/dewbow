import type { Event, NativeMessage } from "./index.js";

/** Volatile reply cache. Saved native messages remain authoritative. */
export class LiveReplies {
  private readonly sessions = new Map<string, { messages: Map<string, NativeMessage>; updated: number }>();
  private sweep(): void {
    for (const [id, entry] of this.sessions) if (Date.now() - entry.updated > 600000) this.sessions.delete(id);
  }
  observe(event: Event): void {
    this.sweep();
    if (!["assistant_delta", "assistant_message"].includes(event.type) || typeof event.payload.text !== "string") return;
    const entry = this.sessions.get(event.sessionId) ?? { messages: new Map<string, NativeMessage>(), updated: Date.now() };
    const id = String(event.payload.itemId), previous = entry.messages.get(id);
    if (event.type === "assistant_delta" && previous?.itemComplete) return;
    const turn = event.payload.turn as { codexTurnId?: string | null } | undefined;
    entry.messages.set(id, { id, turnId: turn?.codexTurnId ?? "", role: "assistant", phase: String(event.payload.phase ?? previous?.phase ?? "commentary"),
      text: event.type === "assistant_delta" ? (previous?.text ?? "") + event.payload.text : event.payload.stage === "completed" ? event.payload.text : previous?.text ?? event.payload.text,
      createdAt:previous?.createdAt ?? event.timestamp,turnStatus:"inProgress",itemComplete:event.type === "assistant_message" && event.payload.stage === "completed" });
    entry.updated = Date.now(); this.sessions.set(event.sessionId, entry);
  }
  replace(sessionId: string, messages: NativeMessage[]): void {
    this.sweep();
    if (messages.length) this.sessions.set(sessionId, { messages: new Map(messages.map(m => [m.id, m])), updated: Date.now() });
    else this.sessions.delete(sessionId);
  }
  saved(sessionId: string, messages: NativeMessage[]): void {
    const entry = this.sessions.get(sessionId);
    for (const message of messages) if (message.itemComplete || ["completed","interrupted","failed"].includes(message.turnStatus ?? "")) entry?.messages.delete(message.id);
    if (entry && !entry.messages.size) this.sessions.delete(sessionId);
  }
  get(sessionId: string): NativeMessage[] { this.sweep(); return [...(this.sessions.get(sessionId)?.messages.values() ?? [])]; }
}
