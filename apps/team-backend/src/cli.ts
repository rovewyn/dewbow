import { readConfig } from "./config.js";
import { createTeamServer } from "./server.js";
import { TeamStore } from "./store.js";
import { CoreClient } from "./core-client.js";
import { TeamApi } from "./api.js";

const config = readConfig();
if (process.argv.includes("--check")) {
  console.log("Dewbow Team configuration is valid.");
} else {
  const store = new TeamStore(config.databasePath);
  const api = new TeamApi(store, new CoreClient(config.coreUrl, config.coreToken));
  const server = createTeamServer(config, (operation, input, caller) => api.execute(operation, input, caller));
  server.listen(config.port, config.host, () => console.log(`Dewbow Team listening at ${config.publicOrigin}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
