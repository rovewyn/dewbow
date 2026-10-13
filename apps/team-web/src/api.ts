import type { ApiError,ContentPage,InteractionDetails } from "@dewbow/team-protocol";

export class ApiClientError extends Error {
  readonly detail: ApiError;
  constructor(detail: ApiError) { super(detail.message); this.detail = detail; this.name = "ApiClientError"; }
}
const authFailures = new Set<() => void>();
let authEpoch = 0;
export function onAuthFailure(listener: () => void): () => void { authFailures.add(listener); return () => { authFailures.delete(listener); }; }
export async function confirmSubscriptionAuth(): Promise<void> {
  const epoch = authEpoch;
  try {
    const response = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5000) });
    const value = await response.json() as { result?: { authenticated?: boolean } };
    if (epoch === authEpoch && response.ok && value.result?.authenticated === false) for (const listener of authFailures) listener();
  } catch { /* Failed verification leaves authentication unknown instead of clearing authorized state. */ }
}

async function request<T>(path: string, method: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    const response = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      ...(input === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
    });
    const value = await response.json() as { result: T; error?: ApiError };
    if (value.error) {
      if (value.error.code === "UNAUTHORIZED" && path.startsWith("/api/")) await confirmSubscriptionAuth();
      throw new ApiClientError(value.error);
    }
    if (!response.ok || !Object.hasOwn(value, "result")) throw new Error("Invalid response.");
    return value.result;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    if (signal?.aborted) throw error;
    throw new ApiClientError({ code: "REQUEST_UNCERTAIN", message: "Team could not confirm the request. Retry with the same input.", retryable: true });
  }
}

export const call = <T>(operation: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> => request(`/api/${operation}`, "POST", input, signal);
export async function readInteractionDetails(bindingId:string,contentId:string,signal?:AbortSignal):Promise<InteractionDetails> {
  let text="",cursor:string|null=null,offset=0;
  do {
    const page:ContentPage=await call<ContentPage>("readBindingContent",{bindingId,contentId,...(cursor ? {contentCursor:cursor} : {})},signal);
    if(page.contentId!==contentId || page.byteOffset!==offset || page.byteLength>1048576 || (page.nextCursor && !page.text))throw new Error("Invalid interaction details page.");
    text+=page.text;offset+=new TextEncoder().encode(page.text).length;cursor=page.nextCursor;
  }while(cursor);
  return JSON.parse(text) as InteractionDetails;
}
export const readAuth = (): Promise<{ authenticated: boolean }> => request("/auth/session", "GET");
export async function signIn(token: string): Promise<{ authenticated: boolean }> { const result = await request<{ authenticated: boolean }>("/auth/login", "POST", { token }); authEpoch++; return result; }
export async function signOut(): Promise<unknown> { const result = await request("/auth/logout", "POST", {}); authEpoch++; return result; }
export const errorDetail = (error: unknown): ApiError => error instanceof ApiClientError ? error.detail
  : { code: "REQUEST_FAILED", message: "The request could not be completed.", retryable: false };
