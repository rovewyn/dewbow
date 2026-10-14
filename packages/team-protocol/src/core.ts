import type { Interaction, Event, NativeMessage, Operation, Session, Turn } from "@dewbow/core-protocol";
import type { SessionActivity } from "@dewbow/core-protocol";
export type { SessionActivity, ContentRef, ContentPage } from "@dewbow/core-protocol";
import type { ApiError, SessionBinding, SessionOptions } from "./index.js";

export type { Host as CoreHost, NativeMessage, SessionState as RuntimeState } from "@dewbow/core-protocol";

/** Public Core v1 projections derive from its contract; execution stays behind HTTP. */
export type CoreOperation = Pick<Operation, "commandId" | "operation" | "sessionId" | "turnId" | "requestId" | "status" | "createdAt" | "error">;
export type CoreSession = Pick<Session, "sessionId" | "hostId" | "workDir" | "codexThreadId" | "connectionState" | "runtimeState" | "observedAt" | "lastKnownState" | "lastKnownAt" | "activeTurnId" | "sessionConfig" | "workspace" | "executionPause">;
export type CoreTurn = Turn;
export type CoreInteraction = Interaction;
export type { UserQuestion, QuestionAnswer, InteractionDetails, TurnMode } from "@dewbow/core-protocol";

export interface CoreSessionDetails {
  session: CoreSession;
  contextAuthority:"agent"|"operator";
  turns: CoreTurn[];
  interactions: CoreInteraction[];
  interactionsError: ApiError | null;
  operations: CoreOperation[];
}

export interface CoreHistory {
  contextRecords?: import("@dewbow/core-protocol").SessionContext[];
  contextCursor?: number; beforeContextCursor?: number | null; hasMoreContexts?: boolean;
  events: Event[];
  nextCursor: number;
  hasMore: boolean;
  messages: NativeMessage[];
  activities: SessionActivity[];
  beforeCursor: string | null;
  afterCursor: string | null;
  updateCursor: string | null;
  hasMoreUpdates: boolean;
  liveMessages: NativeMessage[];
  historyError: ApiError | null;
  eventsError?: ApiError | null;
}

export interface BindingOperation {
  operation: string;
  requestId: string;
  turnId: string | null;
  interactionId: string | null;
  mode: import("@dewbow/core-protocol").TurnMode | null;
  result: CoreOperation | null;
  error: ApiError | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBindingResult {
  binding: SessionBinding;
  operation: CoreOperation | null;
  error: ApiError | null;
}

export interface SessionBindingDetails {
  binding: SessionBinding;
  requestedOptions: SessionOptions | null;
  requests: BindingOperation[];
  core: CoreSessionDetails | null;
  coreError: ApiError | null;
  channelConversationId?: string | null;
}

export interface BindingUpdates { contractVersion: "v1"; details: SessionBindingDetails; history?: CoreHistory }
export interface ChannelConversationUpdates extends Partial<BindingUpdates> { contractVersion: "v1"; conversation: import("./channels.js").ChannelConversationDetails }
