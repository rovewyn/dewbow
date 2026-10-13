import { DeliveryError, type ChannelCredentials, type IncomingMessage, type ReplyAddress } from "../adapter.js";

export interface StreamFrame { type: string; headers: { messageId: string; topic: string }; data: string }
export const robotTopic = "/v1.0/im/bot/messages/get";
export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export const makeAck = (frame: StreamFrame, code: number, message: string) => ({ code, headers: { messageId: frame.headers.messageId, contentType: "application/json" }, message, data: '{"response":null}' });
const identifier = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 4096;

export function parseMessage(frame: StreamFrame, credentials: ChannelCredentials): IncomingMessage | null {
  const value: unknown = JSON.parse(frame.data);
  if (!isRecord(value) || value.conversationType !== "1") return null;
  if (value.senderCorpId !== credentials.corpId || value.robotCode !== credentials.robotCode || !identifier(value.senderStaffId)
    || !identifier(value.conversationId) || !identifier(value.msgId)) throw new Error("Invalid channel identity.");
  const webhook = new URL(String(value.sessionWebhook));
  if (webhook.protocol !== "https:" || webhook.hostname !== "oapi.dingtalk.com" || webhook.pathname !== "/robot/sendBySession" || webhook.username || webhook.password || webhook.port) throw new Error("Invalid reply address.");
  if (typeof value.sessionWebhookExpiredTime !== "number" || !Number.isFinite(value.sessionWebhookExpiredTime)) throw new Error("Invalid reply expiration.");
  const text = value.msgtype === "text" && isRecord(value.text) && typeof value.text.content === "string" ? value.text.content : "/unsupported";
  if (text.length > 100000 || !text.trim()) throw new Error("Invalid message text.");
  return { messageId: value.msgId, corpId: credentials.corpId, userId: value.senderStaffId, conversationId: value.conversationId, text, webhook: webhook.href, expiresAt: value.sessionWebhookExpiredTime };
}

export function splitText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start, bytes = 0, paragraphEnd = 0, lineEnd = 0, sentenceEnd = 0, wordEnd = 0;
    while (end < text.length) {
      const width = text.codePointAt(end)! > 0xffff ? 2 : 1;
      const character = text.slice(end, end + width), size = Buffer.byteLength(character);
      if (bytes + size > 1500) break;
      end += width; bytes += size;
      if (character === "\n") {
        if (lineEnd && !text.slice(lineEnd, end - 1).trim()) paragraphEnd = end;
        lineEnd = end;
      } else if (/[。！？!?]/.test(character) || (character === "." && /\s/.test(text[end] ?? ""))) sentenceEnd = end;
      else if (sentenceEnd > start && sentenceEnd === end - width && /["'”’）)\]]/.test(character)) sentenceEnd = end;
      else if (character === " " || character === "\t") wordEnd = end;
    }
    // Keep all original whitespace and fall back to a code-point boundary only
    // when the size window contains no paragraph, line, sentence or word break.
    let boundary = end === text.length ? end : paragraphEnd || lineEnd || sentenceEnd || wordEnd || end;
    if (!text.slice(start, boundary).trim()) boundary = end;
    chunks.push(text.slice(start, boundary));
    start = boundary;
  }
  return chunks.length > 1 ? chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`) : chunks;
}

export class DingTalkSender {
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private tokenTasks = new Map<string, Promise<string>>();
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async post(url: string, body: unknown, signal: AbortSignal, token?: string): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), headers: { "Content-Type": "application/json", ...(token ? { "x-acs-dingtalk-access-token": token } : {}) }, body: JSON.stringify(body) }); }
    catch { throw new DeliveryError(true); }
    let value: unknown;
    try { value = await response.json(); } catch { throw new DeliveryError(true); }
    if (response.status >= 500 || !isRecord(value)) throw new DeliveryError(true);
    if (!response.ok || (typeof value.errcode === "number" && value.errcode !== 0)) throw new DeliveryError(false);
    return value;
  }
  private async token(credentials: ChannelCredentials, signal: AbortSignal): Promise<string> {
    const cached = this.tokens.get(credentials.credentialRef);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const existing = this.tokenTasks.get(credentials.credentialRef); if (existing) return existing;
    const task = (async () => {
      const value = await this.post("https://api.dingtalk.com/v1.0/oauth2/accessToken", { appKey: credentials.clientId, appSecret: credentials.clientSecret }, signal);
      if (!identifier(value.accessToken) || typeof value.expireIn !== "number") throw new DeliveryError(false);
      this.tokens.set(credentials.credentialRef, { token: value.accessToken, expiresAt: Date.now() + Math.max(0, value.expireIn - 300) * 1000 });
      return value.accessToken;
    })();
    this.tokenTasks.set(credentials.credentialRef, task);
    try { return await task; } finally { this.tokenTasks.delete(credentials.credentialRef); }
  }
  async send(credentials: ChannelCredentials, address: ReplyAddress, text: string, signal: AbortSignal): Promise<void> {
    if (address.corpId !== credentials.corpId || !identifier(address.userId)) throw new DeliveryError(false);
    if (address.expiresAt > Date.now() + 1000) {
      const url = new URL(address.webhook);
      if (url.protocol !== "https:" || url.hostname !== "oapi.dingtalk.com" || url.pathname !== "/robot/sendBySession") throw new DeliveryError(false);
      const result = await this.post(url.href, { msgtype: "text", text: { content: text } }, signal);
      if (result.errcode !== 0) throw new DeliveryError(true);
    } else {
      const token = await this.token(credentials, signal);
      const result = await this.post("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", { robotCode: credentials.robotCode, userIds: [address.userId], msgKey: "sampleText", msgParam: JSON.stringify({ content: text }) }, signal, token);
      if (!identifier(result.processQueryKey)) throw new DeliveryError(true);
    }
  }
}
