import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { ensurePrivateDirectory, createPrivateFile } from "@dewbow/core-protocol/files";
import { environment } from "./local-config.mjs";

const directory = resolve("state/local");
ensurePrivateDirectory(directory);
ensurePrivateDirectory(resolve(directory, "workdir"));
function create(name, content) {
  createPrivateFile(resolve(directory, name), content);
}
create("credentials.json", JSON.stringify(Object.fromEntries(
  ["agent", "host", "operator", "teamOperator"].map(name => [name, randomBytes(32).toString("base64url")]),
), null, 2) + "\n");
const credentials = JSON.parse(readFileSync(resolve(directory, "credentials.json"), "utf8"));
// Extend existing local setups without rotating Core credentials.
if (!credentials.teamOperator) {
  credentials.teamOperator = randomBytes(32).toString("base64url");
  writeFileSync(resolve(directory, "credentials.json"), JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
}
const origin = "http://127.0.0.1:3000";
create("hosts.json", JSON.stringify([{ hostId: "local-host", name: "Local machine", token: credentials.host }], null, 2) + "\n");
create("control-plane.env", environment({
  DEWBOW_CONTROL_PLANE_HOST: "127.0.0.1", DEWBOW_CONTROL_PLANE_PORT: "3000", DEWBOW_PUBLIC_ORIGIN: origin,
  DEWBOW_CONTROL_PLANE_STATE: resolve(directory, "control.sqlite"), DEWBOW_HOSTS_FILE: resolve(directory, "hosts.json"),
  DEWBOW_MANAGEMENT_TOKEN: credentials.agent, DEWBOW_OPERATOR_PASSWORD: credentials.operator,
  DEWBOW_WEB_ROOT: resolve("apps/core-web/dist"),
}));
create("host-daemon.env", environment({
  DEWBOW_HOST_ID: "local-host", DEWBOW_HOST_TOKEN: credentials.host, DEWBOW_CONTROL_PLANE_URL: origin,
  DEWBOW_HOST_STATE: resolve(directory, "daemon.sqlite"),
}));
create("agent.env", environment({ DEWBOW_MANAGEMENT_TOKEN: credentials.agent, DEWBOW_CONTROL_PLANE_URL: origin }));
const coreEnvironment = parseEnv(readFileSync(resolve(directory, "control-plane.env"), "utf8"));
create("team.env", environment({
  DEWBOW_TEAM_HOST: "127.0.0.1", DEWBOW_TEAM_PORT: "3100", DEWBOW_TEAM_ORIGIN: "http://127.0.0.1:3100",
  DEWBOW_TEAM_OPERATOR_TOKEN: credentials.teamOperator, DEWBOW_TEAM_DATABASE: resolve(directory, "team.sqlite"),
  DEWBOW_TEAM_WEB_DIR: resolve("apps/team-web/dist"),
  DEWBOW_CORE_URL: coreEnvironment.DEWBOW_PUBLIC_ORIGIN ?? origin,
  DEWBOW_CORE_TOKEN: coreEnvironment.DEWBOW_MANAGEMENT_TOKEN ?? credentials.agent,
}));
create("mcp.json", JSON.stringify({ mcpServers: { "dewbow-core": { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${credentials.agent}` } } } }, null, 2) + "\n");
console.log(`Local configuration: ${directory}`);
console.log("Existing Core configuration was preserved. Start built services with npm run local:core:control-plane, npm run local:core:host-daemon and npm run local:team:backend.");
