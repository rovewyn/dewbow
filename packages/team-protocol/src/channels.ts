export interface Chatbot {
  chatbotId: string; name: string; definitionId: string; hostId: string; workspaceProfileId: string;
  enabled: boolean; createdAt: string; updatedAt: string;
}
export interface ChannelConnection {
  connectionId: string; chatbotId: string; platform: "dingtalk"; credentialRef: string; accountId: string; corpId: string;
  enabled: boolean; createdAt: string; updatedAt: string;
}
export interface ChannelConversation {
  conversationId: string; connectionId: string; corpId: string; userId: string; definitionId: string;
  externalConversationId: string; bindingId: string | null; pendingBindingId: string | null;
  generation: number; updatedAt: string;
  mode?: "automatic" | "human"; takeoverId?: string | null;
}
export interface ChannelTakeover {
  takeoverId: string; conversationId: string; bindingId: string;
  phase: "pausing" | "interrupting" | "active" | "syncing" | "resuming" | "ended";
  pauseId: string | null; interruptTurnId: string | null; endSequence: number | null;
  createdAt: string; endedAt: string | null; error: string | null;
}
export interface ChannelContextRecord {
  contextId: string; conversationId: string; bindingId: string; segmentId: string;
  source: "takeoverStart" | "user" | "operator" | "takeoverEnd";
  sequence: number; createdAt: string; syncStatus: "pending" | "unknown" | "confirmed"; error: string | null;
  text?: string;
}
export interface ChannelConversationDetails {
  conversation: ChannelConversation; takeovers: ChannelTakeover[]; records: ChannelContextRecord[];
  deliveries: ChannelDelivery[]; corePause: "paused" | "externallyResumed" | "unknown" | "unpaused";
}
export interface ChannelDelivery {
  deliveryId: string; conversationId: string; direction: "input" | "output";
  status: "pending" | "processing" | "unknown" | "completed" | "error" | "suppressed";
  source?: "agent" | "operator"; suppressed?: boolean; contextId?: string;
  closedAt?: string; outcomeUnknown?: boolean;
  bindingId: string | null; turnId: string | null; operation: string | null; requestId: string | null;
  bodyRetained?: boolean; error: string | null; createdAt: string; updatedAt: string;
}
export interface ChannelState {
  chatbots: Chatbot[]; connections: (ChannelConnection & { status: string })[];
  conversations: ChannelConversation[]; deliveries: ChannelDelivery[];
  credentials: { credentialRef: string; corpId: string; robotCode: string }[];
}
