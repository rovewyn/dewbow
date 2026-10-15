/** Translate domain inputs without changing the identity used for explicit retries. */
export function apiRequest(operation: string, input: Record<string, unknown> = {}) {
  const body = { ...input };
  function segment(key: string) {
    const value = body[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${key}.`);
    delete body[key];
    return encodeURIComponent(value);
  }
  let path: string, method: "GET" | "POST";
  switch (operation) {
    case "listHosts": method = "GET"; path = "/hosts"; break;
    case "listSessions": method = "GET"; path = "/sessions"; break;
    case "getSession": method = "GET"; path = `/sessions/${segment("sessionId")}`; break;
    case "getOperation": method = "GET"; path = `/operations/${segment("commandId")}`; break;
    case "readSessionHistory": method = "GET"; path = `/sessions/${segment("sessionId")}/history`; break;
    case "getSessionActivity": method = "GET"; path = `/sessions/${segment("sessionId")}/activities/${segment("itemId")}`; break;
    case "readSessionContent": method = "GET"; path = `/sessions/${segment("sessionId")}/contents/${segment("contentId")}`; break;
    case "createSession": method = "POST"; path = "/sessions"; break;
    case "connectSession": method = "POST"; path = `/sessions/${segment("sessionId")}/connections`; break;
    case "sendMessage": method = "POST"; path = `/sessions/${segment("sessionId")}/turns`; break;
    case "steerTurn":
    case "interruptTurn":
      method = "POST";
      path = `/sessions/${segment("sessionId")}/turns/${segment("turnId")}/${operation === "steerTurn" ? "instructions" : "interruptions"}`;
      break;
    case "answerQuestions":
    case "decideApproval":
      method = "POST";
      path = `/sessions/${segment("sessionId")}/turns/${segment("turnId")}/interactions/${segment("interactionId")}/${operation === "answerQuestions" ? "answers" : "decisions"}`;
      break;
    default: throw new Error(`Unknown operation: ${operation}.`);
  }
  path = `/api/v1${path}`;
  if (method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) if (value !== undefined) query.set(key, String(value));
    if (query.size) path += `?${query}`;
  }
  return { path, method, input: method === "POST" ? body : undefined };
}

export const sessionUpdatesPath = (sessionId: string) => `/api/v1/sessions/${encodeURIComponent(sessionId)}/updates`;
