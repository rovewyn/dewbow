import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { CoreClient } from "../dist/core-client.js";

test("Core transport uses backend authentication, redacts errors and reports uncertain writes", async () => {
  const credential = "synthetic-core-management-credential";
  let redirect = false;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    response.writeHead(redirect ? 302 : 400, redirect ? { Location: "https://untrusted.invalid/" } : { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "SYNTHETIC_ERROR", message: `Do not expose ${credential}`, retryable: false } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new CoreClient(`http://127.0.0.1:${server.address().port}`, credential);
  try {
    await assert.rejects(client.call("listHosts", {}), error => error.detail.code === "SYNTHETIC_ERROR" && !error.message.includes(credential));
    redirect = true;
    await assert.rejects(client.call("createSession", {}, true), error => error.detail.code === "DELIVERY_UNCERTAIN" && error.detail.retryable);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(client.call("getSession", {}), error => error.detail.code === "CORE_UNAVAILABLE");
  await assert.rejects(client.call("createSession", {}, true), error => error.detail.code === "DELIVERY_UNCERTAIN");
});
