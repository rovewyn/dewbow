import type { ManagementErrorData, Operation, SessionSummary, NativeMessage, Turn, Approval, Event } from "@dewbow/core-protocol";
export type OperationSummary = Omit<Operation, "caller" | "fingerprint" | "input">;
export interface Detail { session: SessionSummary; turns: Turn[]; approvals: Approval[]; operations: OperationSummary[] }
export interface History { events: Event[]; nextCursor: number; hasMore: boolean; messages: NativeMessage[]; nextMessageCursor: string | null; liveMessages: NativeMessage[]; historyError: ManagementErrorData | null; eventsError: ManagementErrorData | null }
export class ApiError extends Error {
  constructor(readonly detail: ManagementErrorData) { super(`${detail.code}: ${detail.message}`); }
}
export async function request<T>(path: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), ...(signal ? { signal } : {}) });
  const data = await response.json() as { result?: T; error?: ManagementErrorData };
  if (data.error) throw new ApiError(data.error);
  if (!response.ok || data.result === undefined) throw new Error("The service returned an invalid response.");
  return data.result;
}
export const api = <T>(operation: string, input: unknown = {}, signal?: AbortSignal): Promise<T> => request(`/api/${operation}`, input, signal);
