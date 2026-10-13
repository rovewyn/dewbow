import { fail, TeamError, type ApiError } from "@dewbow/team-protocol";
import type { HistoryPosition, SessionUpdates } from "@dewbow/core-protocol";
import { readEventStream } from "@dewbow/core-protocol/stream";

export type CoreOperationName = "listWorkspaceProfiles" | "listHosts" | "createSession" | "getSession" | "connectSession" | "sendMessage" | "steerTurn" | "answerQuestions" | "interruptTurn" | "readSessionHistory" | "getSessionActivity" | "readSessionContent" | "pauseSessionExecution" | "resumeSessionExecution" | "appendSessionContext";

export interface CoreApi {
  readonly url: string | null;
  call<T>(operation: CoreOperationName, input: Record<string, unknown>, mutation?: boolean, signal?: AbortSignal): Promise<T>;
  subscribeSessionUpdates?(sessionId: string, position: HistoryPosition, receive: (value: SessionUpdates) => void, signal: AbortSignal): Promise<void>;
}

export class CoreClient implements CoreApi {
  readonly url: string | null;

  constructor(url: string | null, private readonly credential: string | null) {
    this.url = url ? new URL(url.endsWith("/") ? url : `${url}/`).href : null;
  }

  async call<T>(operation: CoreOperationName, input: Record<string, unknown>, mutation = false, signal?: AbortSignal): Promise<T> {
    if (!this.url || !this.credential) fail("CORE_NOT_CONFIGURED", "Configure Dewbow Core on the Team backend.");
    try {
      const response = await fetch(new URL(`api/${operation}`, this.url), {
        method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.credential}` },
        body: JSON.stringify(input),
      });
      const value = await response.json() as { result?: T; error?: ApiError };
      if (value?.error && typeof value.error.code === "string" && typeof value.error.message === "string" && typeof value.error.retryable === "boolean") {
        const error = value.error;
        throw new TeamError({ code: error.code, message: error.message.replaceAll(this.credential, "[redacted]"), retryable: error.retryable,
          ...(error.sessionId ? { sessionId: error.sessionId } : {}), ...(error.turnId ? { turnId: error.turnId } : {}) });
      }
      if (!response.ok || !value || !Object.hasOwn(value, "result")) throw new Error("Invalid Core response.");
      return value.result as T;
    } catch (error) {
      if (error instanceof TeamError) throw error;
      fail(mutation ? "DELIVERY_UNCERTAIN" : "CORE_UNAVAILABLE",
        mutation ? "Core delivery is uncertain. Retry the original request." : "Dewbow Core could not be reached.", true);
    }
  }

  async subscribeSessionUpdates(sessionId: string, position: HistoryPosition, receive: (value: SessionUpdates) => void, signal: AbortSignal): Promise<void> {
    if (!this.url || !this.credential) fail("CORE_NOT_CONFIGURED", "Configure Dewbow Core on the Team backend.");
    const url = new URL("api/subscribeSessionUpdates", this.url);
    url.searchParams.set("sessionId", sessionId);
    for (const key of ["cursor", "updateCursor", "contextCursor"] as const) if (position[key] !== undefined) url.searchParams.set(key, String(position[key]));
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${this.credential}`, Accept: "text/event-stream" }, redirect: "error", signal });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Core subscription is unavailable.");
      for await (const frame of readEventStream(response.body)) {
        if (frame.event === "streamError") throw new Error("Core subscription ended.");
        if (!["snapshot", "update"].includes(frame.event)) continue;
        const value = frame.data as SessionUpdates;
        if (value.contractVersion !== "v1" || value.details?.session.sessionId !== sessionId || !value.history || !Array.isArray(value.history.messages)) throw new Error("Invalid Core subscription.");
        receive(value);
      }
      if (!signal.aborted) throw new Error("Core subscription ended.");
    } catch {
      if (!signal.aborted) fail("CORE_UNAVAILABLE", "Core updates are unavailable. Reconnecting preserves the session.", true);
    }
  }
}
