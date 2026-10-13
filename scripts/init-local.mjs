import { initializeLocal, localOptions } from "./local-config.mjs";

try {
  const options = localOptions(process.argv.slice(2));
  if (options.help) console.log("Usage: npm run local:init -- [--state-dir <directory>] [--core-port <port>] [--team-port <port>] [--codex-executable <path>] [--codex-home <directory>]");
  else {
    const { directory } = initializeLocal(options);
    console.log(`Local configuration: ${directory}`);
    console.log("Existing configuration was preserved. Use local:up, local:status and local:down for the live stack, or start each service independently.");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
