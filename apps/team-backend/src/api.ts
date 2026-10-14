import { contractVersion, validateInput } from "@dewbow/team-protocol";
import type { CoreApi } from "./core-client.js";
import { TeamManagement } from "./management.js";
import { SessionService } from "./session-service.js";
import { ChannelRuntime } from "./channels/runtime.js";
import type { ChannelCredentials } from "./channels/adapter.js";
import { TeamStore } from "./store.js";
import { subscribeTeamUpdates } from "./updates.js";
import type { HistoryPosition } from "@dewbow/core-protocol";
import type { BindingUpdates, ChannelConversationUpdates } from "@dewbow/team-protocol";

const sessionOperations = new Set(["createAgentSession", "listWorkspaceProfiles", "listHosts","createMemberSession","listSessionBindings","getSessionBinding","retrySessionBindingCreation","connectSessionBinding","sendBindingMessage","steerBindingTurn","answerBindingQuestions","interruptBindingTurn","readBindingHistory","getBindingActivity","readBindingContent"]);

const channelOperations = new Set(["getChannels", "createChatbot", "updateChatbot", "createChannelConnection", "updateChannelConnection", "bindChannelConversation", "retryChannelDelivery", "closeChannelDelivery", "readChannelConversation", "beginChannelTakeover", "endChannelTakeover", "sendChannelMessage"]);
export class TeamApi {
  readonly channels: ChannelRuntime;
  private readonly management: TeamManagement;
  private readonly sessions: SessionService;

  constructor(private readonly store: TeamStore, readonly core: CoreApi, credentials: ChannelCredentials[] = []) {
    this.management = new TeamManagement(store);
    this.sessions = new SessionService(store, core);
    this.channels = new ChannelRuntime(store, this.sessions, credentials);
  }

  subscribe(operation: string, input: Record<string, unknown>, caller: string, emit: (event: "snapshot" | "update", value: BindingUpdates | ChannelConversationUpdates) => void, signal: AbortSignal): Promise<void> {
    const conversation = operation === "subscribeChannelConversationUpdates";
    if (!conversation && operation !== "subscribeBindingUpdates") throw new Error("Unknown subscription.");
    const target = conversation ? { conversationId: input.conversationId } : { bindingId: input.bindingId };
    validateInput(conversation ? "readChannelConversation" : "getSessionBinding", target);
    return subscribeTeamUpdates(this.store, this.sessions, this.channels, this.core, input as HistoryPosition & { bindingId?: string; conversationId?: string }, caller, emit, signal);
  }

  execute(operation: string, rawInput: unknown, caller = "operator"): Promise<unknown> | unknown {
    const input = validateInput(operation, rawInput);
    if (operation === "getServiceInfo") return { contractVersion, coreConfigured: Boolean(this.core.url), coreUrl: this.core.url };
    if (channelOperations.has(operation)) return this.channels.execute(operation, input, caller);
    return sessionOperations.has(operation) ? this.sessions.execute(operation, input, caller) : this.management.execute(operation, input, caller);
  }
}
