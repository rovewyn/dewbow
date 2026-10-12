import type { ContentRef, Interaction, QuestionAnswer, SessionActivity, TurnMode, TurnState } from "@dewbow/core-protocol";

export interface ChatOrder { source: "native" | "event" | "unavailable"; value: number | null }
export interface ChatMessage {
  id: string; kind: "user" | "instruction" | "progress" | "final";
  text: string; createdAt: string; complete: boolean; restricted: boolean; order: ChatOrder;
}
export interface ChatProgress { id: string; text: string; order: ChatOrder }
export interface ChatTurn {
  key: string; turnId: string | null; nativeTurnId: string | null; state: TurnState | string | null;
  mode: TurnMode | null; messages: ChatMessage[]; progress: ChatProgress[];
  activities: SessionActivity[]; activityOrders: ReadonlyMap<string, ChatOrder>;
  interactions: Interaction[]; order: ChatOrder; orderIncomplete: boolean;
}
export interface ChatRequest {
  requestId: string; label: string; status: "accepted" | "delivered" | "error" | "unknown";
  error: string | null; canRetry: boolean;
}
export interface ChatModel {
  sessionKey: string; turns: ChatTurn[]; requests: ChatRequest[]; notices: string[];
}
export interface ChatDraft { text: string; mode: TurnMode }
export interface ChatContentState {
  status: "loading" | "ready" | "error"; text: string; nextCursor: string | null;
  bytesLoaded: number; completeness: ContentRef["completeness"]; error: string | null;
}
/** The host owns permission checks, request IDs, original input and all I/O. */
export interface ChatViewProps {
  model: ChatModel; draft: ChatDraft; onDraftChange: (draft: ChatDraft) => void;
  composer: { action: "send" | "steer" | "disabled"; turnId: string | null; mode: TurnMode; busy: boolean; reason: string | null };
  history: { loading: boolean; hasOlder: boolean; loadingOlder: boolean; error: string | null };
  contents: ReadonlyMap<string, ChatContentState>;
  loadingInteractions: ReadonlySet<string>;
  canRespond: (interaction: Interaction) => boolean;
  canReadContent: (content: ContentRef) => boolean;
  operatorUrl?: string;
  onSend: (input: { message: string; mode: TurnMode }) => void;
  onSteer: (input: { message: string; turnId: string }) => void;
  onAnswer: (input: { turnId: string; interactionId: string; answers: QuestionAnswer[] }) => void;
  onDecideApproval: (input: { turnId: string; interactionId: string; decision: "allow" | "deny" }) => void;
  onInterrupt: (() => void) | null;
  onRetry: (requestId: string) => void;
  onLoadOlder: () => void;
  onLoadContent: (content: ContentRef, action: "first" | "more" | "refresh") => void;
  onLoadInteraction: (interaction: Interaction) => void;
}
