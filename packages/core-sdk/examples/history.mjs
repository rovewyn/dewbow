import { readSessionHistory } from "@dewbow/core-sdk";

const [sessionId, limit = "20", sortDirection = "asc"] = process.argv.slice(2);
if (!sessionId) {
  console.error("Usage: node examples/history.mjs <session-id> [limit] [asc|desc]");
  process.exitCode = 1;
} else {
  const page = await readSessionHistory(sessionId, { limit: Number(limit), sortDirection });
  // This explicit history command prints private conversation content. Keep its output local.
  console.log(JSON.stringify(page, null, 2));
}
