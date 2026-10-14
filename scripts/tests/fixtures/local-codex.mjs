// Synthetic lifecycle fixture. It never reads real credentials or native sessions.
import { existsSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) console.log("codex-cli 0.162.1");
else if (process.argv.includes("login")) console.log("Synthetic model access configured.");
else if (process.argv.includes("app-server")) {
  if (existsSync(join(process.env.CODEX_HOME, "fail-start"))) process.exit(1);
  await import("../../../apps/host-daemon/tests/fixtures/codex.mjs");
} else process.exitCode = 1;
