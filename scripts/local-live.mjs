import { fork, execFile } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateFile } from "@dewbow/core-protocol/files";
import { nativeCommand } from "../packages/core-sdk/dist/internal.js";
import { initializeLocal, localOptions, readLocalEnvironment } from "./local-config.mjs";
import { alive, lastRunPath, readController, readPrivateJson, requestController } from "./local-live-state.mjs";

const run = promisify(execFile);
const usage = "Usage: npm run local:<up|status|down> -- [--state-dir <directory>]\nUp also accepts --core-port, --team-port, --codex-executable and --codex-home. Saved configuration is preserved. See docs/operations.md.";

async function up(options) {
  const { directory } = initializeLocal(options);
  const existing = readController(directory);
  if (existing) return requestController(existing, "status");
  const daemon = readLocalEnvironment(directory, "host-daemon.env");
  const executable = daemon.DEWBOW_CODEX_EXECUTABLE ?? process.env.DEWBOW_CODEX_EXECUTABLE ?? "codex";
  if (process.platform === "win32" && /(?:^|[\\/])codex(?:\.cmd|\.js)?$/i.test(executable)) {
    throw new Error("On Windows, configure the standalone codex.exe with --codex-executable or the private host-daemon.env file.");
  }
  for (const path of ["apps/core-control-plane/dist/index.js", "apps/core-host-daemon/dist/index.js", "apps/team-backend/dist/server.js", "apps/core-web/dist/index.html", "apps/team-web/dist/index.html"]) {
    if (!existsSync(path)) throw new Error("Build the workspaces before starting the live stack: npm run build.");
  }
  const env = { ...process.env, ...(daemon.CODEX_HOME ? { CODEX_HOME: daemon.CODEX_HOME } : {}) };
  const execute = async args => {
    const command = nativeCommand(executable, args);
    return run(command.executable, command.args, { env, windowsHide: true, timeout: 15000, maxBuffer: 65536 });
  };
  try {
    if ((await execute(["--version"])).stdout.trim() !== "codex-cli 0.162.1") throw new Error();
  } catch { throw new Error("Codex CLI 0.162.1 is required. Check the configured standalone executable."); }
  try { await execute(["login", "status"]); }
  catch { throw new Error("Codex model access is not configured. Complete codex login for the configured Codex home."); }
  const logPath = resolve(directory, "live.log"); ensurePrivateFile(logPath);
  const log = openSync(logPath, "a");
  let child;
  try {
    child = fork(new URL("./local-live-controller.mjs", import.meta.url), [directory], {
      cwd: process.cwd(), execArgv: [], detached: true, windowsHide: true, stdio: ["ignore", log, log, "ipc"],
    });
  } finally { closeSync(log); }
  let cancelled = false;
  const cancel = () => { cancelled = true; if (child.connected) child.send({ type: "stop" }, () => {}); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    return await new Promise((accept, reject) => {
      const timeout = setTimeout(() => { cancel(); finish(); reject(new Error("Live startup timed out. Inspect local:status and the private live.log.")); }, 45000);
      const finish = () => { clearTimeout(timeout); child.removeListener("message", message); };
      const message = value => {
        if (value?.type === "ready") {
          if (cancelled) { cancel(); return; }
          child.send({ type: "handoff" }, error => {
            if (error || cancelled) { cancel(); finish(); reject(new Error("Live controller handoff failed.")); return; }
            finish(); child.disconnect(); child.unref(); accept(value.status);
          });
        } else if (value?.type === "failed") { finish(); reject(new Error(value.message)); }
      };
      child.on("message", message);
      child.once("error", () => { finish(); reject(new Error("Could not start the local controller.")); });
      child.once("exit", () => { finish(); reject(new Error("The live controller exited before handoff. Inspect the private live.log.")); });
    });
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (child.connected) child.disconnect();
    child.unref();
  }
}

try {
  const [operation, ...args] = process.argv.slice(2), options = localOptions(args);
  if (options.help) console.log(usage);
  else if (!["up", "status", "down"].includes(operation)) throw new Error(usage);
  else if (operation !== "up" && [options.corePort, options.teamPort, options.codexExecutable, options.codexHome].some(value => value !== undefined)) throw new Error("Status and down accept only --state-dir.");
  else {
    let result;
    if (operation === "up") result = await up(options);
    else {
      const record = readController(options.directory);
      if (!record) result = readPrivateJson(lastRunPath(options.directory)) ?? { status: "notManaged" };
      else {
        try {
          if (operation === "down") {
            await requestController(record, "status");
            result = await requestController(record, "stop");
            for (let i = 0; i < 30 && alive(record.pid); i++) await delay(100);
            if (alive(record.pid)) throw new Error("The controller did not exit within the shutdown deadline.");
          } else result = await requestController(record, "status");
        } catch {
          const finished = !readController(options.directory) && readPrivateJson(lastRunPath(options.directory));
          if (finished?.instanceId === record.instanceId && !alive(record.pid)) result = finished;
          else { result = { status: "unavailable", instanceId: record.instanceId, message: "The owned controller could not be confirmed. No recorded PID was killed. Inspect private live.log and the recovery runbook." }; process.exitCode = 1; }
        }
      }
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status && !["ready", "stopped", "notManaged"].includes(result.status)) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
