import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve("state/local");
mkdirSync(directory, { recursive: true, mode: 0o700 });
mkdirSync(resolve(directory, "workdir"), { recursive: true, mode: 0o700 });
function create(name, content) {
  try { writeFileSync(resolve(directory, name), content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
create("credentials.json", JSON.stringify(Object.fromEntries(
  ["agent", "host", "operator"].map(name => [name, randomBytes(32).toString("base64url")]),
), null, 2) + "\n");
const credentials = JSON.parse(readFileSync(resolve(directory, "credentials.json"), "utf8"));
const origin = "http://127.0.0.1:3000";
const environment = values => Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n";
create("hosts.json", JSON.stringify([{ hostId: "local-host", name: "Local machine", token: credentials.host }], null, 2) + "\n");
create("control-plane.env", environment({
  DEWBOW_CONTROL_PLANE_HOST: "127.0.0.1", DEWBOW_CONTROL_PLANE_PORT: "3000", DEWBOW_PUBLIC_ORIGIN: origin,
  DEWBOW_CONTROL_PLANE_STATE: resolve(directory, "control.sqlite"), DEWBOW_HOSTS_FILE: resolve(directory, "hosts.json"),
  DEWBOW_MANAGEMENT_TOKEN: credentials.agent, DEWBOW_OPERATOR_PASSWORD: credentials.operator,
  DEWBOW_WEB_ROOT: resolve("apps/web/dist"),
}));
create("host-daemon.env", environment({
  DEWBOW_HOST_ID: "local-host", DEWBOW_HOST_TOKEN: credentials.host, DEWBOW_CONTROL_PLANE_URL: origin,
  DEWBOW_HOST_STATE: resolve(directory, "daemon.sqlite"),
}));
create("agent.env", environment({ DEWBOW_MANAGEMENT_TOKEN: credentials.agent, DEWBOW_CONTROL_PLANE_URL: origin }));
create("mcp.json", JSON.stringify({ mcpServers: { dewbow: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${credentials.agent}` } } } }, null, 2) + "\n");
console.log(`Local configuration: ${directory}`);
console.log("Existing files were preserved. Start the built services with npm run local:control-plane and npm run local:host-daemon.");
