import type { Event, NativeMessage } from "@dewbow/core-protocol";
export interface Entry { id: string; timestamp: string; kind: "user" | "assistant" | "activity"; title: string; text: string }
import { isMessageComplete as final } from "@dewbow/core-ui/chat/model";
export { mergeNativeMessages } from "@dewbow/core-ui/chat/model";
/** Join native saved messages and transient replies with management metadata. */
export function historyEntries(events: Event[], messages: NativeMessage[], live: NativeMessage[] = []): Entry[] {
  const entries: Entry[] = [];
  for (const event of events) {
    if (["user_message", "assistant_delta", "assistant_message"].includes(event.type)) continue;
    const payload = event.payload;
    let text = "";
    if (event.type === "tool_activity") text = [payload.itemType, payload.command ?? payload.tool, payload.status ?? payload.stage].filter(Boolean).join(" · ");
    else if (payload.error) text = (payload.error as { message: string }).message;
    else if (payload.interaction) { const interaction = payload.interaction as { status: string; decision: string | null }; text = [interaction.status, interaction.decision].filter(Boolean).join(" · "); }
    else if (payload.turn) text = (payload.turn as { state: string }).state;
    else if (event.type === "history_gap") text = `Unavailable events ${payload.fromCursor}–${payload.toCursor}`;
    else if (payload.reason) text = String(payload.reason);
    entries.push({ id: event.eventId, timestamp: event.timestamp, kind: "activity", title: event.type === "operation_error" && payload.operation === "connectSession" ? "Dewbow · connection failed" : `Dewbow · ${event.type.replaceAll("_", " ")}`, text });
  }
  const merged = new Map(messages.map(m => [m.id, m]));
  for (const message of live) if (!merged.has(message.id) || !final(merged.get(message.id)!)) merged.set(message.id,message);
  const ordered = [...merged.values()].sort((a,b)=>a.ordinal !== undefined && b.ordinal !== undefined ? a.ordinal-b.ordinal : a.createdAt.localeCompare(b.createdAt));
  const nativeEntries = ordered.map(message => ({ id: `native:${message.id}`, timestamp: events.find(event=>event.type === "assistant_message" && event.payload.itemId === message.id && event.payload.stage === "completed")?.timestamp ?? message.createdAt,
    kind: message.role, title: message.role === "user" ? "You / agent" : "Codex", text: message.availability === "restricted" ? "This turn contains private operator input. View it in Core." : message.text }));
  entries.push(...nativeEntries);
  entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  // Keep native source order even when a final reply was created before a
  // progress item. Management markers retain their observed timeline slots.
  let nativeIndex = 0;
  for (let index=0;index<entries.length;index++) if (entries[index]!.id.startsWith("native:")) entries[index] = nativeEntries[nativeIndex++]!;
  return entries.filter(e => e.kind !== "assistant" || e.text);
}
