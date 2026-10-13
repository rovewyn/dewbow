import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentDefinition, ApiError, SessionBinding, Team, TeamMember } from "@dewbow/team-protocol";
import { call, errorDetail, onAuthFailure, readAuth, signIn, signOut } from "./api.js";
import { ChannelWorkbench } from "./ChannelWorkbench.js";
import { ChannelsPage } from "./ChannelsPage.js";
import { AgentSessionForm } from "./AgentSessionForm.js";
import { DefinitionsPage } from "./DefinitionsPage.js";
import { readRoute, type Catalog, type Route } from "./model.js";
import { SessionPage, createTeamChatMemory } from "./SessionPage.js";
import { BindingList, TeamsPage } from "./TeamsPage.js";
import { Badge, Empty, ErrorNotice, PageHeading } from "./ui.js";

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setError(null);
    try {
      await signIn(String(new FormData(form).get("token") ?? ""));
      form.reset(); onSignedIn();
    } catch (cause) { setError(errorDetail(cause)); }
    finally { setBusy(false); }
  }
  return <main className="login-page"><div className="login-intro"><span className="brand-mark" aria-hidden="true">D</span><span className="eyebrow">DEWBOW TEAM</span><h1>A place for<br />your agents.</h1><p>Give each agent a role.<br />Keep the team and its work together.</p><div className="login-boundary"><strong>Team</strong> organizes your agents.<br /><strong>Core</strong> runs their sessions.</div></div>
    <section className="login-card"><span className="eyebrow">OPERATOR WORKSPACE</span><h2>Welcome to Team</h2><p className="muted">Sign in with the operator token configured on your Team backend.</p><form onSubmit={event => void submit(event)}><label>Operator token<input name="token" type="password" required minLength={16} maxLength={512} autoComplete="off" autoFocus disabled={busy} /></label><ErrorNotice error={error} /><button className="button primary" disabled={busy}>{busy ? "Signing in…" : "Open workspace →"}</button></form><p className="field-hint">Your token is used to sign in. The browser keeps only a session cookie.</p></section></main>;
}

export function App() {
  const [createAgent, setCreateAgent] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [route, setRoute] = useState(readRoute);
  const activeRead = useRef<AbortController | null>(null);
  const authGeneration = useRef(0);
  const chatMemory = useRef(createTeamChatMemory());
  useEffect(() => { if (authenticated === false) { chatMemory.current.drafts.clear(); chatMemory.current.inputs.clear(); } }, [authenticated]);
  useEffect(() => onAuthFailure(() => {
    authGeneration.current++; activeRead.current?.abort();
    chatMemory.current.drafts.clear(); chatMemory.current.inputs.clear();
    setCatalog(null); setAuthenticated(false);
  }), []);
  useEffect(() => {
    let active = true;
    void readAuth().then(result => { if (active) setAuthenticated(result.authenticated); })
      .catch(cause => { if (active) { setError(errorDetail(cause)); setAuthenticated(false); } });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const read = () => setRoute(readRoute());
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const refresh = useCallback(async () => {
    if (!authenticated) return;
    activeRead.current?.abort();
    const controller = new AbortController(); activeRead.current = controller;
    setLoading(true);
    try {
      const [definitions, teams, bindings, service] = await Promise.all([
        call<{ definitions: AgentDefinition[] }>("listAgentDefinitions", {}, controller.signal),
        call<{ teams: Team[] }>("listTeams", { includeArchived: true }, controller.signal),
        call<{ bindings: SessionBinding[] }>("listSessionBindings", {}, controller.signal),
        call<Catalog["service"]>("getServiceInfo", {}, controller.signal),
      ]);
      const members = await Promise.all(teams.teams.map(team => call<{ members: TeamMember[] }>("getTeam", { teamId: team.teamId, includeArchived: true }, controller.signal)));
      if (!controller.signal.aborted) {
        setCatalog({ definitions: definitions.definitions, teams: teams.teams, bindings: bindings.bindings, members: members.flatMap(item => item.members), service });
        setError(null);
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const detail = errorDetail(cause);
      if (detail.code === "UNAUTHORIZED") { setAuthenticated(false); setCatalog(null); }
      setError(detail);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [authenticated]);
  useEffect(() => { void refresh(); return () => activeRead.current?.abort(); }, [refresh]);
  const navigate = (next: Route) => {
    const params = new URLSearchParams({ page: next.page });
    if (next.teamId) params.set("team", next.teamId);
    if (next.bindingId) params.set("session", next.bindingId);
    if (next.conversationId) params.set("conversation", next.conversationId);
    location.hash = params.toString();
  };
  async function logout() {
    const generation = ++authGeneration.current;
    try {
      await signOut();
      if (generation === authGeneration.current) {
        activeRead.current?.abort(); setCatalog(null); setAuthenticated(false); setError(null);
      }
    } catch (cause) { setError(errorDetail(cause)); }
  }
  if (authenticated === null) return <main className="loading-page"><span className="brand-mark">D</span><p>Opening your workspace…</p></main>;
  if (!authenticated) return <Login onSignedIn={() => { authGeneration.current++; setError(null); setAuthenticated(true); }} />;
  return <div className="app-shell"><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a><aside className="sidebar"><a className="brand" href="#page=teams"><span className="brand-mark" aria-hidden="true">D</span><span>Dewbow <strong>Team</strong><small>Agent workspace</small></span></a><span className="sidebar-label">WORKSPACE</span><nav aria-label="Workspace">{([{ page: "teams", label: "Teams", icon: "◇" }, { page: "definitions", label: "Definitions", icon: "◈" }, { page: "sessions", label: "Sessions", icon: "↗" }, { page: "channels", label: "Channels", icon: "↔" }] as const).map(item => <a key={item.page} className={route.page === item.page ? "active" : ""} href={`#page=${item.page}`} aria-current={route.page === item.page ? "page" : undefined}><span aria-hidden="true">{item.icon}</span>{item.label}{item.page === "sessions" && catalog && <span className="nav-count">{catalog.bindings.length}</span>}</a>)}</nav>
    <div className="sidebar-bottom"><div className="core-connection"><span className="sidebar-label">DEWBOW CORE</span><Badge tone={catalog?.service.coreConfigured ? "good" : "warning"}>{catalog?.service.coreConfigured ? "Configured" : "Not configured"}</Badge><p>Hosts and execution live in Core.</p>{catalog?.service.coreUrl && <a href={catalog.service.coreUrl} target="_blank" rel="noreferrer">Open Core ↗</a>}</div><button className="sidebar-signout" onClick={() => void logout()}>Sign out <span aria-hidden="true">→</span></button></div></aside>
    <div className="workspace"><header className="topbar"><span>Workspace <span className="breadcrumb-separator">/</span> <strong>{route.page === "teams" ? "Teams" : route.page === "definitions" ? "Definitions" : route.page === "channels" ? "Channels" : "Sessions"}</strong></span><button className="text-button" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></header><main className="main-content" id="main-content" tabIndex={-1}><ErrorNotice error={error} onRetry={() => void refresh()} />{!catalog ? <Empty title={loading ? "Loading workspace" : "Workspace unavailable"}>Your definitions, teams, and sessions will appear here.</Empty> : route.page === "definitions" ? <DefinitionsPage definitions={catalog.definitions} refresh={refresh} /> : route.page === "channels" ? route.conversationId ? <ChannelWorkbench key={route.conversationId} conversationId={route.conversationId} catalog={catalog} navigate={navigate} memory={chatMemory.current} /> : <ChannelsPage catalog={catalog} navigate={navigate} refresh={refresh} /> : route.page === "sessions" ? route.bindingId ? <SessionPage key={route.bindingId} memory={chatMemory.current} bindingId={route.bindingId} catalog={catalog} navigate={navigate} onBindingChanged={binding => setCatalog(current => current ? { ...current, bindings: current.bindings.map(item => item.bindingId === binding.bindingId ? binding : item) } : current)} /> : <><PageHeading eyebrow="WORKSPACE" title="Sessions" description="Work with an agent directly or return to an existing session." actions={<button className="button primary" onClick={() => setCreateAgent(true)}>+ New agent session</button>} /><BindingList bindings={catalog.bindings} catalog={catalog} navigate={navigate} /></> : <TeamsPage key={route.teamId ?? "all"} catalog={catalog} teamId={route.teamId} refresh={refresh} navigate={navigate} />}{createAgent && catalog && <AgentSessionForm catalog={catalog} onClose={() => setCreateAgent(false)} onCreated={async binding => { await refresh(); navigate({ page: "sessions", bindingId: binding.bindingId }); }} />}</main><footer className="workspace-footer">Dewbow Team <span>Built on your Codex baseline</span></footer></div></div>;
}
