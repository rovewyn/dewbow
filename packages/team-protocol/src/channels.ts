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
}
export interface ChannelDelivery {
  deliveryId: string; conversationId: string; direction: "input" | "output";
  status: "pending" | "processing" | "unknown" | "completed" | "error";
  bindingId: string | null; turnId: string | null; operation: string | null; requestId: string | null;
  bodyRetained?: boolean; error: string | null; createdAt: string; updatedAt: string;
}
export interface ChannelState {
  chatbots: Chatbot[]; connections: (ChannelConnection & { status: string })[];
  conversations: ChannelConversation[]; deliveries: ChannelDelivery[];
  credentials: { credentialRef: string; corpId: string; robotCode: string }[];
}
