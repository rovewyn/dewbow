import { useEffect, useRef, useState } from "react";
import type { NetworkInvitation, NetworkJoin, NetworkMember, NetworkStatus } from "@dewbow/protocol";
import { Button, Input, NativeSelect, NativeSelectOption, Textarea } from "@dewbow/ui/ui";
import { api, ApiError } from "./api";

interface Props { open: boolean; close: () => void; status: NetworkStatus | null; members: NetworkMember[]; joins: NetworkJoin[]; refresh: () => void }
interface Attempt { operation: string; input: Record<string, unknown> }
export function NetworkDialog({ open, close, status, members, joins, refresh }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), returnFocus = useRef<HTMLElement | null>(null), alive = useRef(true);
  const visible = useRef(open); visible.current = open;
  const removalTrigger = useRef<HTMLButtonElement | null>(null), confirmation = useRef<HTMLElement | null>(null);
  const [page, setPage] = useState("members"), [name, setName] = useState(""), [token, setToken] = useState("");
  const [listen, setListen] = useState(""), [addresses, setAddresses] = useState("");
  const [invitation, setInvitation] = useState<NetworkInvitation | null>(null), [joinResult, setJoinResult] = useState<NetworkJoin | null>(null);
  const [removal, setRemoval] = useState<(NetworkMember & { networkId: string }) | null>(null), [addressMember, setAddressMember] = useState(""), [address, setAddress] = useState("");
  const [confirmed, setConfirmed] = useState(new Set<string>()), [attempt, setAttempt] = useState<Attempt | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) {
      returnFocus.current = document.activeElement as HTMLElement;
      setListen(status?.peerSettings.listenEndpoint ?? ""); setAddresses(status?.peerSettings.advertisedEndpoints.join("\n") ?? "");
      dialog.current?.showModal();
    } else if (!open) {
      dialog.current?.close(); setInvitation(null); setRemoval(null); setToken(""); setConfirmed(new Set());
      returnFocus.current?.focus({ preventScroll: true });
    }
  }, [open]);
  const active = status?.localStatus === "active", networkId = status?.networkId;
  useEffect(() => { if (removal) { confirmation.current?.focus(); confirmation.current?.scrollIntoView({ block: "nearest" }); } }, [removal]);
  useEffect(() => { setInvitation(null); setRemoval(null); setConfirmed(new Set()); }, [status?.networkId, status?.membershipId]);
  useEffect(() => {
    let cancelled = false; setFingerprint("");
    const key = status?.joiningPublicKey;
    if (key) {
      const bytes = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
      void crypto.subtle.digest("SHA-256", bytes).then(hash => { if (!cancelled) setFingerprint(`sha256:${btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`); });
    }
    return () => { cancelled = true; };
  }, [status?.joiningPublicKey]);
  async function execute(next: Attempt) {
    if (busy) return;
    const recovering = attempt === next;
    setBusy(true); setAttempt(next); setError(""); setNotice("");
    try {
      const result = await api<Record<string, unknown>>(next.operation, next.input);
      if (!alive.current) return;
      setAttempt(null); setNotice("Applied locally. Propagation is shown separately below.");
      if (next.operation === "createInvitation" && visible.current) setInvitation(result as unknown as NetworkInvitation);
      if (next.operation === "joinNetwork") { setJoinResult(result as unknown as NetworkJoin); setToken(""); setNotice("Join submitted. Wait for exact-key confirmation and verified admission."); }
      setRemoval(null); refresh();
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : "Network request failed.");
      if (cause instanceof ApiError && !cause.detail.retryable && !recovering) setAttempt(null);
    } finally { if (alive.current) setBusy(false); }
  }
  const run = (operation: string, input: Record<string, unknown> = {}) => void execute({ operation, input: { ...input, requestId: crypto.randomUUID() } });
  const settings = () => ({ ...(listen.trim() ? { listenEndpoint: listen.trim() } : {}), ...(addresses.trim() ? { advertisedEndpoints: addresses.split(/\n/).map(value => value.trim()).filter(Boolean) } : {}) });
  return <dialog ref={dialog} className="network-dialog" aria-labelledby="network-title" onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
    <header className="details-heading"><h2 id="network-title">Network</h2><Button variant="ghost" onClick={close} aria-label="Close Network">Close</Button></header>
    <nav className="network-pages" aria-label="Network management">{[["members", "Status & members"], ["invitations", `Invitations & joins${joins.length ? ` (${joins.length})` : ""}`], ["setup", "Create or join"]].map(([key, label]) => <Button key={key} variant={page === key ? "secondary" : "ghost"} aria-pressed={page === key} onClick={() => setPage(key!)}>{label}</Button>)}</nav>
    <div className="network-body">
      {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      {attempt && <div className="network-pending"><p>{busy ? "Submitting" : "Unresolved request"}: {attempt.operation} · {String(attempt.input.requestId)}</p><Button disabled={busy} onClick={() => void execute(attempt)}>Retry the same request</Button></div>}
      {page === "members" && <>
        <h3>{status?.networkName ?? "This machine"}</h3><p>Membership: <strong>{status?.localStatus ?? "Loading"}</strong> · Peer listener: {status?.peerListenerStatus ?? "Unknown"}</p>
        {networkId && <p className="network-identity">{networkId}</p>}
        <p>Every active member has the same authority. Reachability is an observation; an unreachable member remains a member.</p>
        {members.map(member => <section key={member.membershipId} className="network-member">
          <h4>{member.isSelf ? "This machine" : member.hostId}</h4><p>Member · {member.reachability}</p><p className="network-identity">{member.membershipId}</p>
          <p className="network-identity">{member.endpoints.join(" · ") || "No known contact address"}</p>
          <Button variant="outline" disabled={!active || busy || Boolean(attempt)} onClick={event => { removalTrigger.current = event.currentTarget; setRemoval({ ...member, networkId: networkId! }); }}>{member.isSelf ? "Leave Network" : "Remove member"}</Button>
        </section>)}
        {removal && <section ref={confirmation} tabIndex={-1} className="network-confirm" aria-label="Confirm removal"><h4>{removal.isSelf ? "Leave this Network?" : "Remove this member?"}</h4><p className="network-identity">{removal.hostId}<br />{removal.membershipId}</p><p>This takes effect locally without target consent. Existing conversations and admitted tasks remain. Other nodes apply the change when they receive it.</p><Button disabled={busy || Boolean(attempt)} onClick={() => run("removeNetworkMember", { networkId: removal.networkId, membershipId: removal.membershipId })}>Confirm {removal.isSelf ? "exit" : "removal"}</Button><Button variant="ghost" onClick={() => { setRemoval(null); requestAnimationFrame(() => removalTrigger.current?.focus({ preventScroll: true })); }}>Cancel</Button></section>}
        {active && <form className="form-body" onSubmit={event => { event.preventDefault(); run("setNetworkPeerAddress", { networkId, membershipId: addressMember, endpoint: address }); }}>
          <h3>Contact address</h3><label htmlFor="contact-member">Member</label><NativeSelect id="contact-member" required value={addressMember} onChange={event => setAddressMember(event.target.value)}><NativeSelectOption value="">Select member</NativeSelectOption>{members.filter(member => !member.isSelf).map(member => <NativeSelectOption key={member.membershipId} value={member.membershipId}>{member.hostId}</NativeSelectOption>)}</NativeSelect>
          <label htmlFor="contact-address">Reachable HTTPS Peer address</label><Input id="contact-address" type="url" required value={address} placeholder="https://192.0.2.12:7443" onChange={event => setAddress(event.target.value)} /><Button disabled={busy || Boolean(attempt)}>Save address</Button>
        </form>}
        <h3>Propagation</h3><p>Confirmations cover known recipients only. They do not prove that every offline or undiscovered node received the change.</p>
        <ul className="network-propagation">{status?.dissemination.map((item, index) => <li key={`${item.kind}:${item.membershipId}:${index}`}><span>{item.kind} · {item.status}</span><code>{item.membershipId}</code></li>)}</ul>
      </>}
      {page === "invitations" && <>
        <p>Share an invitation through a trusted channel, then compare the joining machine's full public key before allowing admission. Invitations expire after ten minutes and permit one admission.</p>
        <Button disabled={!active || busy || Boolean(attempt)} onClick={() => run("createInvitation", { networkId })}>Create invitation</Button>
        {invitation && <section><p>Invitation: {invitation.status} · Expires {new Date(invitation.expiresAt).toLocaleString()}</p>{invitation.invitation && <><label htmlFor="network-invitation">Invitation credential</label><Textarea id="network-invitation" readOnly value={invitation.invitation} /><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(invitation.invitation!).then(() => setNotice("Invitation copied.")).catch(() => setError("Copy unavailable. Select and copy the invitation field.")); }}>Copy invitation</Button></>}</section>}
        <h3>Pending confirmation</h3>{!joins.length && <p>No pending joins on this machine.</p>}
        {joins.map(join => <section key={join.joinAttemptId} className="network-member"><h4>{join.hostId}</h4><p className="network-identity">Attempt: {join.joinAttemptId}<br />Public key: {join.publicKey}<br />Fingerprint: {join.publicKeyFingerprint}</p>
          <label className="network-check"><input type="checkbox" checked={confirmed.has(join.joinAttemptId)} onChange={event => setConfirmed(previous => { const next = new Set(previous); if (event.target.checked) next.add(join.joinAttemptId); else next.delete(join.joinAttemptId); return next; })} />I compared this full key with the joining machine.</label>
          <Button disabled={busy || Boolean(attempt) || !confirmed.has(join.joinAttemptId)} onClick={() => run("confirmNetworkJoin", { networkId, joinAttemptId: join.joinAttemptId, publicKey: join.publicKey, decision: "allow" })}>Allow join</Button><Button variant="outline" disabled={busy || Boolean(attempt)} onClick={() => run("confirmNetworkJoin", { networkId, joinAttemptId: join.joinAttemptId, publicKey: join.publicKey, decision: "deny" })}>Deny join</Button>
        </section>)}
      </>}
      {page === "setup" && <>
        <p>Use reachable LAN or VPN addresses. The local operator Web stays on loopback; the separate HTTPS Peer listener connects machines.</p>
        <label htmlFor="network-listen">Listen endpoint (leave blank to reuse saved settings)</label><Input id="network-listen" value={listen} placeholder="https://0.0.0.0:7443" onChange={event => setListen(event.target.value)} />
        <label htmlFor="network-addresses">Advertised endpoints (one per line)</label><Textarea id="network-addresses" value={addresses} onChange={event => setAddresses(event.target.value)} placeholder="https://192.0.2.10:7443" />
        <form className="form-body" onSubmit={event => { event.preventDefault(); run("createNetwork", { networkName: name, ...settings() }); }}><h3>Create Network</h3><label htmlFor="network-name">Name</label><Input id="network-name" required value={name} onChange={event => setName(event.target.value)} /><Button disabled={active || status?.localStatus === "joining" || busy || Boolean(attempt)}>Create Network</Button></form>
        <form className="form-body" onSubmit={event => { event.preventDefault(); run("joinNetwork", { invitation: token.trim(), ...settings() }); }}><h3>Join through any member</h3><label htmlFor="join-invitation">Invitation credential</label><Textarea id="join-invitation" required autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /><Button disabled={active || status?.localStatus === "joining" || busy || Boolean(attempt)}>Join Network</Button></form>
        {(status?.joiningPublicKey || joinResult) && <section><h3>Joining identity</h3><p className="network-identity">Host: {status?.joiningHostId ?? joinResult?.hostId}<br />Public key: {status?.joiningPublicKey ?? joinResult?.publicKey}<br />{fingerprint || joinResult?.publicKeyFingerprint}</p><p>Status: {status?.joinStatus ?? "Pending"}. Only verified active membership enables remote sessions.</p></section>}
      </>}
    </div>
  </dialog>;
}
