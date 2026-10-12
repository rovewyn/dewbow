import type { Event, NativeMessage } from "@dewbow-core/protocol";
export interface Entry { id: string; timestamp: string; kind: "user" | "assistant" | "activity"; title: string; text: string }
/** Join native saved messages and transient replies with management metadata. */
export function historyEntries(events: Event[], messages: NativeMessage[], live: NativeMessage[] = []): Entry[] {
  const entries: Entry[] = [];
  for (const event of events) {
    if (["user_message", "assistant_delta", "assistant_message"].includes(event.type)) continue;
    const payload = event.payload;
    let text = "";
    if (event.type === "tool_activity") text = [payload.itemType, payload.command ?? payload.tool, payload.status ?? payload.stage].filter(Boolean).join(" · ");
    else if (payload.error) text = (payload.error as { message: string }).message;
    else if (payload.approval) { const approval = payload.approval as { status: string; decision: string | null }; text = [approval.status, approval.decision].filter(Boolean).join(" · "); }
    else if (payload.turn) text = (payload.turn as { state: string }).state;
    else if (event.type === "history_gap") text = `Unavailable events ${payload.fromCursor}–${payload.toCursor}`;
    else if (payload.reason) text = String(payload.reason);
    entries.push({ id: event.eventId, timestamp: event.timestamp, kind: "activity", title: event.type === "operation_error" && payload.operation === "connectSession" ? "Dewbow · connection failed" : `Dewbow · ${event.type.replaceAll("_", " ")}`, text });
  }
  const merged = new Map(messages.map(m => [m.id, m]));
  for (const message of live) if (!merged.has(message.id) || merged.get(message.id)!.text.length <= message.text.length) merged.set(message.id, message);
  for (const message of merged.values()) entries.push({ id: `native:${message.id}`, timestamp: message.createdAt,
    kind: message.role, title: message.role === "user" ? "You / agent" : "Codex", text: message.text });
  entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return entries.filter(e => e.kind !== "assistant" || e.text);
}
