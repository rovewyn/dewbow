import type { SessionItemRecord } from "@dewbow/sdk";
import { ManagementError, type NativeMessage, type SessionActivity } from "@dewbow/protocol";
import { SessionHistoryError } from "@dewbow/sdk";
import { SessionContent } from "./content.js";

const string = (value: unknown) => typeof value === "string" ? value : null;
const terminal = (status: string | null) => ["completed","failed","declined"].includes(status ?? "");

/** Native names and bodies stop at this adapter; journals receive references only. */
export function projectItem(record: SessionItemRecord, scope: string, contents: SessionContent, live = false, authority: "agent" | "operator" = "agent"): { message?: NativeMessage; activity?: SessionActivity } {
  const { item } = record, type = String(item.type), createdAt = new Date(record.createdAtMs).toISOString();
  if (["userMessage","agentMessage","plan"].includes(type)) {
    if (type === "userMessage" ? !Array.isArray(item.content) || item.content.some((part:any)=>!part || typeof part.type !== "string" || (part.type === "text" && typeof part.text !== "string")) : typeof item.text !== "string") throw new SessionHistoryError("INVALID_HISTORY","Native message content is invalid.");
    const text = type === "userMessage" ? (Array.isArray(item.content) ? item.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "") : string(item.text) ?? "";
    return { message: { id:record.id,turnId:record.turnId,ordinal:record.ordinal,updatedOrdinal:record.updatedOrdinal,createdAt,turnStatus:record.turnStatus,itemComplete:record.completedAtMs !== null,
      role:type === "userMessage" ? "user" : "assistant",text,phase:type === "plan" ? "plan" : string(item.phase),...(type === "userMessage" ? {clientId:string(item.clientId)} : {}) } };
  }
  const activity: SessionActivity = { id:record.id,turnId:record.turnId,ordinal:live ? null : record.ordinal,updatedOrdinal:live ? null : record.updatedOrdinal,itemComplete:record.completedAtMs !== null && (type !== "commandExecution" || terminal(string(item.status))),createdAt,type,title:type,status:string(item.status),contents:[] };
  if (type === "commandExecution") {
    activity.title = "Command"; if (typeof item.command === "string") activity.command = item.command;
    let retained: SessionActivity | undefined;
    try { retained = contents.getActivity(scope,record.id); } catch (error) { if (!(error instanceof ManagementError) || error.detail.code !== "NOT_FOUND") throw error; }
    const complete = retained?.turnId === record.turnId && terminal(retained.status) ? retained.contents.find(ref => ref.kind === "output" && ref.completeness === "complete") : undefined;
    activity.contents = [complete ?? contents.put(scope,record.id,"output","Command output",string(item.aggregatedOutput),terminal(activity.status) ? "unknown" : "partial")];
    const capture = retained?.contents.find(ref=>ref.contentId && contents.isCapture(scope,ref.contentId));
    if (!complete && capture?.contentId) {
      const partial = contents.captureRef(scope,capture.contentId);
      activity.contents = terminal(activity.status) ? [partial,...activity.contents] : [partial];
    }
  } else if (type === "fileChange") {
    activity.title = "File changes";
    const changes = Array.isArray(item.changes) ? item.changes : [];
    activity.paths = changes.map((change: any) => string(change?.path)).filter((path): path is string => path !== null);
    activity.contents = changes.map((change: any, index) => contents.put(scope,record.id,"diff",string(change?.path) ?? `File ${index+1}`,string(change?.diff),terminal(activity.status) ? "complete" : "partial"));
  } else if (type === "mcpToolCall") {
    activity.title = `${string(item.server) ?? "MCP"} / ${string(item.tool) ?? "tool"}`;
    activity.contents = [contents.put(scope,record.id,"output","Native tool details",record.itemJson,record.completedAtMs !== null ? "unknown" : "partial")];
  } else if (type === "dynamicToolCall" || type === "functionCallOutput") {
    activity.title = string(item.tool) ?? string(item.name) ?? "Tool";
    activity.contents = [contents.put(scope,record.id,"output","Native tool details",record.itemJson,record.completedAtMs !== null ? "unknown" : "partial")];
  } else if (["webSearch","collabAgentToolCall","subAgentActivity","imageGeneration"].includes(type)) {
    activity.contents = [contents.put(scope,record.id,"output","Native tool details",record.itemJson,record.completedAtMs !== null ? "unknown" : "partial")];
  }
  if(authority === "operator") for(const ref of activity.contents) if(ref.contentId){contents.restrict(scope,ref.contentId);ref.authority="operator";}
  return { activity:contents.saveActivity(scope,activity) };
}
