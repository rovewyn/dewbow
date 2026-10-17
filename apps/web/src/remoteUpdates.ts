import type { RemoteSessionUpdates } from "@dewbow/protocol";
import type { RemoteTarget } from "./targets";

/** Each reconnected stream starts with a new snapshot; cursors never cross runtimes. */
export class RemoteUpdates {
  private subscription = "";
  private eventId = 0;
  private runtime = "";
  private history = "";
  private readonly target: RemoteTarget;
  private readonly sessionId: string;
  constructor(target: RemoteTarget, sessionId: string) { this.target = target; this.sessionId = sessionId; }
  consume(remote: RemoteSessionUpdates) {
    const target = this.target;
    if (remote.networkId !== target.networkId || remote.hostId !== target.hostId || remote.membershipId !== target.membershipId || remote.payload?.details.session.hostId !== target.hostId || remote.payload.details.session.sessionId !== this.sessionId || remote.payload.instanceId !== remote.runtimeId || !remote.subscriptionId || !remote.runtimeId || !remote.historyId || !Number.isSafeInteger(remote.eventId)) throw new Error("Remote update identity changed.");
    const reset = this.subscription !== remote.subscriptionId;
    if (reset) {
      if (remote.eventId !== 1) throw new Error("Remote snapshot missing.");
      this.subscription = remote.subscriptionId; this.eventId = 0; this.runtime = remote.runtimeId; this.history = remote.historyId;
    }
    if (remote.eventId !== this.eventId + 1 || this.runtime !== remote.runtimeId || this.history !== remote.historyId) throw new Error("Remote update order changed.");
    this.eventId = remote.eventId;
    return { value: remote.payload, reset };
  }
}
