import type { ManagementErrorData, Operation, SessionSummary, NativeMessage, SessionActivity, Turn, Interaction, InteractionDetails,ContentPage,Event } from "@dewbow/protocol";
export type OperationSummary = Omit<Operation, "caller" | "fingerprint" | "input">;
export interface Detail { session: SessionSummary; contextAuthority:"agent"|"operator";turns: Turn[]; interactions: Interaction[]; interactionsError:ManagementErrorData|null; operations: OperationSummary[] }
export interface History { events:Event[]; nextCursor:number; hasMore:boolean; messages:NativeMessage[]; activities:SessionActivity[]; beforeCursor:string|null; afterCursor:string|null; updateCursor:string|null; hasMoreUpdates:boolean; liveMessages:NativeMessage[]; historyError:ManagementErrorData|null; eventsError:ManagementErrorData|null }
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
export async function readInteractionDetails(sessionId:string,contentId:string,signal?:AbortSignal):Promise<InteractionDetails> {
  let text="",cursor:string|null=null,offset=0;
  do {
    const page:ContentPage=await api<ContentPage>("readSessionContent",{sessionId,contentId,...(cursor ? {contentCursor:cursor} : {})},signal);
    if(page.contentId!==contentId || page.byteOffset!==offset || page.byteLength>1048576 || (page.nextCursor && !page.text))throw new Error("Invalid interaction details page.");
    text+=page.text;offset+=new TextEncoder().encode(page.text).length;cursor=page.nextCursor;
  }while(cursor);
  return JSON.parse(text) as InteractionDetails;
}
