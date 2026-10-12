import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { environment } from "../local-config.mjs";

test("generated Windows drive and UNC environment paths preserve their filesystem meaning", () => {
  const values = { DRIVE: "C:\\new\\team\\runtime.sqlite", UNC: "\\\\server\\team\\new\\runtime.sqlite", TOKEN: "synthetic-token", ORIGIN: "http://127.0.0.1:3000" };
  const parsed = parseEnv(environment(values));
  assert.deepEqual(parsed, { ...values, DRIVE: "C:/new/team/runtime.sqlite", UNC: "//server/team/new/runtime.sqlite" });
});
