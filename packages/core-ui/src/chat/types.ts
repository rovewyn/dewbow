import type { ContentRef, Interaction, QuestionAnswer, SessionActivity, TurnMode, TurnState } from "@dewbow/core-protocol";

export interface ChatOrder { source: "native" | "event" | "unavailable"; value: number | null }
export interface ChatMessage {
  id: string; kind: "user" | "instruction" | "progress" | "final";
  text: string; createdAt: string; complete: boolean; restricted: boolean; order: ChatOrder;
}
export interface ChatProgress { id: string; text: string; order: ChatOrder }
export type ChatEntry = { kind: "message"; id: string; message: ChatMessage }
  | { kind: "progress"; id: string; progress: ChatProgress }
  | { kind: "activity"; id: string; activity: SessionActivity }
  | { kind: "interaction"; id: string; interaction: Interaction };
export interface ChatTurn {
  key: string; turnId: string | null; nativeTurnId: string | null; state: TurnState | string | null;
  mode: TurnMode | null; messages: ChatMessage[]; progress: ChatProgress[];
  activities: SessionActivity[]; activityOrders: ReadonlyMap<string, ChatOrder>;
  interactions: Interaction[]; order: ChatOrder; orderIncomplete: boolean;
  entries: ChatEntry[];
}
export interface ChatRequest {
  key: string; requestId: string; label: string; status: "accepted" | "delivered" | "error" | "unknown";
  error: string | null; canRetry: boolean;
}
export interface ChatModel {
  sessionKey: string; turns: ChatTurn[]; requests: ChatRequest[]; notices: string[];
  contextRecords?: import("@dewbow/core-protocol").SessionContext[];
}
export interface ChatDraft { text: string; mode: TurnMode }
export interface ChatContentState {
  status: "loading" | "ready" | "error"; text: string; nextCursor: string | null;
  bytesLoaded: number; completeness: ContentRef["completeness"]; error: string | null;
}
/** The host owns permission checks, request IDs, original input and all I/O. */
export interface ChatViewProps {
  hideComposer?: boolean;
  userLabel?: string | undefined;
  model: ChatModel; draft: ChatDraft; onDraftChange: (draft: ChatDraft) => void;
  composer: { action: "send" | "steer" | "retry" | "disabled"; turnId: string | null; mode: TurnMode; modeLocked: boolean; busy: boolean; reason: string | null; retryRequestKey: string | null };
  history: { loading: boolean; hasOlder: boolean; loadingOlder: boolean; error: string | null };
  contents: ReadonlyMap<string, ChatContentState>;
  loadingInteractions: ReadonlySet<string>;
  canRespond: (interaction: Interaction) => boolean;
  canSubmitInteraction: (interaction: Interaction) => boolean;
  canReadContent: (content: ContentRef) => boolean;
  contentReadsAvailable: boolean;
  operatorUrl?: string;
  onSend: (input: { message: string; mode: TurnMode }) => void;
  onSteer: (input: { message: string; turnId: string }) => void;
  onAnswer: (input: { turnId: string; interactionId: string; answers: QuestionAnswer[] }) => void;
  onDecideApproval: (input: { turnId: string; interactionId: string; decision: "allow" | "deny" }) => void;
  onInterrupt: (() => void) | null;
  onRetry: (requestKey: string) => void;
  onRetryMessage: (input: { requestKey: string; message: string }) => void;
  onCancelRetry: (() => void) | null;
  onLoadOlder: () => void;
  onLoadContent: (content: ContentRef, action: "first" | "more" | "refresh") => void;
  onLoadInteraction: (interaction: Interaction) => void;
}
