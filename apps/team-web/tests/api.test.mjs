import assert from "node:assert/strict";
import test from "node:test";
import { call, onAuthFailure, signIn } from "../src/api.ts";

test("confirmed Team authentication loss releases the workspace while Core credential errors do not", async () => {
  const original = globalThis.fetch; let notifications = 0, authenticated = false;
  const unsubscribe = onAuthFailure(() => notifications++);
  globalThis.fetch = async path => new Response(JSON.stringify(path === "/auth/session" ? { result: { authenticated } } : { error: { code: "UNAUTHORIZED", message: "Synthetic authentication error", retryable: false } }), { status: path === "/auth/session" ? 200 : 401 });
  try {
    await assert.rejects(call("getSessionBinding", { bindingId: "synthetic-binding" })); assert.equal(notifications, 1);
    let resolveAuth;
    globalThis.fetch = async path => path === "/auth/session" ? new Promise(resolve => { resolveAuth = resolve; }) : new Response(JSON.stringify(path === "/auth/login" ? { result: { authenticated: true } } : { error: { code: "UNAUTHORIZED", message: "Synthetic old request", retryable: false } }), { status: path === "/auth/login" ? 200 : 401 });
    const oldRequest = call("getSessionBinding", { bindingId: "synthetic-binding" });
    await new Promise(resolve => setImmediate(resolve));
    await signIn("synthetic-operator-token");
    resolveAuth(new Response(JSON.stringify({ result: { authenticated: false } })));
    await assert.rejects(oldRequest); assert.equal(notifications, 1);
    authenticated = true;
    globalThis.fetch = async path => new Response(JSON.stringify(path === "/auth/session" ? { result: { authenticated } } : { error: { code: "UNAUTHORIZED", message: "Synthetic Core authentication error", retryable: false } }), { status: path === "/auth/session" ? 200 : 401 });
    await assert.rejects(call("readBindingContent", { bindingId: "synthetic-binding", contentId: "synthetic-content" })); assert.equal(notifications, 1);
    globalThis.fetch = async path => { if (path === "/auth/session") throw new Error("Synthetic connection unavailable"); return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Synthetic error", retryable: false } }), { status: 401 }); };
    await assert.rejects(call("getSessionBinding", { bindingId: "synthetic-binding" })); assert.equal(notifications, 1);
  } finally { unsubscribe(); globalThis.fetch = original; }
});
