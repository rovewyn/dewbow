import { contractVersion, validateInput } from "@dewbow/team-protocol";
import type { CoreApi } from "./core-client.js";
import { TeamManagement } from "./management.js";
import { MemberSessions } from "./member-sessions.js";
import { TeamStore } from "./store.js";

const sessionOperations = new Set(["listHosts", "createMemberSession", "listSessionBindings", "getSessionBinding", "retryMemberSessionCreation", "connectMemberSession", "sendMemberMessage", "interruptMemberTurn", "readMemberSessionHistory", "getMemberSessionActivity", "readMemberSessionContent"]);

export class TeamApi {
  private readonly management: TeamManagement;
  private readonly sessions: MemberSessions;

  constructor(store: TeamStore, readonly core: CoreApi) {
    this.management = new TeamManagement(store);
    this.sessions = new MemberSessions(store, core);
  }

  execute(operation: string, rawInput: unknown, caller = "operator"): Promise<unknown> | unknown {
    const input = validateInput(operation, rawInput);
    if (operation === "getServiceInfo") return { contractVersion, coreConfigured: Boolean(this.core.url), coreUrl: this.core.url };
    return sessionOperations.has(operation) ? this.sessions.execute(operation, input, caller) : this.management.execute(operation, input, caller);
  }
}
