import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import type { Host, SessionSummary } from "@dewbow/core-protocol";
import { Button } from "@dewbow/core-ui/ui";
import { Badge } from "@dewbow/core-ui/ui";
import { Card, CardHeader } from "@dewbow/core-ui/ui";
import { Input } from "@dewbow/core-ui/ui";
import {
  NativeSelect,
  NativeSelectOption,
} from "@dewbow/core-ui/ui";
import { Alert, AlertDescription } from "@dewbow/core-ui/ui";
import { api, ApiError, request } from "./api";
import type { Detail, OperationSummary } from "./api";
import { CoreChat, createCoreChatMemory } from "./CoreChat";
import { useCoreHistory } from "./useCoreHistory";
import { SessionTreeView } from "@/components/session-tree/SessionTreeView";
import { buildSessionTree, projectSessionTree } from "@/components/session-tree/model";

const selection = () =>
  new URLSearchParams(window.location.hash.slice(1)).get("session") ?? "";
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not yet observed";
const describe = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";
const scrollTo = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
  event.preventDefault();
  const target = document.getElementById(id);
  target?.scrollIntoView({ behavior: "smooth" });
  if (id === "main") target?.focus({ preventScroll: true });
};

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]),
    [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [discoveryError, setDiscoveryError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(selection),
    [detail, setDetail] = useState<Detail | null>(null);
  const observed = useCoreHistory(authenticated === true ? selected : "");
  useEffect(() => {
    setDetail(observed.details);
    if (observed.details?.host) {
      const host = observed.details.host;
      setHosts(previous => previous.some(item => item.hostId === host.hostId) ? previous.map(item => item.hostId === host.hostId ? host : item) : [...previous, host]);
    }
    if (observed.details) { const session = observed.details.session; setSessions(previous => previous.some(item => item.sessionId === session.sessionId) ? previous.map(item => item.sessionId === session.sessionId ? session : item) : [...previous, session]); }
  }, [observed.details]);
  useEffect(() => { if (observed.authExpired) { setAuthenticated(false); setDetail(null); setHosts([]); setSessions([]); } }, [observed.authExpired]);
  const chatMemory = useRef(createCoreChatMemory());
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [hostId, setHostId] = useState(""),
    [workDir, setWorkDir] = useState("");
  const [retry, setRetry] = useState<{
    operation: string;
    input: Record<string, unknown>;
  } | null>(null);
  useEffect(() => { if (authenticated === false) { chatMemory.current.drafts.clear(); chatMemory.current.inputs.clear(); setRetry(null); } }, [authenticated]);
  const conversation = useRef<HTMLDivElement>(null);
  const [loadingHeight, setLoadingHeight] = useState(0);
  useEffect(() => {
    const change = () => setSelected(selection());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (authenticated === false) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Keep the page tall enough for its scroll position while the new panel loads.
    setLoadingHeight(conversation.current?.getBoundingClientRect().height ?? 0);
    setDetail(null);
    async function poll() {
      try {
        const [hostData, sessionData] = await Promise.all([
          api<{ hosts: Host[] }>("listHosts", {}, controller.signal),
          api<{ sessions: SessionSummary[]; discovery: { hostId: string; error: { message: string } | null }[] }>("listSessions", {}, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setHosts(hostData.hosts);
        setSessions(sessionData.sessions);
        setDiscoveryError(sessionData.discovery.filter(d => d.error).map(d => `${d.hostId}: ${d.error!.message}`).join(" "));
        setAuthenticated(true);
        setConnectionError("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.detail.code === "UNAUTHORIZED") {
          setAuthenticated(false);
          setHosts([]);
          setSessions([]);
          setDetail(null);
        } else setConnectionError(describe(cause));
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 10000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [authenticated, selected]);
  const select = (id: string) => {
    window.location.hash = new URLSearchParams({ session: id }).toString();
    setSelected(id);
    setNotice("");
    setRetry(null);
  };
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/auth/login", { password });
      setPassword("");
      setAuthenticated(true);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }
  async function operation(name: string, input: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setRetry(null);
    setNotice("Sending request…");
    try {
      const result = await api<OperationSummary>(name, input);
      setRetry(null);
      setNotice(
        `${name.replace("sessions_", "")} ${result.status} · ${result.requestId}`,
      );
      if (name === "createSession") {
        select(result.sessionId);
        setNotice(`Session creation ${result.status} · ${result.requestId}`);
      }
    } catch (cause) {
      setError(describe(cause));
      setNotice("");
      if (!(cause instanceof ApiError) || cause.detail.retryable)
        setRetry({ operation: name, input });
    } finally {
      setBusy(false);
    }
  }
  const connected =
    hosts.find((h) => h.hostId === detail?.session.hostId)?.status ===
    "connected";
  const activeTurn = detail?.turns.find(
    (t) => t.turnId === detail.session.activeTurnId,
  );
  const sessionTree = useMemo(() => buildSessionTree(hosts, sessions), [hosts, sessions]);
  const treeModel = useMemo(() => projectSessionTree(sessionTree, search, selected), [sessionTree, search, selected]);
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => scrollTo(event, "main")}
      >
        Skip to content
      </a>
      <header className="header">
        <a className="brand" href="/" aria-label="Dewbow Core home">
          dewbow<span aria-hidden="true">.</span><small>Core</small>
        </a>
        <nav aria-label="Main navigation">
          <a href="#machines" onClick={(event) => scrollTo(event, "machines")}>
            Machines
          </a>
          <a href="#sessions" onClick={(event) => scrollTo(event, "sessions")}>
            Sessions
          </a>
        </nav>
        {authenticated && (
          <Button
            variant="outline"
            onClick={() => {
              void request("/auth/logout", {})
                .then(() => {
                  setAuthenticated(false);
                  setHosts([]);
                  setSessions([]);
                  setDetail(null);
                })
                .catch((cause) => setError(describe(cause)));
            }}
          >
            Sign out
          </Button>
        )}
      </header>
      <main id="main" tabIndex={-1}>
        <div className="intro">
          <p className="eyebrow">CODEX EXECUTION PLATFORM</p>
          <h1>
            Your sessions.
            <br />
            Across your machines.
          </h1>
          <p className="description">
            Manage hosts and conversations. Review approvals and recover execution.
          </p>
        </div>
        {connectionError && (
          <Alert variant="destructive" className="error-banner">
            <AlertDescription>{connectionError}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="error-banner">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert className="notice" role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {retry && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void operation(retry.operation, retry.input);
            }}
          >
            Retry the same request
          </Button>
        )}
        {authenticated === null && (
          <p role="status">Connecting to Control Plane…</p>
        )}
        {authenticated === false && (
          <Card role="region" className="panel login-panel">
            <CardHeader className="panel-heading">
              <h2>Operator sign in</h2>
            </CardHeader>
            <form
              onSubmit={(event) => {
                void login(event);
              }}
              className="form-body"
            >
              <label htmlFor="password">Operator password</label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Button type="submit" disabled={busy}>
                Sign in
              </Button>
            </form>
          </Card>
        )}
        {authenticated && (
          <div className="workspace">
            <aside className="inventory">
              <Card role="region" id="machines" className="panel" aria-label="Machines and sessions">
                <div id="sessions">
                  <SessionTreeView model={treeModel} search={search} onSearchChange={setSearch}
                    onSelect={select} error={discoveryError} />
                </div>

                <details className="create-session">
                  <summary>Create session</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void operation("createSession", {
                        hostId,
                        workDir,
                        requestId: crypto.randomUUID(),
                      });
                    }}
                    className="form-body"
                  >
                    <label htmlFor="host">Machine</label>
                    <NativeSelect
                      className="w-full"
                      id="host"
                      required
                      value={hostId}
                      onChange={(event) => setHostId(event.target.value)}
                    >
                      <NativeSelectOption value="">
                        Select a connected machine
                      </NativeSelectOption>
                      {hosts
                        .filter((h) => h.status === "connected")
                        .map((host) => (
                          <NativeSelectOption
                            key={host.hostId}
                            value={host.hostId}
                          >
                            {host.name}
                          </NativeSelectOption>
                        ))}
                    </NativeSelect>
                    <label htmlFor="workDir">
                      Working directory on that machine
                    </label>
                    <Input
                      id="workDir"
                      required
                      placeholder="/path/to/workspace"
                      value={workDir}
                      onChange={(event) => setWorkDir(event.target.value)}
                    />
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        !hosts.some(
                          (h) =>
                            h.hostId === hostId && h.status === "connected",
                        )
                      }
                    >
                      Create session
                    </Button>
                  </form>
                </details>
              </Card>
            </aside>
            <Card
              ref={conversation}
              role="region"
              className="panel conversation"
              aria-labelledby="conversation-title"
              aria-busy={Boolean(selected && !detail)}
              style={selected && !detail ? { minHeight: loadingHeight } : undefined}
            >
              <CardHeader className="panel-heading">
                <h2 id="conversation-title">Conversation</h2>
                {detail && (
                  <Badge
                    variant="secondary"
                    className={`status ${detail.session.runtimeState}`}
                  >
                    Runtime: {detail.session.runtimeState}
                  </Badge>
                )}
              </CardHeader>
              {!detail && (
                <div className="empty-state">
                  <h3>
                    {selected ? "Loading conversation…" : "Select a session"}
                  </h3>
                  <p>Messages, progress, and approvals appear here.</p>
                </div>
              )}
              {detail && (
                <>
                  <div className="session-meta">
                    <p className="mono">{detail.session.workDir}</p>
                    <p>
                      {detail.session.hostId} · {detail.session.sessionId}
                    </p>
                    <p>{detail.session.name}</p>
                    <p>Connection: {detail.session.connectionState === "error" ? "failed" : detail.session.connectionState}</p>
                    <p>
                      {detail.session.managed
                        ? `Turn: ${activeTurn?.state ?? "No active turn"}`
                        : "Connect this Codex conversation to continue here."}
                    </p>
                    {(!detail.session.managed || detail.session.connectionState === "error") && (
                      <Button
                        disabled={busy || !connected || !detail.session.workDir}
                        onClick={() => { void operation("connectSession", { sessionId: detail.session.sessionId, requestId: crypto.randomUUID() }); }}
                      >
                        Connect conversation
                      </Button>
                    )}
                    {detail.session.connectionState === "error" && (
                      <p role="alert">{detail.operations.filter(op => op.operation === "connectSession").at(-1)?.error?.message ?? "Connection failed. Inspect request delivery and retry."}</p>
                    )}
                    {detail.session.connectionState === "connecting" && <p role="status">Connecting conversation…</p>}
                    {detail.session.native && (
                      <p>
                        Native runtime: {detail.session.native.runtimeStatus} · Writer lock:{" "}
                        {detail.session.native.hasActiveWriter === null
                          ? "unknown"
                          : detail.session.native.hasActiveWriter ? "held" : "free"}
                      </p>
                    )}
                    {detail.session.connectionState === "connected" && detail.session.runtimeState === "unknown" && (
                      <p>
                        Last known: {detail.session.lastKnownState} at{" "}
                        {time(detail.session.lastKnownAt)}. Reconcile the host
                        before continuing.
                      </p>
                    )}
                  </div>
                  <CoreChat key={detail.session.sessionId} detail={detail} connected={connected && !connectionError} memory={chatMemory.current} globalBusy={busy} observed={observed} />

                </>
              )}
            </Card>
          </div>
        )}
      </main>
      <footer>Self-hosted Codex session management.</footer>
    </>
  );
}
