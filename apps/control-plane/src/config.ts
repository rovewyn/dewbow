import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ControlPlaneConfig {
  host: string; port: number; statePath: string; hostsFile: string; publicOrigin: string;
  managementToken: string; operatorPassword: string; webRoot: string;
  tlsCert?: string; tlsKey?: string;
}
export function readControlPlaneConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const host = (env.DEWBOW_CONTROL_PLANE_HOST ?? "127.0.0.1").trim();
  if (!host) throw new TypeError("DEWBOW_CONTROL_PLANE_HOST must not be empty.");
  const value = env.DEWBOW_CONTROL_PLANE_PORT ?? "3000", port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new TypeError("DEWBOW_CONTROL_PLANE_PORT must be an integer from 1 to 65535.");
  const tlsCert = env.DEWBOW_TLS_CERT, tlsKey = env.DEWBOW_TLS_KEY;
  if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new TypeError("Set both DEWBOW_TLS_CERT and DEWBOW_TLS_KEY.");
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !tlsCert) throw new TypeError("Non-loopback listeners require TLS.");
  const publicOrigin = env.DEWBOW_PUBLIC_ORIGIN ?? `${tlsCert ? "https" : "http"}://${host === "::1" ? "[::1]" : host}:${port}`;
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || !["http:", "https:"].includes(origin.protocol)) throw new TypeError("DEWBOW_PUBLIC_ORIGIN must be an HTTP(S) origin without a path.");
  return { host, port, publicOrigin, statePath: resolve(env.DEWBOW_CONTROL_PLANE_STATE ?? "state/control-plane.sqlite"),
    hostsFile: resolve(env.DEWBOW_HOSTS_FILE ?? "state/hosts.json"), managementToken: env.DEWBOW_MANAGEMENT_TOKEN ?? "",
    operatorPassword: env.DEWBOW_OPERATOR_PASSWORD ?? "", webRoot: resolve(env.DEWBOW_WEB_ROOT ?? fileURLToPath(new URL("../../web/dist/", import.meta.url))),
    ...(tlsCert && tlsKey ? { tlsCert, tlsKey } : {}) };
}
