import { contractVersion, validateInput } from "@dewbow/team-protocol";
import type { CoreApi } from "./core-client.js";
import { TeamManagement } from "./management.js";
import { SessionService } from "./session-service.js";
import { ChannelRuntime } from "./channels/runtime.js";
import type { ChannelCredentials } from "./channels/adapter.js";
import { TeamStore } from "./store.js";

const sessionOperations = new Set(["createAgentSession", "listWorkspaceProfiles", "listHosts","createMemberSession","listSessionBindings","getSessionBinding","retrySessionBindingCreation","connectSessionBinding","sendBindingMessage","steerBindingTurn","answerBindingQuestions","interruptBindingTurn","readBindingHistory","getBindingActivity","readBindingContent"]);

const channelOperations = new Set(["getChannels", "createChatbot", "updateChatbot", "createChannelConnection", "updateChannelConnection", "bindChannelConversation", "retryChannelDelivery"]);
export class TeamApi {
  readonly channels: ChannelRuntime;
  private readonly management: TeamManagement;
  private readonly sessions: SessionService;

  constructor(store: TeamStore, readonly core: CoreApi, credentials: ChannelCredentials[] = []) {
    this.management = new TeamManagement(store);
    this.sessions = new SessionService(store, core);
    this.channels = new ChannelRuntime(store, this.sessions, credentials);
  }

  execute(operation: string, rawInput: unknown, caller = "operator"): Promise<unknown> | unknown {
    const input = validateInput(operation, rawInput);
    if (operation === "getServiceInfo") return { contractVersion, coreConfigured: Boolean(this.core.url), coreUrl: this.core.url };
    if (channelOperations.has(operation)) return this.channels.execute(operation, input, caller);
    return sessionOperations.has(operation) ? this.sessions.execute(operation, input, caller) : this.management.execute(operation, input, caller);
  }
}
