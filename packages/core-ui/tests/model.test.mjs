import test from "node:test";
import assert from "node:assert/strict";
import { buildChatModel, mergeNativeMessages, mergeActivities, emptyHistory, mergeHistory, restrictHistory } from "../dist/chat/model.js";

const date = "2026-01-01T00:00:00Z";
const message = (id, ordinal, role, text, extra = {}) => ({ id, ordinal, updatedOrdinal: ordinal, turnId: "native-turn", role, text, phase: role === "assistant" ? "commentary" : null, createdAt: date, itemComplete: false, ...extra });
const turn = { turnId: "core-turn", sessionId: "session", codexTurnId: "native-turn", requestId: "request", mode: "plan", state: "running", createdAt: date, observedAt: date, error: null };
const event = (cursor, type, payload, turnId = turn.turnId) => ({ eventId: `event:${cursor}`, sessionId: "session", turnId, cursor, type, timestamp: date, payload: { turn, ...payload } });
const page = (extra = {}) => ({ messages: [], activities: [], liveMessages: [], events: [], nextCursor: 0, updateCursor: null, beforeCursor: null, ...extra });

test("source versions preserve shorter finals, private placeholders and independent history watermarks", () => {
  const final = message("reply", 10, "assistant", "Done", { itemComplete: true, phase: "final_answer" });
  assert.equal(mergeNativeMessages([final], [message("reply", 9, "assistant", "Long stale stream")])[0].text, "Done");
  assert.equal(mergeNativeMessages([final], [{ ...final, text: "", availability: "restricted" }])[0].text, "");
  let state = mergeHistory(emptyHistory(), page({ messages: [final], nextCursor: 20, updateCursor: "updates", beforeCursor: "older", liveMessages: [message("live", undefined, "assistant", "Current")] }));
  state = mergeHistory(state, page({ nextCursor: 12, updateCursor: "stale", beforeCursor: "previous", liveMessages: [message("live", undefined, "assistant", "Stale")] }), "older");
  assert.equal(state.eventCursor, 20); assert.equal(state.updateCursor, "updates"); assert.equal(state.live.live.text, "Current");
  assert.equal(state.beforeCursor, "previous");
  const tied = mergeNativeMessages([message("a", 1, "user", "lower"), message("\u{10000}", 1, "user", "supplementary")], [message("A", 1, "user", "upper"), message("\uE000", 1, "user", "BMP")]);
  assert.deepEqual(tied.map(item => item.id), ["A", "a", "\uE000", "\u{10000}"]);
});

test("projection uses exact turn and client identities, keeps instruction before final and separates ambiguous turns", () => {
  const messages = [message("initial", 1, "user", "Task", { clientId: "initial-command" }), message("progress", 3, "assistant", "Working"), message("final", 10, "assistant", "Done", { phase: "final_answer", itemComplete: true })];
  const events = [event(1, "user_message", { text: "Task", clientId: "initial-command" }), event(3, "assistant_message", { itemId: "progress" }), event(5, "user_message", { text: "Additional task", clientId: "steer-command", steering: true }), event(10, "assistant_message", { itemId: "final", stage: "completed" })];
  const model = buildChatModel({ sessionKey: "session", turns: [turn], messages, events, interactions: [] });
  assert.equal(model.turns.length, 1); assert.equal(model.turns[0].turnId, turn.turnId);
  assert.deepEqual(model.turns[0].messages.map(item => [item.kind, item.text]), [["user", "Task"], ["progress", "Working"], ["instruction", "Additional task"], ["final", "Done"]]);
  assert.equal(model.turns[0].orderIncomplete, true);
  const ambiguous = buildChatModel({ sessionKey: "session", turns: [turn, { ...turn, turnId: "other-core-turn" }], messages, interactions: [] });
  assert.equal(ambiguous.turns.find(item => item.messages.length).turnId, null);
  assert.equal(ambiguous.notices.length, 1);
  const opaque = mergeHistory(emptyHistory(), page({ messages: [message("__proto__", 1, "user", "Opaque")], events: [event(2, "history_gap", { fromCursor: 1, toCursor: 1 })] }));
  assert.equal(opaque.saved.__proto__.text, "Opaque"); assert.equal(Object.getPrototypeOf(opaque.saved), null);
  const crossTurn = buildChatModel({ sessionKey: "session", turns: [turn, { ...turn, turnId: "second", codexTurnId: "second-native" }], messages: [message("second-user", 1, "user", "Second task", { turnId: "second-native", clientId: "shared-client" })], events: [event(2, "user_message", { text: "First task", clientId: "shared-client", steering: true })], interactions: [] });
  assert.equal(crossTurn.turns.find(item => item.turnId === "core-turn").messages[0].text, "First task");
  assert.equal(crossTurn.turns.find(item => item.turnId === "second").messages[0].kind, "user");
  const observedBinding = buildChatModel({ sessionKey: "session", turns: [{ ...turn, codexTurnId: null }], messages, events, interactions: [] });
  assert.equal(observedBinding.turns.length, 1); assert.equal(observedBinding.turns[0].nativeTurnId, "native-turn");
  const contradictory = event(2, "user_message", { turn: { ...turn, turnId: "second" }, text: "Contradictory task", clientId: "initial-command" }, "second");
  const conflicting = buildChatModel({ sessionKey: "session", turns: [turn, { ...turn, turnId: "second", codexTurnId: "second-native" }], messages, events: [contradictory], interactions: [] });
  assert.equal(conflicting.turns.find(item => item.messages.some(message => message.id === "initial")).turnId, null);
  assert.equal(conflicting.turns.find(item => item.turnId === "second").messages[0].text, "Contradictory task");
  const afterFinal = buildChatModel({ sessionKey: "session", turns: [turn], messages, events: [...events.filter(item => item.type !== "user_message" || item.cursor === 1), event(11, "user_message", { text: "Observed after final", steering: true })], interactions: [] });
  assert.equal(afterFinal.turns[0].messages.at(-1).text, "Observed after final");
});

test("completed native activities retain source metadata while restricted updates remain monotonic", () => {
  const ref = { contentId: "content", kind: "output", label: "Output", byteLength: 10, availability: "available", completeness: "complete", authority: "agent" };
  const native = { id: "tool", turnId: "native-turn", ordinal: 3, updatedOrdinal: 6, itemComplete: true, createdAt: date, type: "commandExecution", title: "Native command", command: "synthetic command", status: "completed", contents: [ref] };
  const cached = { ...native, ordinal: null, updatedOrdinal: null, title: "Cached command", contents: [{ ...ref, contentId: "stale" }] };
  const merged = mergeActivities([native], [cached])[0];
  assert.equal(merged.ordinal, 3); assert.equal(merged.updatedOrdinal, 6); assert.equal(merged.contents[0].contentId, "content");
  const restricted = { ...cached, availability: "restricted", title: "Restricted activity", command: undefined, contents: [{ ...ref, authority: "operator" }] };
  const hidden = mergeActivities([native], [restricted])[0];
  assert.equal(hidden.availability, "restricted"); assert.equal(hidden.command, undefined); assert.equal(hidden.ordinal, 3);
  assert.equal(mergeActivities([hidden], [native])[0].availability, "restricted");
  assert.equal(mergeActivities([hidden], [native])[0].command, undefined);
  const projected = buildChatModel({ sessionKey: "session", turns: [turn], messages: [], activities: [native], events: [event(7, "tool_activity", { activity: cached })], interactions: [] });
  assert.equal(projected.turns[0].activities[0].title, "Native command");
  const live = buildChatModel({ sessionKey: "session", turns: [turn], messages: [], events: [event(3, "tool_activity", { activity: { ...cached, itemComplete: false } }), event(5, "user_message", { text: "Instruction", steering: true }), event(8, "tool_activity", { activity: cached })], interactions: [] });
  assert.deepEqual(live.turns[0].activityOrders.get("tool"), { source: "event", value: 3 });
  assert.deepEqual(live.turns[0].order, { source: "event", value: 3 });
  let history = mergeHistory(emptyHistory(), page({ messages: [message("old", 1, "user", "Cached body")], events: [event(1, "progress", { explanation: "Cached progress" })], activities: [native], nextCursor: 10 }));
  history = restrictHistory(history);
  history = mergeHistory(history, page({ liveMessages: [message("echo", 2, "assistant", "Delayed echo")], events: [event(1, "progress", { explanation: "Delayed progress" })], nextCursor: 10 }), "newer");
  assert.equal(history.saved.old.text, ""); assert.equal(history.live.echo.text, "");
  assert.equal(history.events[0].payload.explanation, undefined); assert.equal(history.activities.tool.command, undefined);
  const protectedModel = buildChatModel({ sessionKey: "session", turns: [turn], messages: [message("old", 1, "user", "Body")], events: [event(2, "progress", { explanation: "Body" })], interactions: [], restricted: true });
  assert.equal(protectedModel.turns[0].messages[0].restricted, true); assert.equal(protectedModel.turns[0].progress.length, 0);
});
