import type { Host } from "@dewbow/protocol";
import type { Detail } from "../api";

export function SessionDetails({ detail, hosts }: { detail: Detail; hosts: Host[] }) {
  const session = detail.session;
  const activeTurn = detail.turns.find(turn => turn.turnId === session.activeTurnId);
  const config = session.sessionConfig?.resolved;
  return <div className="details-body">
    <section aria-labelledby="context-title">
      <h3 id="context-title">Context</h3>
      <dl>
        <dt>Working directory</dt><dd className="mono">{session.workDir ?? "Not available"}</dd>
        <dt>Host</dt><dd>{hosts.find(host => host.hostId === session.hostId)?.name ?? session.hostId}</dd>
        <dt>Connection</dt><dd>{session.connectionState === "error" ? "failed" : session.connectionState}</dd>
        <dt>Runtime</dt><dd>{session.runtimeState.replaceAll("_", " ")}</dd>
        <dt>Current turn</dt><dd>{activeTurn?.state.replaceAll("_", " ") ?? "No active turn"}</dd>
        {activeTurn && <><dt>Turn mode</dt><dd>{activeTurn.mode === "plan" ? "Plan" : "Default"}</dd></>}
      </dl>
    </section>
    {config && <section aria-labelledby="config-title">
      <h3 id="config-title">Configuration snapshot</h3>
      <dl>
        <dt>Model</dt><dd>{config.model}</dd>
        <dt>Provider</dt><dd>{config.modelProvider}</dd>
        <dt>Reasoning effort</dt><dd>{config.reasoningEffort ?? "Default"}</dd>
        <dt>Approval policy</dt><dd>{config.approvalPolicy}</dd>
      </dl>
    </section>}
    {session.native && <section aria-labelledby="native-title">
      <h3 id="native-title">Native runtime</h3>
      <dl>
        <dt>Status</dt><dd>{session.native.runtimeStatus}</dd>
        <dt>Writer lock</dt><dd>{session.native.hasActiveWriter === null ? "unknown" : session.native.hasActiveWriter ? "held" : "free"}</dd>
      </dl>
    </section>}
    <section aria-labelledby="delivery-title">
      <h3 id="delivery-title">Request delivery</h3>
      {detail.operations.length ? <><p>{detail.operations.length} recorded request{detail.operations.length === 1 ? "" : "s"}</p><p className="muted">Inspect request delivery in the conversation for results and original-input retries.</p></> : <p className="muted">No requests recorded.</p>}
    </section>
    <details className="technical-details">
      <summary>Technical identifiers</summary>
      <dl>
        <dt>Session ID</dt><dd className="mono">{session.sessionId}</dd>
        <dt>Host ID</dt><dd className="mono">{session.hostId}</dd>
        <dt>Native conversation ID</dt><dd className="mono">{session.codexThreadId ?? "Not connected"}</dd>
      </dl>
    </details>
  </div>;
}
