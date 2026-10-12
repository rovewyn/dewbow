import { createHash } from "node:crypto";
import { fail, type ChannelConversation, type ChannelDelivery, type Chatbot, type ChannelConnection } from "@dewbow/team-protocol";
import { TeamStore } from "../store.js";
import type { ReplyAddress } from "./adapter.js";

export const key = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export interface Delivery extends ChannelDelivery { text: string | null; payload: Record<string, unknown> | null }
export interface Conversation extends ChannelConversation { address: ReplyAddress }
export interface Watch { watchId: string; conversationId: string; bindingId: string; turnId: string; eventCursor: number; updateCursor: string | null; beforeCursor: string | null; complete: boolean }
export interface Question { token: string; conversationId: string; bindingId: string; turnId: string; interactionId: string; questionId: string; options: string[]; allowCustom: boolean; answer: string[] | null; expiresAt: number }
type Table = "channel_chatbots" | "channel_connections" | "channel_conversations" | "channel_deliveries" | "channel_turns" | "channel_questions";

export class ChannelStore {
  constructor(readonly team: TeamStore) {
    team.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_chatbots (id TEXT PRIMARY KEY, definition_id TEXT REFERENCES agent_definitions(definition_id), data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_connections (id TEXT PRIMARY KEY, chatbot_id TEXT NOT NULL REFERENCES channel_chatbots(id), credential_ref TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_conversations (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES channel_connections(id), data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_binding_claims (binding_id TEXT PRIMARY KEY REFERENCES session_bindings(binding_id), conversation_id TEXT NOT NULL REFERENCES channel_conversations(id));
      CREATE TABLE IF NOT EXISTS channel_deliveries (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES channel_conversations(id), data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_turns (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_questions (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_runtime_leases (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, lease_until INTEGER NOT NULL);
    `);
  }
  list<T>(table: Table): T[] { return (this.team.db.prepare(`SELECT data_json FROM ${table} ORDER BY rowid`).all() as { data_json: string }[]).map(row => JSON.parse(row.data_json)); }
  get<T>(table: Table, id: string): T | null { const row = this.team.db.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id) as { data_json: string } | undefined; return row ? JSON.parse(row.data_json) : null; }
  put(table: Table, id: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (table === "channel_chatbots") { const bot = value as Chatbot; this.team.db.prepare("INSERT INTO channel_chatbots VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET definition_id=excluded.definition_id,data_json=excluded.data_json").run(id, bot.definitionId === "default" ? null : bot.definitionId, json); }
    else if (table === "channel_connections") { const connection = value as ChannelConnection; this.team.db.prepare("INSERT INTO channel_connections VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET credential_ref=excluded.credential_ref,data_json=excluded.data_json").run(id, connection.chatbotId, connection.credentialRef, json); }
    else if (table === "channel_conversations" || table === "channel_deliveries") {
      const relation = table === "channel_conversations" ? (value as Conversation).connectionId : (value as Delivery).conversationId;
      this.team.db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json`).run(id, relation, json);
    } else this.team.db.prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json`).run(id, json);
  }
  claim(bindingId: string, conversationId: string): void {
    const old = this.team.db.prepare("SELECT conversation_id FROM channel_binding_claims WHERE binding_id=?").get(bindingId) as { conversation_id: string } | undefined;
    if (old && old.conversation_id !== conversationId) fail("BINDING_IN_USE", "This session belongs to another channel identity.");
    this.team.db.prepare("INSERT OR IGNORE INTO channel_binding_claims VALUES(?,?)").run(bindingId, conversationId);
  }
  output(conversation: Conversation, id: string, text: string, bindingId: string | null = null, turnId: string | null = null): void {
    if (this.get("channel_deliveries", id)) return;
    const timestamp = new Date().toISOString();
    this.put("channel_deliveries", id, { deliveryId: id, conversationId: conversation.conversationId, direction: "output", status: "pending", text, payload: null, bindingId, turnId, operation: null, requestId: null, error: null, createdAt: timestamp, updatedAt: timestamp } satisfies Delivery);
  }
  recover(): void {
    for (const delivery of this.list<Delivery>("channel_deliveries")) if (delivery.status === "processing") {
      delivery.status = "unknown"; delivery.error = "Delivery was interrupted. Reconcile or retry the original request.";
      this.put("channel_deliveries", delivery.deliveryId, delivery);
    }
  }
  purgeQuestions(): void { this.team.db.prepare("DELETE FROM channel_questions WHERE json_extract(data_json,'$.expiresAt') < ?").run(Date.now()); }
  clearAnswers(conversationId: string, interactionId: string): void {
    this.team.db.prepare("DELETE FROM channel_questions WHERE json_extract(data_json,'$.conversationId')=? AND json_extract(data_json,'$.interactionId')=?").run(conversationId, interactionId);
  }
  acquireLease(ownerId: string): void {
    const result = this.team.db.prepare("INSERT INTO channel_runtime_leases VALUES('runtime',?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,lease_until=excluded.lease_until WHERE lease_until < ? OR owner_id=?").run(ownerId, Date.now() + 30000, Date.now(), ownerId);
    if (!Number(result.changes)) fail("CHANNEL_IN_USE", "Another Team process owns these channel connections.");
  }
  renewLease(ownerId: string): boolean { return Boolean(this.team.db.prepare("UPDATE channel_runtime_leases SET lease_until=? WHERE id='runtime' AND owner_id=?").run(Date.now() + 30000, ownerId).changes); }
  ownsLease(ownerId: string): boolean { return Boolean(this.team.db.prepare("SELECT 1 FROM channel_runtime_leases WHERE id='runtime' AND owner_id=? AND lease_until>?").get(ownerId, Date.now())); }
  releaseLease(ownerId: string): void { this.team.db.prepare("DELETE FROM channel_runtime_leases WHERE owner_id=?").run(ownerId); }
}
