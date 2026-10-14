import { discoverSessions } from "@dewbow/sdk";

const snapshot = await discoverSessions();
// Counts only: avoid printing private names, IDs, workspaces, or raw provider output.
console.log(JSON.stringify(snapshot.summary, null, 2));
console.table(snapshot.sources.map(({ source, state, counts }) => ({ source, state, ...counts })));
