import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createTeamServer } from "../dist/server.js";

test("management authentication rejects cross-origin access and keeps tokens out of replies", async t => {
  const token = "synthetic-operator-credential";
  const config = { publicOrigin: "http://localhost", operatorToken: token, webDir: "/nonexistent" };
  const server = createTeamServer(config, () => ({ ok: true }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, headers, input) => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input) });
  assert.equal((await post("/api/example", { Origin: config.publicOrigin }, {})).status, 401);
  assert.equal((await post("/auth/login", { Origin: "https://elsewhere.invalid" }, { token })).status, 403);
  const login = await post("/auth/login", { Origin: config.publicOrigin }, { token });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.ok(!cookie.includes(token));
  assert.ok(!(await login.text()).includes(token));
  assert.equal((await post("/api/example", { Origin: config.publicOrigin, Cookie: cookie.split(";")[0] }, {})).status, 200);
  assert.equal((await post("/api/example", { Origin: "https://elsewhere.invalid", Cookie: cookie }, {})).status, 403);
  assert.equal((await post("/api/example", { Authorization: `Bearer ${token}` }, {})).status, 200);
});
