import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { ensurePrivateDirectory, ensurePrivateFile, createPrivateFile } from "@dewbow/core-protocol/files";

// Node's env-file quoting differs from JSON: normalize Windows path separators.
export const environment = values => Object.entries(values).map(([name, value]) => {
  const encoded = typeof value === "string" && /^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? value.replaceAll("\\", "/") : value;
  return `${name}=${JSON.stringify(encoded)}`;
}).join("\n") + "\n";

export function localOptions(args) {
  const { values } = parseArgs({ args, options: {
    "state-dir": { type: "string" }, "core-port": { type: "string" }, "team-port": { type: "string" },
    "codex-executable": { type: "string" }, "codex-home": { type: "string" }, help: { type: "boolean" },
  } });
  if (Object.values(values).some(value => typeof value === "string" && !value.trim())) throw new Error("Options must have non-empty values.");
  const port = value => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Ports must be integers from 1 to 65535.");
    return Number(value);
  };
  return { directory: resolve(values["state-dir"] ?? "state/local"), corePort: port(values["core-port"]), teamPort: port(values["team-port"]),
    codexExecutable: values["codex-executable"], codexHome: values["codex-home"], help: Boolean(values.help) };
}

export function readLocalEnvironment(directory, name) {
  const path = resolve(directory, name); ensurePrivateFile(path);
  return parseEnv(readFileSync(path, "utf8"));
}

/** Existing credentials, databases and native configuration are never reset. */
export function initializeLocal(options = {}) {
  const directory = resolve(options.directory ?? "state/local");
  ensurePrivateDirectory(directory);
  const lockPath = resolve(directory, "local-init.lock"), nonce = randomBytes(16).toString("hex");
  if (!createPrivateFile(lockPath, JSON.stringify({ pid: process.pid, nonce }))) throw new Error("Local initialization is already owned. Retry after it finishes or inspect the private local-init.lock.");
  try { return initializeDirectory({ ...options, directory }); }
  finally {
    if (JSON.parse(readFileSync(lockPath, "utf8")).nonce !== nonce) throw new Error("Local initializer ownership changed.");
    unlinkSync(lockPath);
  }
}

function initializeDirectory(options) {
  const directory = options.directory;
  const read = name => existsSync(resolve(directory, name)) ? readLocalEnvironment(directory, name) : {};
  const savedCore = read("control-plane.env"), savedTeam = read("team.env"), savedDaemon = read("host-daemon.env");
  for (const [requested, saved] of [[options.corePort, savedCore.DEWBOW_CONTROL_PLANE_PORT], [options.teamPort, savedTeam.DEWBOW_TEAM_PORT],
    [options.codexExecutable, savedDaemon.DEWBOW_CODEX_EXECUTABLE], [options.codexHome && resolve(options.codexHome), savedDaemon.CODEX_HOME]]) {
    if (requested !== undefined && saved !== undefined && String(requested).replaceAll("\\", "/") !== saved.replaceAll("\\", "/")) {
      throw new Error("Requested settings differ from saved configuration. Use another state directory or edit the private environment file explicitly.");
    }
  }
  const corePort = Number(savedCore.DEWBOW_CONTROL_PLANE_PORT ?? options.corePort ?? 3000);
  const teamPort = Number(savedTeam.DEWBOW_TEAM_PORT ?? options.teamPort ?? 3100);
  if (corePort === teamPort) throw new Error("Core and Team need distinct ports.");
  const additions = Object.fromEntries(Object.entries({ DEWBOW_CODEX_EXECUTABLE: options.codexExecutable, CODEX_HOME: options.codexHome && resolve(options.codexHome) })
    .filter(([key, value]) => value !== undefined && savedDaemon[key] === undefined));
  if (existsSync(resolve(directory, "host-daemon.env")) && Object.keys(additions).length && existsSync(resolve(directory, "live-controller.json"))) {
    throw new Error("Stop the owned controller before adding native runtime settings.");
  }
  const workDir = resolve(directory, "workdir"); ensurePrivateDirectory(workDir);
  const create = (name, content) => createPrivateFile(resolve(directory, name), content);
  create("credentials.json", JSON.stringify(Object.fromEntries(["agent", "host", "operator", "teamOperator"].map(name => [name, randomBytes(32).toString("base64url")])), null, 2) + "\n");
  const credentials = JSON.parse(readFileSync(resolve(directory, "credentials.json"), "utf8"));
  if (!credentials.teamOperator) {
    credentials.teamOperator = randomBytes(32).toString("base64url");
    writeFileSync(resolve(directory, "credentials.json"), JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  }
  const origin = `http://127.0.0.1:${corePort}`;
  create("hosts.json", JSON.stringify([{ hostId: "local-host", name: "Local machine", token: credentials.host }], null, 2) + "\n");
  create("control-plane.env", environment({
    DEWBOW_CONTROL_PLANE_HOST: "127.0.0.1", DEWBOW_CONTROL_PLANE_PORT: String(corePort), DEWBOW_PUBLIC_ORIGIN: origin,
    DEWBOW_CONTROL_PLANE_STATE: resolve(directory, "control.sqlite"), DEWBOW_HOSTS_FILE: resolve(directory, "hosts.json"),
    DEWBOW_MANAGEMENT_TOKEN: credentials.agent, DEWBOW_OPERATOR_PASSWORD: credentials.operator, DEWBOW_WEB_ROOT: resolve("apps/core-web/dist"),
  }));
  const daemonCreated = create("host-daemon.env", environment({
    DEWBOW_HOST_ID: "local-host", DEWBOW_HOST_TOKEN: credentials.host, DEWBOW_CONTROL_PLANE_URL: savedCore.DEWBOW_PUBLIC_ORIGIN ?? origin,
    DEWBOW_HOST_STATE: resolve(directory, "daemon.sqlite"),
    ...(options.codexExecutable || process.env.DEWBOW_CODEX_EXECUTABLE ? { DEWBOW_CODEX_EXECUTABLE: options.codexExecutable ?? process.env.DEWBOW_CODEX_EXECUTABLE } : {}),
    ...(options.codexHome ? { CODEX_HOME: resolve(options.codexHome) } : {}),
  }));
  if (!daemonCreated && Object.keys(additions).length) appendFileSync(resolve(directory, "host-daemon.env"), "\n" + environment(additions));
  const core = readLocalEnvironment(directory, "control-plane.env");
  create("agent.env", environment({ DEWBOW_MANAGEMENT_TOKEN: core.DEWBOW_MANAGEMENT_TOKEN, DEWBOW_CONTROL_PLANE_URL: core.DEWBOW_PUBLIC_ORIGIN }));
  create("team.env", environment({
    DEWBOW_TEAM_HOST: "127.0.0.1", DEWBOW_TEAM_PORT: String(teamPort), DEWBOW_TEAM_ORIGIN: `http://127.0.0.1:${teamPort}`,
    DEWBOW_TEAM_OPERATOR_TOKEN: credentials.teamOperator, DEWBOW_TEAM_DATABASE: resolve(directory, "team.sqlite"), DEWBOW_TEAM_WEB_DIR: resolve("apps/team-web/dist"),
    DEWBOW_CORE_URL: core.DEWBOW_PUBLIC_ORIGIN, DEWBOW_CORE_TOKEN: core.DEWBOW_MANAGEMENT_TOKEN,
  }));
  create("mcp.json", JSON.stringify({ mcpServers: { "dewbow-core": { url: `${core.DEWBOW_PUBLIC_ORIGIN}/mcp`, headers: { Authorization: `Bearer ${core.DEWBOW_MANAGEMENT_TOKEN}` } } } }, null, 2) + "\n");
  return { directory, workDir };
}
