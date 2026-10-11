import type { Host, SessionSummary } from "@dewbow/protocol";

export interface SessionTreeNode {
  id: string;
  kind: "host" | "session";
  title: string;
  sessionId: string | null;
  statusLabel: string;
  statusTone: "neutral" | "positive" | "running" | "warning" | "danger";
  metadata: string[];
  searchText: string;
  parentWarning: string | null;
  children: SessionTreeNode[];
}

export interface SessionTreeModel {
  nodes: SessionTreeNode[];
  hostIds: string[];
  sessionCount: number;
  matchCount: number;
  query: string;
  selected: SessionTreeNode | null;
  selectedPath: string[];
}

const statusLabels = {
  idle: "Idle", running: "Running", awaiting_approval: "Approval",
  interrupted: "Interrupted", error: "Execution error", unknown: "Unknown",
};
const statusTones = {
  idle: "neutral", running: "running", awaiting_approval: "warning",
  interrupted: "neutral", error: "danger", unknown: "neutral",
} as const;

/** Native lineage IDs are scoped to both host and Codex home, not management IDs. */
export function buildSessionTree(hosts: Host[], sessions: SessionSummary[]): SessionTreeNode[] {
  const hostNodes = new Map(hosts.map(host => [host.hostId, {
    id: `host:${host.hostId}`, kind: "host" as const, title: host.name,
    sessionId: null, statusLabel: { connected: "Online", disconnected: "Offline", revoked: "Revoked" }[host.status],
    statusTone: host.status === "connected" ? "positive" as const : host.status === "revoked" ? "danger" as const : "neutral" as const,
    metadata: [host.hostId, `Last seen: ${host.lastSeenAt ? new Date(host.lastSeenAt).toLocaleString() : "Not yet observed"}`],
    searchText: "", parentWarning: null, children: [] as SessionTreeNode[],
  }]));
  const nodes = new Map<string, SessionTreeNode>();
  const nativeIndex = new Map<string, string[]>();
  const nativeKey = (host: string, home: string, id: string) => JSON.stringify([host, home, id]);
  for (const session of sessions) {
    if (!hostNodes.has(session.hostId)) hostNodes.set(session.hostId, {
      id: `host:${session.hostId}`, kind: "host", title: session.hostId,
      sessionId: null, statusLabel: "Unknown", statusTone: "neutral",
      metadata: ["Host is absent from the current host inventory"], searchText: "",
      parentWarning: null, children: [],
    });
    const connectionLabel = { disconnected: "Not connected", connecting: "Connecting", connected: "Connected", error: "Connection failed" }[session.connectionState];
    const connectionHint = session.connectionState === "error" || session.connectionState === "connecting";
    nodes.set(session.sessionId, {
      id: `session:${session.sessionId}`, kind: "session", title: session.name,
      sessionId: session.sessionId, statusLabel: connectionHint ? connectionLabel : statusLabels[session.runtimeState],
      statusTone: connectionHint ? "warning" : statusTones[session.runtimeState],
      metadata: [hostNodes.get(session.hostId)!.title, connectionLabel, `Runtime: ${statusLabels[session.runtimeState]}`,
        ...(session.native?.archived ? ["Archived"] : []),
        ...(session.native?.forkedFromId ? [`Forked from: ${session.native.forkedFromId}`] : []),
        ...(session.managed && session.runtimeState === "unknown" ? [`Last known: ${statusLabels[session.lastKnownState]}`] : []),
        ...(session.workDir ? [session.workDir] : []), session.sessionId],
      searchText: [session.name, session.workDir, session.sessionId, session.codexThreadId].filter(Boolean).join("\n").toLowerCase(),
      parentWarning: null, children: [],
    });
    const home = session.native?.codexHome ?? session.codexHome;
    const nativeId = session.native?.id ?? session.codexThreadId;
    if (home && nativeId) {
      const key = nativeKey(session.hostId, home, nativeId);
      nativeIndex.set(key, [...(nativeIndex.get(key) ?? []), session.sessionId]);
    }
  }
  const parents = new Map<string, string>();
  for (const session of sessions) {
    if (!session.native?.parentId) continue;
    const matches = nativeIndex.get(nativeKey(session.hostId, session.native.codexHome, session.native.parentId)) ?? [];
    if (matches.length === 1) parents.set(session.sessionId, matches[0]!);
    else nodes.get(session.sessionId)!.parentWarning = matches.length ? "Parent relationship is ambiguous" : "Parent session unavailable";
  }
  // Break every cycle before linking nodes so malformed inventory cannot hide a branch.
  const checked = new Set<string>();
  for (const id of nodes.keys()) {
    const path: string[] = [], positions = new Map<string, number>();
    let current: string | undefined = id;
    while (current !== undefined && !checked.has(current)) {
      const cycleStart = positions.get(current);
      if (cycleStart !== undefined) {
        for (const member of path.slice(cycleStart)) {
          parents.delete(member);
          nodes.get(member)!.parentWarning = "Parent relationship contains a cycle";
        }
        break;
      }
      positions.set(current, path.length); path.push(current); current = parents.get(current);
    }
    for (const member of path) checked.add(member);
  }
  for (const session of sessions) {
    const node = nodes.get(session.sessionId)!;
    const parentId = parents.get(session.sessionId);
    const parent = parentId ? nodes.get(parentId)! : hostNodes.get(session.hostId)!;
    parent.children.push(node);
  }
  return [...hostNodes.values()];
}

/** Keep matches and their ancestor paths; selection always refers to the unfiltered tree. */
export function projectSessionTree(nodes: SessionTreeNode[], search: string, selectedId: string): SessionTreeModel {
  const query = search.trim().toLowerCase();
  let sessionCount = 0, matchCount = 0, selected: SessionTreeNode | null = null;
  let selectedPath: string[] = [];
  function visit(node: SessionTreeNode, ancestors: string[]): SessionTreeNode | null {
    if (node.kind === "session") {
      sessionCount++;
      if (node.sessionId === selectedId) { selected = node; selectedPath = ancestors; }
    }
    const matched = node.kind === "session" && (!query || node.searchText.includes(query));
    if (matched) matchCount++;
    const children = node.children.map(child => visit(child, [...ancestors, node.id])).filter(child => child !== null);
    return !query || matched || children.length ? { ...node, children } : null;
  }
  const visible = nodes.map(node => visit(node, [])).filter(node => node !== null);
  return { nodes: visible, hostIds: nodes.map(node => node.id), sessionCount, matchCount, query, selected, selectedPath };
}
