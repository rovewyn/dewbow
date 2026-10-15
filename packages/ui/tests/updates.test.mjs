import test from "node:test";
import assert from "node:assert/strict";
import { subscribeUpdates } from "../dist/chat/updates.js";

test("subscription reconnect uses committed cursors and ignores closed or superseded sources", t => {
  const previousWindow = globalThis.window, previousSource = globalThis.EventSource;
  const sources = [];
  class Source {
    handlers = new Map(); closed = false;
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    close() { this.closed = true; }
    emit(name, data) { this.handlers.get(name)?.({ data: JSON.stringify(data) }); }
  }
  globalThis.window = { location: { origin: "https://synthetic.example" } }; globalThis.EventSource = Source;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { globalThis.window = previousWindow; globalThis.EventSource = previousSource; });
  const received = [], errors = []; let cursor = 0;
  const dispose = subscribeUpdates("/api/v1/sessions/synthetic/updates", () => ({ cursor }), value => { received.push(value); cursor = value.cursor; }, error => errors.push(error));
  sources[0].emit("snapshot", { cursor: 4 }); sources[0].onerror();
  assert.equal(sources[0].closed, true); t.mock.timers.tick(1500);
  assert.equal(new URL(sources[1].url).searchParams.get("cursor"), "4");
  sources[0].emit("update", { cursor: 2 }); sources[1].emit("update", { cursor: 5 });
  assert.deepEqual(received, [{ cursor: 4 }, { cursor: 5 }]);
  dispose(); sources[1].emit("update", { cursor: 6 }); sources[1].onerror(); t.mock.timers.tick(1500);
  assert.equal(sources.length, 2); assert.equal(sources[1].closed, true);
  const second = subscribeUpdates("/api/v1/sessions/other/updates", () => ({}), () => {}, error => errors.push(error));
  sources[2].emit("streamError", { code: "UNAUTHORIZED", message: "Sign in again", retryable: false }); t.mock.timers.tick(1500);
  assert.equal(sources.length, 3); assert.equal(errors.at(-1).code, "UNAUTHORIZED"); second();
});
