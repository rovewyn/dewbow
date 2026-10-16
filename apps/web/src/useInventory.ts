import { useEffect, useState } from "react";
import type { Host, NetworkJoin, NetworkMember, NetworkStatus, SessionSummary } from "@dewbow/protocol";
import { api, ApiError } from "./api";
import type { SessionEntry } from "./targets";

export function useInventory(authenticated: boolean, expired: () => void) {
  const [hosts, setHosts] = useState<Host[]>([]), [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [status, setStatus] = useState<NetworkStatus | null>(null), [members, setMembers] = useState<NetworkMember[]>([]), [joins, setJoins] = useState<NetworkJoin[]>([]);
  const [connectionError, setConnectionError] = useState(""), [discoveryError, setDiscoveryError] = useState("");
  const [revision, setRevision] = useState(0), [localHostId, setLocalHostId] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!authenticated) { setHosts([]); setSessions([]); setMembers([]); setJoins([]); setStatus(null); setReady(false); return; }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const signal = controller.signal;
    async function poll() {
      try {
        const failures: string[] = [];
        const [local, localSessions, network] = await Promise.all([
          api<{ hosts: Host[] }>("listHosts", {}, signal),
          api<{ sessions: SessionSummary[]; discovery: { hostId: string; error: { message: string } | null }[] }>("listSessions", {}, signal),
          api<NetworkStatus>("getNetwork", {}, signal).catch(cause => { if (cause instanceof ApiError && cause.detail.code === "UNAUTHORIZED") throw cause; failures.push("Network status unavailable."); return null; }),
        ]);
        if (signal.aborted) return;
        setStatus(network); setLocalHostId(local.hosts[0]?.hostId ?? ""); setConnectionError("");
        const networkId = network?.networkId;
        const active = network?.localStatus === "active" && networkId;
        const [membership, pending] = active ? await Promise.all([
          api<{ members: NetworkMember[] }>("listNetworkMembers", { networkId }, signal),
          api<{ joins: NetworkJoin[] }>("listNetworkJoins", { networkId }, signal),
        ]).catch(cause => { if (cause instanceof ApiError && cause.detail.code === "UNAUTHORIZED") throw cause; failures.push("Network membership changed or is unavailable."); return [{ members: [] as NetworkMember[] }, { joins: [] as NetworkJoin[] }] as const; }) : [{ members: [] }, { joins: [] }];
        if (signal.aborted) return;
        setMembers(membership.members); setJoins(pending.joins); setReady(true);
        const resultHosts = local.hosts.map(host => ({ ...host, name: `${host.name} · This machine` })), resultSessions: SessionEntry[] = [...localSessions.sessions];
        failures.push(...localSessions.discovery.filter(item => item.error).map(item => `${item.hostId}: ${item.error!.message}`));
        const currentMembers = new Set(membership.members.filter(member => !member.isSelf).map(member => member.hostId));
        setHosts(previous => [...resultHosts, ...previous.filter(host => currentMembers.has(host.hostId))]);
        setSessions(previous => [...localSessions.sessions, ...previous.filter(session => session.target?.networkId === networkId && membership.members.some(member => member.hostId === session.hostId && member.membershipId === session.target?.membershipId))]);
        const queue = membership.members.filter(member => !member.isSelf);
        // Two workers bound native inventory work. Each target fails independently.
        async function worker() {
          while (queue.length && !signal.aborted) {
            const member = queue.shift()!;
            const target = { networkId: networkId!, hostId: member.hostId, membershipId: member.membershipId };
            const targetAbort = new AbortController();
            try {
              const targetSignal = AbortSignal.any([signal, targetAbort.signal, AbortSignal.timeout(12000)]);
              const [remote, inventory] = await Promise.all([
                api<{ hosts: Host[] }>("listHosts", { networkId, hostId: member.hostId }, targetSignal),
                api<{ sessions: SessionSummary[] }>("listSessions", { networkId, hostId: member.hostId }, targetSignal),
              ]);
              if (remote.hosts.length !== 1 || remote.hosts[0]?.hostId !== member.hostId || inventory.sessions.some(session => session.hostId !== member.hostId)) throw new Error("Target inventory identity changed.");
              const targetHosts = remote.hosts.map(host => ({ ...host, name: `${host.name} · ${member.hostId.slice(0, 8)}` })), targetSessions = inventory.sessions.map(session => ({ ...session, target }));
              resultHosts.push(...targetHosts); resultSessions.push(...targetSessions);
              if (!signal.aborted) { setHosts(previous => [...previous.filter(host => host.hostId !== member.hostId), ...targetHosts]); setSessions(previous => [...previous.filter(session => session.hostId !== member.hostId), ...targetSessions]); }
            } catch (cause) {
              if (signal.aborted) return;
              resultHosts.push({ hostId: member.hostId, name: member.hostId, status: "disconnected", lastSeenAt: null });
              failures.push(`${member.hostId}: ${cause instanceof Error ? cause.message : "Unavailable"}`);
            } finally {
              targetAbort.abort();
            }
          }
        }
        await Promise.all([worker(), worker()]);
        if (signal.aborted) return;
        setHosts(resultHosts); setSessions(resultSessions); setDiscoveryError(failures.join(" · "));
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError && cause.detail.code === "UNAUTHORIZED") expired();
        else { setConnectionError(cause instanceof Error ? cause.message : "Inventory unavailable."); setMembers([]); setReady(true); }
      }
      if (!signal.aborted) timer = setTimeout(() => { void poll(); }, 10000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [authenticated, revision, expired]);
  return { hosts, sessions, setHosts, setSessions, status, members, joins, connectionError, discoveryError, localHostId, ready, refresh: () => setRevision(value => value + 1) };
}
