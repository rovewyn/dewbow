import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  publicOrigin: string;
  operatorToken: string;
  databasePath: string;
  webDir: string;
  coreUrl: string | null;
  coreToken: string | null;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.DEWBOW_TEAM_PORT ?? "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid DEWBOW_TEAM_PORT.");
  const publicOrigin = env.DEWBOW_TEAM_ORIGIN ?? `http://127.0.0.1:${port}`;
  const origin = new URL(publicOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== publicOrigin) throw new Error("DEWBOW_TEAM_ORIGIN must be an HTTP(S) origin.");
  const operatorToken = env.DEWBOW_TEAM_OPERATOR_TOKEN ?? "";
  if (operatorToken.length < 16 || operatorToken.length > 512) throw new Error("DEWBOW_TEAM_OPERATOR_TOKEN must contain 16–512 characters.");
  const coreUrl = env.DEWBOW_CORE_URL || null;
  const coreToken = env.DEWBOW_CORE_TOKEN || null;
  if (Boolean(coreUrl) !== Boolean(coreToken)) throw new Error("Configure DEWBOW_CORE_URL and DEWBOW_CORE_TOKEN together.");
  if (coreUrl) {
    const url = new URL(coreUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid DEWBOW_CORE_URL.");
  }
  return {
    host: env.DEWBOW_TEAM_HOST ?? "127.0.0.1", port, publicOrigin, operatorToken,
    databasePath: resolve(env.DEWBOW_TEAM_DATABASE ?? "state/team.sqlite"),
    webDir: resolve(env.DEWBOW_TEAM_WEB_DIR ?? "apps/team-web/dist"), coreUrl, coreToken,
  };
}
