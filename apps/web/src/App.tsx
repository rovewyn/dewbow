import { useEffect, useMemo, useRef, useState } from "react";
import { LogOut, PanelLeft, PanelRight, Plus, X } from "lucide-react";
import type { Host, SessionSummary } from "@dewbow/protocol";
import { Alert, AlertDescription, Badge, Button, Input, NativeSelect, NativeSelectOption } from "@dewbow/ui/ui";
import { api, ApiError, request, authenticateLauncher } from "./api";
import type { OperationSummary } from "./api";
import { Chat, createChatMemory } from "./Chat";
import { SessionDetails } from "./components/SessionDetails";
import { useHistory } from "./useHistory";
import { SessionTreeView } from "@/components/session-tree/SessionTreeView";
import { buildSessionTree, projectSessionTree } from "@/components/session-tree/model";

const selection = () => new URLSearchParams(window.location.hash.slice(1)).get("session") ?? "";
const isNarrow = () => window.matchMedia("(max-width: 759px)").matches;
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Not yet observed";
const describe = (error: unknown) => error instanceof Error ? error.message : "Request failed.";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]), [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [discoveryError, setDiscoveryError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(selection);
  const observed = useHistory(authenticated === true ? selected : "");
  // A selection change must never expose the previous conversation's controls.
  const detail = authenticated === true && observed.details?.session.sessionId === selected ? observed.details : null;
  useEffect(() => {
    if (authenticated !== true || observed.details?.session.sessionId !== selected) return;
    if (observed.details.host) {
      const host = observed.details.host;
      setHosts(previous => previous.some(item => item.hostId === host.hostId) ? previous.map(item => item.hostId === host.hostId ? host : item) : [...previous, host]);
    }
    const session = observed.details.session;
    setSessions(previous => previous.some(item => item.sessionId === session.sessionId) ? previous.map(item => item.sessionId === session.sessionId ? session : item) : [...previous, session]);
  }, [authenticated, observed.details, selected]);
  useEffect(() => { if (observed.authExpired) { setAuthenticated(false); setHosts([]); setSessions([]); } }, [observed.authExpired]);
  const chatMemory = useRef(createChatMemory());
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const authenticate = () => { void authenticateLauncher().then(() => setAuthenticated(true)).catch(cause => { setAuthenticated(false); if (!(cause instanceof ApiError && cause.detail.code === "UNAUTHORIZED")) setError(describe(cause)); }); };
    const relaunch = () => { if (new URLSearchParams(window.location.hash.slice(1)).has("login")) authenticate(); };
    authenticate(); window.addEventListener("hashchange", relaunch);
    return () => window.removeEventListener("hashchange", relaunch);
  }, []);
  const [hostId, setHostId] = useState(""), [workDir, setWorkDir] = useState("");
  const [createError, setCreateError] = useState("");
  const [retry, setRetry] = useState<{ operation: string; input: Record<string, unknown> } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isNarrow()), [detailsOpen, setDetailsOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null), inspector = useRef<HTMLElement>(null), conversation = useRef<HTMLElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null), detailsToggle = useRef<HTMLButtonElement>(null);
  const createDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (authenticated === false) {
      chatMemory.current.drafts.clear(); chatMemory.current.inputs.clear(); setRetry(null);
      setDetailsOpen(false); createDialog.current?.close();
    }
  }, [authenticated]);
  useEffect(() => { if (detailsOpen) inspector.current?.focus({ preventScroll: true }); }, [detailsOpen]);
  useEffect(() => { if (sidebarOpen && isNarrow()) sidebar.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); }, [sidebarOpen]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 759px)");
    const resize = () => { if (media.matches) setSidebarOpen(false); };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const change = () => setSelected(selection());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (authenticated !== true) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [hostData, sessionData] = await Promise.all([
          api<{ hosts: Host[] }>("listHosts", {}, controller.signal),
          api<{ sessions: SessionSummary[]; discovery: { hostId: string; error: { message: string } | null }[] }>("listSessions", {}, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setHosts(hostData.hosts); setSessions(sessionData.sessions);
        setDiscoveryError(sessionData.discovery.filter(d => d.error).map(d => `${d.hostId}: ${d.error!.message}`).join(" "));
        setConnectionError("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.detail.code === "UNAUTHORIZED") { setAuthenticated(false); setHosts([]); setSessions([]); }
        else setConnectionError(describe(cause));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 10000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [authenticated]);
  useEffect(() => {
    if (authenticated !== true || selected || selection() || !sessions.length) return;
    const candidates = sessions.filter(session => !session.native?.archived);
    const timestamp = (session: SessionSummary) => Date.parse(session.native?.updatedAt ?? session.createdAt ?? "") || 0;
    const recent = (candidates.length ? candidates : sessions).reduce((latest, session) => timestamp(session) > timestamp(latest) ? session : latest);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    fragment.set("session", recent.sessionId);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${fragment}`);
    setSelected(recent.sessionId);
  }, [authenticated, selected, sessions]);
  const select = (id: string) => {
    window.location.hash = new URLSearchParams({ session: id }).toString(); setSelected(id); setNotice(""); setRetry(null);
    if (isNarrow()) { setSidebarOpen(false); setDetailsOpen(false); requestAnimationFrame(() => conversation.current?.focus({ preventScroll: true })); }
  };
  const closeDetails = () => {
    setDetailsOpen(false);
    requestAnimationFrame(() => {
      const target = detailsToggle.current;
      if (target && !target.disabled) target.focus({ preventScroll: true });
      else conversation.current?.focus({ preventScroll: true });
    });
  };
  const closeSidebar = () => { setSidebarOpen(false); sidebarToggle.current?.focus({ preventScroll: true }); };
  const openCreate = () => {
    setCreateError("");
    if (!hosts.some(host => host.hostId === hostId && host.status === "connected")) setHostId(hosts.find(host => host.status === "connected")?.hostId ?? "");
    createDialog.current?.showModal();
    createDialog.current?.querySelector<HTMLInputElement>("#workDir")?.focus();
  };
  async function operation(name: string, input: Record<string, unknown>) {
    setBusy(true); setError(""); setRetry(null); setNotice("Sending request…");
    if (name === "createSession") setCreateError("");
    try {
      const result = await api<OperationSummary>(name, input);
      setRetry(null); setNotice(`${name} ${result.status} · ${result.requestId}`);
      if (name === "createSession") { createDialog.current?.close(); select(result.sessionId); setNotice(`Session creation ${result.status} · ${result.requestId}`); }
    } catch (cause) {
      setError(describe(cause)); setNotice("");
      if (name === "createSession") setCreateError(describe(cause));
      if (!(cause instanceof ApiError) || cause.detail.retryable) setRetry({ operation: name, input });
    } finally { setBusy(false); }
  }
  const connected = hosts.find(host => host.hostId === detail?.session.hostId)?.status === "connected";
  const selectedSession = detail?.session ?? sessions.find(session => session.sessionId === selected);
  const sessionTree = useMemo(() => buildSessionTree(hosts, sessions), [hosts, sessions]);
  const treeModel = useMemo(() => projectSessionTree(sessionTree, search, selected), [sessionTree, search, selected]);
  const runningCount = sessions.filter(session => session.runtimeState === "running").length;
  const attentionCount = sessions.filter(session => ["awaiting_approval", "awaiting_input"].includes(session.runtimeState)).length;
  const daemonConnected = authenticated === true && !connectionError;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); if (isNarrow()) { setSidebarOpen(false); setDetailsOpen(false); } requestAnimationFrame(() => conversation.current?.focus({ preventScroll: true })); }}>Skip to conversation</a>
      <header className="app-header">
        {authenticated && <Button ref={sidebarToggle} variant="ghost" size="icon" aria-label="Toggle sessions" aria-controls="sessions" aria-expanded={sidebarOpen} onClick={() => { setSidebarOpen(!sidebarOpen); if (isNarrow()) setDetailsOpen(false); }}><PanelLeft aria-hidden="true" /></Button>}
        <a className="brand" href="/" aria-label="Dewbow home">dewbow<span aria-hidden="true">.</span></a>
        <span className="workspace-label">Local workspace</span>
        {authenticated && <Button variant="ghost" className="sign-out" onClick={() => { void request("/auth/logout", {}).then(() => { setAuthenticated(false); setHosts([]); setSessions([]); setNotice(""); setError(""); setConnectionError(""); }).catch(cause => setError(describe(cause))); }}><LogOut aria-hidden="true" /><span>Sign out</span></Button>}
      </header>
      {(connectionError || error || notice || retry) && <div className="workspace-notices">
        {connectionError && <Alert variant="destructive"><AlertDescription>{connectionError}</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {notice && <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert>}
        {retry && <Button variant="outline" disabled={busy} onClick={() => { void operation(retry.operation, retry.input); }}>Retry the same request</Button>}
      </div>}
      {authenticated !== true ? <main id="main" ref={conversation} tabIndex={-1} className="login-workspace">
        {authenticated === null ? <p role="status">Connecting to Dewbow daemon…</p> : <section className="login-panel" aria-labelledby="login-title"><h1 id="login-title">Open Dewbow from your terminal</h1><p>Run <code>dewbow web</code> on this machine to open an authenticated Web session.</p><p>If you selected a separate configuration, include its <code>--state-dir</code> option.</p></section>}
      </main> : <div className={`workspace${sidebarOpen ? " sidebar-open" : ""}${detailsOpen ? " details-open" : ""}`}>
        <aside ref={sidebar} id="sessions" className="inventory" aria-label="Conversations" onKeyDown={event => { if (event.key === "Escape" && !search) { event.preventDefault(); closeSidebar(); } }}>
          <div className="inventory-toolbar"><Button variant="outline" onClick={openCreate}><Plus aria-hidden="true" />New session</Button><Button className="mobile-sidebar-close" variant="ghost" size="icon" aria-label="Close sessions" onClick={closeSidebar}><X aria-hidden="true" /></Button></div>
          <SessionTreeView model={treeModel} search={search} onSearchChange={setSearch} onSelect={select} error={discoveryError} />
        </aside>
        <main ref={conversation} id="main" tabIndex={-1} className="conversation" aria-labelledby="conversation-title" aria-busy={Boolean(selected && !detail && observed.loading)}>
          <header className="conversation-heading">
            <div className="conversation-heading-text"><h1 id="conversation-title" title={selectedSession?.name}>{selectedSession?.name || (selected ? "Conversation" : "Your conversations")}</h1>{selectedSession?.workDir && <p className="conversation-directory" title={selectedSession.workDir}>{selectedSession.workDir}</p>}</div>
            <div className="conversation-heading-actions">{detail && <Badge variant="secondary" className={`status ${detail.session.runtimeState}`}>{detail.session.runtimeState.replaceAll("_", " ")}</Badge>}<Button ref={detailsToggle} variant="ghost" size="icon" disabled={!detail} aria-label="Toggle session details" aria-controls="session-details" aria-expanded={detailsOpen} onClick={() => { setDetailsOpen(!detailsOpen); if (isNarrow()) setSidebarOpen(false); }}><PanelRight aria-hidden="true" /></Button></div>
          </header>
          {!detail ? <div className="empty-state" role="status"><h2>{selected ? observed.error ? "Conversation unavailable" : "Loading conversation…" : "Start a conversation"}</h2><p>{selected ? observed.error ?? "Loading messages, progress, and approvals." : "Create a session or choose a conversation from the sidebar."}</p>{!selected && <Button onClick={openCreate}><Plus aria-hidden="true" />New session</Button>}</div> : <>
            {(!detail.session.managed || detail.session.connectionState !== "connected" || detail.session.runtimeState === "unknown") && <div className="conversation-connection">
              {(!detail.session.managed || detail.session.connectionState === "error") && <div className="connection-action"><p>{detail.session.managed ? "Reconnect this conversation to continue." : "Connect this Codex conversation to continue here."}</p><Button disabled={busy || !connected || !detail.session.workDir} onClick={() => { void operation("connectSession", { sessionId: detail.session.sessionId, requestId: crypto.randomUUID() }); }}>Connect conversation</Button></div>}
              {detail.session.connectionState === "error" && <p role="alert">{detail.operations.filter(op => op.operation === "connectSession").at(-1)?.error?.message ?? "Connection failed. Inspect request delivery and retry."}</p>}
              {detail.session.connectionState === "connecting" && <p role="status">Connecting conversation…</p>}
              {detail.session.managed && detail.session.connectionState === "disconnected" && <p role="status">Execution is disconnected. Your draft stays in this session.</p>}
              {detail.session.runtimeState === "unknown" && <p role="status">Last known: {detail.session.lastKnownState} at {time(detail.session.lastKnownAt)}. Reconcile the host before continuing.</p>}
            </div>}
            <Chat key={detail.session.sessionId} detail={detail} connected={connected && !connectionError} memory={chatMemory.current} globalBusy={busy} observed={observed} />
          </>}
        </main>
        <aside ref={inspector} id="session-details" className="session-details" tabIndex={-1} aria-labelledby="details-title" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeDetails(); } }}>
          <header className="details-heading"><h2 id="details-title">Session details</h2><Button variant="ghost" size="icon" aria-label="Close session details" onClick={closeDetails}><X aria-hidden="true" /></Button></header>
          {detail && <SessionDetails detail={detail} hosts={hosts} />}
        </aside>
      </div>}
      <footer className="status-bar">
        <span className={`daemon-status${daemonConnected ? " is-connected" : ""}`}><span className="status-dot" aria-hidden="true" />{connectionError ? "Daemon unavailable" : authenticated === false ? "Sign in required" : daemonConnected ? "Daemon connected" : "Connecting to daemon…"}</span>
        {authenticated && <span className="execution-status">{runningCount} running{attentionCount > 0 && ` · ${attentionCount} need attention`}</span>}<span className="local-status">Local execution</span>
      </footer>
      {authenticated && <dialog ref={createDialog} className="create-dialog" aria-labelledby="create-title">
        <header className="details-heading"><h2 id="create-title">New session</h2><Button variant="ghost" size="icon" aria-label="Close new session" onClick={() => createDialog.current?.close()}><X aria-hidden="true" /></Button></header>
        <form className="form-body" onSubmit={event => { event.preventDefault(); if (!busy) void operation("createSession", { hostId, workDir, requestId: crypto.randomUUID() }); }}>
          <label htmlFor="host">Machine</label><NativeSelect className="w-full" id="host" required value={hostId} onChange={event => setHostId(event.target.value)}><NativeSelectOption value="">Select a connected machine</NativeSelectOption>{hosts.filter(host => host.status === "connected").map(host => <NativeSelectOption key={host.hostId} value={host.hostId}>{host.name}</NativeSelectOption>)}</NativeSelect>
          <label htmlFor="workDir">Working directory on that machine</label><Input id="workDir" required placeholder="/path/to/workspace" value={workDir} onChange={event => setWorkDir(event.target.value)} />
          <Button type="submit" disabled={busy || retry?.operation === "createSession" || !hosts.some(host => host.hostId === hostId && host.status === "connected")}>{busy ? "Creating…" : "Create session"}</Button>
          {createError && <p className="form-error" role="alert">{createError}</p>}
          {retry?.operation === "createSession" && <Button type="button" variant="outline" disabled={busy} onClick={() => { void operation(retry.operation, retry.input); }}>Retry the same request</Button>}
        </form>
      </dialog>}
    </div>
  );
}
