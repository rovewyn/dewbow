import type { ApiError } from "@dewbow/team-protocol";

export class ApiClientError extends Error {
  constructor(readonly detail: ApiError) { super(detail.message); this.name = "ApiClientError"; }
}

async function request<T>(path: string, method: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    const response = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      ...(input === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
    });
    const value = await response.json() as { result: T; error?: ApiError };
    if (value.error) throw new ApiClientError(value.error);
    if (!response.ok || !Object.hasOwn(value, "result")) throw new Error("Invalid response.");
    return value.result;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    if (signal?.aborted) throw error;
    throw new ApiClientError({ code: "REQUEST_UNCERTAIN", message: "Team could not confirm the request. Retry with the same input.", retryable: true });
  }
}

export const call = <T>(operation: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> => request(`/api/${operation}`, "POST", input, signal);
export const readAuth = (): Promise<{ authenticated: boolean }> => request("/auth/session", "GET");
export const signIn = (token: string): Promise<{ authenticated: boolean }> => request("/auth/login", "POST", { token });
export const signOut = (): Promise<unknown> => request("/auth/logout", "POST", {});
export const errorDetail = (error: unknown): ApiError => error instanceof ApiClientError ? error.detail
  : { code: "REQUEST_FAILED", message: "The request could not be completed.", retryable: false };
