export interface ChannelCredentials { credentialRef: string; clientId: string; clientSecret: string; robotCode: string; corpId: string }
export interface IncomingMessage { messageId: string; corpId: string; userId: string; conversationId: string; text: string; webhook: string; expiresAt: number }
export interface ReplyAddress { corpId: string; userId: string; webhook: string; expiresAt: number }
export class DeliveryError extends Error {
  constructor(readonly uncertain: boolean, message = "Platform message delivery failed.") { super(message); }
}
export interface ChannelAdapter {
  run(credentials: ChannelCredentials, receive: (message: IncomingMessage) => Promise<void>, signal: AbortSignal): Promise<void>;
  send(credentials: ChannelCredentials, address: ReplyAddress, text: string, signal: AbortSignal): Promise<void>;
}
