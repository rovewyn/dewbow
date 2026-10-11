import assert from "node:assert/strict";
import test from "node:test";
import { emptyHistory, mergeHistory, visibleMessages } from "../src/history.ts";

const message = (id, text, extra = {}) => ({ id, text, turnId: "turn-example", role: "assistant", phase: null, createdAt: "2026-01-01T00:00:00.000Z", turnStatus: "running", ...extra });
const page = extra => ({ events: [], nextCursor: 0, hasMore: false, messages: [], nextMessageCursor: null, liveMessages: [], historyError: null, ...extra });

test("native pagination and event cursors remain independent across a final page and failed reads", () => {
  let state = mergeHistory(emptyHistory(), page({ nextCursor: 8, messages: [message("one", "First")], nextMessageCursor: "native-page-two" }), undefined);
  state = mergeHistory(state, page({ nextCursor: 10, messages: [message("two", "Second")], liveMessages: [message("stream", "Live")] }), state.messageCursor);
  assert.equal(state.messageCursor, "native-page-two");
  assert.equal(state.eventCursor, 10);
  state = mergeHistory(state, page({ nextCursor: 11, messages: [message("two", "Updated")], liveMessages: [], nextMessageCursor: "native-page-three" }), state.messageCursor);
  assert.deepEqual(visibleMessages(state).map(item => item.text), ["First", "Updated"]);
  const failed = mergeHistory(state, page({ nextCursor: 0, historyError: { code: "UNAVAILABLE", message: "Unavailable", retryable: true }, eventsError: { code: "UNAVAILABLE", message: "Unavailable", retryable: true } }), state.messageCursor);
  assert.equal(failed.messageCursor, "native-page-three");
  assert.equal(failed.eventCursor, 11);
  assert.deepEqual(visibleMessages(failed), visibleMessages(state));
});

test("live updates merge by native ID without replacing final saved answers", () => {
  const state = mergeHistory(emptyHistory(), page({ messages: [message("answer", "Final saved answer", { phase: "final_answer", turnStatus: "completed" }), message("draft", "Saved draft"), message("__proto__", "Opaque ID")], liveMessages: [message("answer", "Stale stream"), message("draft", "Updated stream"), message("new", "New stream")] }), undefined);
  assert.deepEqual(visibleMessages(state).map(item => item.text), ["Final saved answer", "Updated stream", "Opaque ID", "New stream"]);
  assert.equal(visibleMessages(state).length, 4);
  const failedEvents = mergeHistory(state, page({ messages: [message("draft", "Completed draft", { turnStatus: "interrupted" })], eventsError: { code: "UNAVAILABLE", message: "Unavailable", retryable: true } }), undefined);
  assert.equal(visibleMessages(failedEvents).find(item => item.id === "draft").text, "Completed draft");
  assert.equal(visibleMessages(failedEvents).find(item => item.id === "new").text, "New stream");
  const failedTurn = mergeHistory(failedEvents, page({ messages: [message("new", "Last saved partial answer", { turnStatus: "failed" })], liveMessages: [message("new", "Stale live partial answer")] }), undefined);
  assert.equal(visibleMessages(failedTurn).find(item => item.id === "new").text, "Last saved partial answer");
});
