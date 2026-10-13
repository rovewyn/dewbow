import type { AgentRef, ManagementErrorData, SessionOptions } from "@dewbow/core-protocol";
export type { AgentRef, SessionOptions } from "@dewbow/core-protocol";

export const contractVersion = "v1" as const;

export interface AgentDefinition {
  definitionId: string;
  name: string;
  description: string;
  source: "builtin" | "custom";
  revision: string;
  sessionOptions: SessionOptions;
  createdAt: string | null;
  updatedAt: string | null;
}

export const defaultDefinition: Readonly<AgentDefinition> = Object.freeze({
  definitionId: "default",
  name: "Default Codex",
  description: "Use the host's Codex baseline without session overrides.",
  source: "builtin",
  revision: "1",
  sessionOptions: Object.freeze({}),
  createdAt: null,
  updatedAt: null,
});

export interface Team {
  teamId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TeamMember {
  memberId: string;
  teamId: string;
  name: string;
  definitionId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface SessionBinding {
  bindingId: string;
  memberId: string | null;
  createCaller: string;
  createOperation: "createMemberSession" | "createAgentSession";
  workspaceProfileId: string | null;
  sessionId: string | null;
  hostId: string;
  workDir: string | null;
  agentRef: AgentRef;
  createRequestId: string;
  createdAt: string;
}

export type ApiError = ManagementErrorData;

export class TeamError extends Error {
  constructor(readonly detail: ApiError) {
    super(detail.message);
    this.name = "TeamError";
  }
}

export function fail(code: string, message: string, retryable = false): never {
  throw new TeamError({ code, message, retryable });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export { normalizeDefinitionId, validateInput } from "./validation.js";
export type { CoreHost, CoreOperation, RuntimeState, CoreSession, CoreTurn, CoreInteraction, CoreSessionDetails, NativeMessage, SessionActivity, ContentRef, ContentPage, CoreHistory, BindingOperation, SessionBindingResult, SessionBindingDetails,UserQuestion,QuestionAnswer,InteractionDetails,TurnMode } from "./core.js";

export type { Chatbot, ChannelConnection, ChannelConversation, ChannelDelivery, ChannelState } from "./channels.js";
