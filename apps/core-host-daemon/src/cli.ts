import { HostDaemon, readHostDaemonConfig } from "./index.js";
import { ManagementError } from "@dewbow/core-protocol";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") console.log("Usage: core-host-daemon [--check|--help]\nSee docs/host-daemon.md for credentials, Codex setup, and recovery. --check does not access Codex or open a connection.");
else if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) { console.error("Usage: core-host-daemon [--check|--help]"); process.exitCode = 1; }
else {
  try {
    const daemon = new HostDaemon(readHostDaemonConfig());
    if (args[0] === "--check") console.log(JSON.stringify({ component: "core-host-daemon", configuration: "valid", runtime: "not_checked" }));
    else {
      daemon.onRuntimeFailure = () => { process.exitCode = 1; };
      await daemon.start();
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void daemon.stop(); });
    }
  } catch (error) { console.error(error instanceof ManagementError ? `${error.detail.code}: ${error.message}` : error instanceof TypeError ? error.message : "Host daemon startup failed. Check local configuration and Codex."); process.exitCode = 1; }
}
