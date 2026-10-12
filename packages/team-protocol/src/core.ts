import type { Approval, Event, NativeMessage, Operation, Session, Turn } from "@dewbow-core/protocol";
import type { ApiError, SessionBinding, SessionOptions } from "./index.js";

export type { Host as CoreHost, NativeMessage, SessionState as RuntimeState } from "@dewbow-core/protocol";

/** Public Core v1 projections derive from its contract; execution stays behind HTTP. */
export type CoreOperation = Pick<Operation, "commandId" | "operation" | "sessionId" | "turnId" | "requestId" | "status" | "createdAt" | "error">;
export type CoreSession = Pick<Session, "sessionId" | "hostId" | "workDir" | "codexThreadId" | "connectionState" | "runtimeState" | "observedAt" | "lastKnownState" | "lastKnownAt" | "activeTurnId" | "sessionConfig">;
export type CoreTurn = Pick<Turn, "turnId" | "sessionId" | "state" | "createdAt" | "error">;
export type CoreApproval = Pick<Approval, "approvalId" | "sessionId" | "turnId" | "status" | "action">;

export interface CoreSessionDetails {
  session: CoreSession;
  turns: CoreTurn[];
  approvals: CoreApproval[];
  operations: CoreOperation[];
}

export interface CoreHistory {
  events: Pick<Event, "eventId" | "cursor" | "type" | "timestamp" | "payload">[];
  nextCursor: number;
  hasMore: boolean;
  messages: NativeMessage[];
  nextMessageCursor: string | null;
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
