import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createPrivateFile, ensurePrivateFile, protectExistingPrivateFile } from "@dewbow/core-protocol/files";

export const controllerPath = directory => resolve(directory, "live-controller.json");
export const lastRunPath = directory => resolve(directory, "live-last-run.json");
export function readPrivateJson(path) {
  try {
    protectExistingPrivateFile(path);
    const text = readFileSync(path, "utf8");
    if (text.length > 16384) throw new Error("Local controller record is too large.");
    return JSON.parse(text);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function writePrivateJson(path, value) {
  if (existsSync(path)) ensurePrivateFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  createPrivateFile(temporary, JSON.stringify(value, null, 2) + "\n");
  try { renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function readController(directory) {
  const value = readPrivateJson(controllerPath(directory));
  if (!value) return null;
  if (value.contractVersion !== "v1" || typeof value.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.instanceId)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
    throw new Error("Invalid local controller ownership record. Inspect the private state; do not reset a running instance.");
  }
  if (value.controlOrigin !== null) {
    const url = new URL(value.controlOrigin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== value.controlOrigin) throw new Error("Invalid local controller address.");
  }
  return value;
}
export const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};
export async function requestController(record, operation) {
  if (!record.controlOrigin) throw new Error("The local controller is starting or unavailable.");
  const response = await fetch(`${record.controlOrigin}/${operation}`, {
    method: operation === "stop" ? "POST" : "GET", redirect: "error",
    headers: { Authorization: `Bearer ${record.token}`, "X-Dewbow-Instance": record.instanceId },
    signal: AbortSignal.timeout(operation === "stop" ? 15000 : 5000),
  });
  if (!response.ok) throw new Error("The local controller could not authenticate or complete the request.");
  const value = await response.json();
  if (value.instanceId !== record.instanceId) throw new Error("Local controller identity changed; no process was stopped.");
  return value;
}

export function releaseController(directory, instanceId, result) {
  const current = readController(directory);
  if (current?.instanceId !== instanceId) throw new Error("Local controller ownership changed during shutdown.");
  writePrivateJson(lastRunPath(directory), result);
  unlinkSync(controllerPath(directory));
}
