import { resolve } from "node:path";
import { readWorkspaceConfig, type WorkspaceConfig } from "./workspaces.js";
export interface HostDaemonConfig {
  hostId: string; codexHome?: string; controlPlaneUrl: string; token: string; statePath: string;
  codexExecutable: string; model?: string; workspaces?: WorkspaceConfig;
}
export function readHostDaemonConfig(env: NodeJS.ProcessEnv = process.env): HostDaemonConfig {
  const hostId = env.DEWBOW_HOST_ID?.trim();
  if (!hostId) throw new TypeError("DEWBOW_HOST_ID is required. Configure a stable host identity.");
  const controlPlaneUrl = env.DEWBOW_CONTROL_PLANE_URL ?? "http://127.0.0.1:3000";
  const url = new URL(controlPlaneUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TypeError("DEWBOW_CONTROL_PLANE_URL must be an HTTP(S) origin.");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new TypeError("Cross-machine connections require HTTPS/WSS.");
  const workspaces = readWorkspaceConfig(env.DEWBOW_HOST_WORKSPACE_CONFIG);
  return { ...(workspaces ? { workspaces } : {}), hostId, controlPlaneUrl: url.origin, token: env.DEWBOW_HOST_TOKEN ?? "", statePath: resolve(env.DEWBOW_HOST_STATE ?? "state/host-daemon.sqlite"),
    codexExecutable: env.DEWBOW_CODEX_EXECUTABLE ?? "codex", ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}), ...(env.DEWBOW_CODEX_MODEL ? { model: env.DEWBOW_CODEX_MODEL } : {}) };
}
