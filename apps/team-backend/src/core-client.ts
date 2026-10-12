import { fail, TeamError, type ApiError } from "@dewbow/team-protocol";

export type CoreOperationName = "listHosts" | "createSession" | "getSession" | "connectSession" | "sendMessage" | "interruptTurn" | "readSessionHistory";

export interface CoreApi {
  readonly url: string | null;
  call<T>(operation: CoreOperationName, input: Record<string, unknown>, mutation?: boolean): Promise<T>;
}

export class CoreClient implements CoreApi {
  readonly url: string | null;

  constructor(url: string | null, private readonly credential: string | null) {
    this.url = url ? new URL(url.endsWith("/") ? url : `${url}/`).href : null;
  }

  async call<T>(operation: CoreOperationName, input: Record<string, unknown>, mutation = false): Promise<T> {
    if (!this.url || !this.credential) fail("CORE_NOT_CONFIGURED", "Configure Dewbow Core on the Team backend.");
    try {
      const response = await fetch(new URL(`api/${operation}`, this.url), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
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
}
