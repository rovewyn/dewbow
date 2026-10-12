import { test } from "node:test";
import assert from "node:assert/strict";
import { historyEntries } from "../src/history.ts";

test("completed replies replace streaming text without hiding intervening tool activity or history gaps", () => {
  const event = (cursor, type, payload) => ({ eventId: `session:${cursor}`, sessionId: "session", turnId: "turn", timestamp: "2026-01-01T00:00:00Z", cursor, type, payload });
  const events = [event(1, "user_message", { text: "Start" }), event(2, "assistant_delta", { itemId: "reply", text: "Hel" }),
    event(3, "tool_activity", { itemType: "commandExecution", command: "synthetic command", status: "completed" }),
    event(4, "assistant_delta", { itemId: "reply", text: "lo" }), event(5, "assistant_message", { itemId: "reply", stage: "completed", text: "Hello" }),
    event(7, "history_gap", { fromCursor: 6, toCursor: 6 })];
  const native = [
    { id: "request", role: "user", text: "Start", createdAt: events[0].timestamp },
    { id: "reply", role: "assistant", text: "Hello", createdAt: events[0].timestamp },
  ];
  const entries = historyEntries(events, native, [{ ...native[1], text: "Hel" }]);
  assert.equal(entries.filter(e => e.kind === "assistant").length, 1);
  assert.equal(entries.find(e => e.kind === "assistant").text, "Hello");
  assert.match(entries.find(e => e.title === "Dewbow · tool activity").text, /synthetic command/);
  assert.match(entries.find(e => e.title === "Dewbow · history gap").text, /Unavailable events 6/);
  assert.equal(entries.filter(e => e.kind === "user").length, 1);
});
