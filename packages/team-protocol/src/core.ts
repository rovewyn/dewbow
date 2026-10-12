import type { Approval, Event, NativeMessage, Operation, Session, Turn } from "@dewbow/core-protocol";
import type { SessionActivity } from "@dewbow/core-protocol";
export type { SessionActivity, ContentRef, ContentPage } from "@dewbow/core-protocol";
import type { ApiError, SessionBinding, SessionOptions } from "./index.js";

export type { Host as CoreHost, NativeMessage, SessionState as RuntimeState } from "@dewbow/core-protocol";

/** Public Core v1 projections derive from its contract; execution stays behind HTTP. */
export type CoreOperation = Pick<Operation, "commandId" | "operation" | "sessionId" | "turnId" | "requestId" | "status" | "createdAt" | "error">;
export type CoreSession = Pick<Session, "sessionId" | "hostId" | "workDir" | "codexThreadId" | "connectionState" | "runtimeState" | "observedAt" | "lastKnownState" | "lastKnownAt" | "activeTurnId" | "sessionConfig">;
export type CoreTurn = Pick<Turn, "turnId" | "sessionId" | "codexTurnId" | "requestId" | "state" | "createdAt" | "observedAt" | "error">;
export type CoreApproval = Pick<Approval, "approvalId" | "sessionId" | "turnId" | "status" | "action">;

export interface CoreSessionDetails {
  session: CoreSession;
  turns: CoreTurn[];
  approvals: CoreApproval[];
  operations: CoreOperation[];
}

export interface CoreHistory {
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

export interface MemberOperation {
  operation: string;
  requestId: string;
  turnId: string | null;
  result: CoreOperation | null;
  error: ApiError | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemberSessionResult {
  binding: SessionBinding;
  operation: CoreOperation | null;
  error: ApiError | null;
}

export interface SessionBindingDetails {
  binding: SessionBinding;
  requestedOptions: SessionOptions | null;
  requests: MemberOperation[];
  core: CoreSessionDetails | null;
  coreError: ApiError | null;
}
