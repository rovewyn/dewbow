import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import type { Event, Host, SessionSummary, NativeMessage,InteractionDetails } from "@dewbow/core-protocol";
import { Button } from "@dewbow/core-ui/ui";
import { Badge } from "@dewbow/core-ui/ui";
import { Card, CardHeader } from "@dewbow/core-ui/ui";
import { Input } from "@dewbow/core-ui/ui";
import { Textarea } from "@dewbow/core-ui/ui";
import {
  NativeSelect,
  NativeSelectOption,
} from "@dewbow/core-ui/ui";
import { Alert, AlertDescription } from "@dewbow/core-ui/ui";
import { api, ApiError, request,readInteractionDetails } from "./api";
import type { Detail, History, OperationSummary } from "./api";
import { historyEntries, mergeNativeMessages } from "./history";
import {QuestionForm} from "./QuestionForm";
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
  const [messages, setMessages] = useState<NativeMessage[]>([]),
    [liveMessages, setLiveMessages] = useState<NativeMessage[]>([]);
  const [historyError, setHistoryError] = useState(""),
    [discoveryError, setDiscoveryError] = useState("");
  const [beforeCursor,setBeforeCursor] = useState<string|null>(null);
  const [loadingOlder,setLoadingOlder] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(selection),
    [detail, setDetail] = useState<Detail | null>(null),
    [events, setEvents] = useState<Event[]>([]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const historyController = useRef<AbortController|null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(""),
    [message, setMessage] = useState("");
  const [mode,setMode]=useState<"default"|"plan">("default");
  const [hostId, setHostId] = useState(""),
    [workDir, setWorkDir] = useState("");
  const [retry, setRetry] = useState<{
    operation: string;
    input: Record<string, unknown>;
  } | null>(null);
  const pendingInputs=useRef(new Map<string,{operation:string;input:Record<string,unknown>}>());
  const [loadedInteractions,setLoadedInteractions]=useState(new Map<string,InteractionDetails>());
  const [loadingInteractions,setLoadingInteractions]=useState(new Set<string>());
  useEffect(()=>{setLoadedInteractions(new Map());setLoadingInteractions(new Set());},[selected]);
  useEffect(()=>{if(authenticated === false){pendingInputs.current.clear();setRetry(null);setMessage("");setMode("default");setLoadedInteractions(new Map());setLoadingInteractions(new Set());}},[authenticated]);
  useEffect(()=>{
    for(const op of detail?.operations??[]) {
      const saved=pendingInputs.current.get(op.requestId);if(!saved)continue;
      if(op.status === "delivered" || op.status === "error") {
        pendingInputs.current.delete(op.requestId);
        if(op.status === "delivered" && typeof saved.input.message === "string")setMessage(previous=>previous===saved.input.message ? "" : previous);
        setRetry(previous=>previous?.input.requestId===op.requestId ? null : previous);
      } else if(op.status === "unknown")setRetry(previous=>previous??saved);
    }
  },[detail]);
  const history = useRef<HTMLOListElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const [loadingHeight, setLoadingHeight] = useState(0);
  const followHistory = useRef(true);
  useEffect(() => {
    if (followHistory.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [events, messages, liveMessages]);
  useEffect(() => {
    const change = () => setSelected(selection());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (authenticated === false) return;
    const controller = new AbortController();
    historyController.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let updateCursor: string | null = null;
    selectedRef.current = selected;
    setBeforeCursor(null); setLoadingOlder(false);
    // Keep the page tall enough for its scroll position while the new panel loads.
    setLoadingHeight(conversation.current?.getBoundingClientRect().height ?? 0);
    setDetail(null);
    setEvents([]);
    setMessages([]);
    setLiveMessages([]);
    setHistoryError("");
    async function poll() {
      try {
        const [hostData, sessionData] = await Promise.all([
          api<{ hosts: Host[] }>("listHosts", {}, controller.signal),
          api<{ sessions: SessionSummary[]; discovery: { hostId: string; error: { message: string } | null }[] }>("listSessions", {}, controller.signal),
        ]);
        let current: Detail | null = null;
        const added: Event[] = [];
        const nativeMessages: NativeMessage[] = [];
        let live: NativeMessage[] = [],
          nativeError = "";
        let nextCursor = cursor;
        let nextUpdateCursor = updateCursor;
        if (selected) {
          current = await api<Detail>(
            "getSession",
            { sessionId: selected },
            controller.signal,
          );
          let more: boolean;
          do {
            const page = await api<History>(
              "readSessionHistory",
              { sessionId:selected,cursor:nextCursor,limit:50,...(nextUpdateCursor ? { updateCursor:nextUpdateCursor } : {}) },
              controller.signal,
            );
            added.push(...page.events);
            nextCursor = page.nextCursor;
            nativeMessages.push(...page.messages);
            live = page.liveMessages;
            nativeError = [page.historyError, page.eventsError].filter(Boolean).map(error => `${error!.code}: ${error!.message}`).join(" · ");
            if (!nextUpdateCursor && !page.historyError) setBeforeCursor(page.beforeCursor);
            nextUpdateCursor = page.updateCursor ?? nextUpdateCursor;
            more = page.hasMore || page.hasMoreUpdates;
          } while (more && !controller.signal.aborted);
        }
        if (controller.signal.aborted) return;
        cursor = nextCursor;
        updateCursor = nextUpdateCursor;
        setHosts(hostData.hosts);
        setSessions(sessionData.sessions);
        setDiscoveryError(sessionData.discovery.filter(d => d.error).map(d => `${d.hostId}: ${d.error!.message}`).join(" "));
        setDetail(current);
        setHistoryError(nativeError);
        if (added.length || nativeMessages.length || live.length) {
          const list = history.current;
          followHistory.current =
            !list ||
            list.scrollHeight - list.scrollTop - list.clientHeight < 80;
          setEvents((previous) => [...previous, ...added]);
          setMessages(previous => mergeNativeMessages(previous,nativeMessages));
          setLiveMessages(live);
        }
        setAuthenticated(true);
        setConnectionError("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.detail.code === "UNAUTHORIZED") {
          setAuthenticated(false);
          setHosts([]);
          setSessions([]);
          setDetail(null);
          setEvents([]);
          setMessages([]);
          setLiveMessages([]);
        } else setConnectionError(describe(cause));
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 1500);
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
    setMessage("");
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
    if(typeof input.requestId === "string")pendingInputs.current.set(input.requestId,{operation:name,input});
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
      if(result.status === "delivered" || result.status === "error") {
        pendingInputs.current.delete(String(input.requestId));
        if(result.status === "delivered" && typeof input.message === "string")setMessage(previous=>previous===input.message ? "" : previous);
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
  const canSend =
    connected &&
    detail?.session.managed &&
    detail?.session.codexThreadId &&
    detail.session.runtimeState !== "unknown" &&
    detail.session.connectionState === "connected" &&
    !detail.session.activeTurnId;
  const activeTurn = detail?.turns.find(
    (t) => t.turnId === detail.session.activeTurnId,
  );
  const canSteer=Boolean(connected && detail?.session.connectionState === "connected" && activeTurn?.codexTurnId && ["running","awaiting_input","awaiting_approval"].includes(activeTurn.state));
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
                  setEvents([]);
                  setMessages([]);
                  setLiveMessages([]);
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
                  <div className="approvals">
                    {detail.interactions
                      .filter(
                        (a) =>
                          a.status === "pending" ||
                          a.status === "requested" ||
                          a.status === "delivered",
                      )
                      .map((item) => {const approval={...item,details:item.details??loadedInteractions.get(item.content.contentId??"")};return (
                        <Card className="approval" key={approval.interactionId}>
                          <div className="row">
                            <h3>{approval.kind === "questions" ? "Questions" : approval.kind === "approval" ? "Approval" : "Operator action"} {approval.status}</h3>
                            <Badge
                              variant="secondary"
                              className="status awaiting_approval"
                            >
                              Human input
                            </Badge>
                          </div>
                          <p>
                            {detail.session.hostId} · Turn {approval.turnId}
                          </p>
                          {!approval.details && approval.content.contentId && <Button disabled={busy || !connected || loadingInteractions.has(approval.content.contentId)} onClick={()=>{
                            const sessionId=detail.session.sessionId,contentId=approval.content.contentId!,controller=historyController.current;setLoadingInteractions(previous=>new Set(previous).add(contentId));
                            void readInteractionDetails(sessionId,contentId,controller?.signal).then(details=>{if(selectedRef.current===sessionId && !controller?.signal.aborted)setLoadedInteractions(previous=>new Map(previous).set(contentId,details));}).catch(cause=>{if(selectedRef.current===sessionId && !controller?.signal.aborted)setError(describe(cause));}).finally(()=>{if(selectedRef.current===sessionId && !controller?.signal.aborted)setLoadingInteractions(previous=>{const next=new Set(previous);next.delete(contentId);return next;});});
                          }}>{loadingInteractions.has(approval.content.contentId) ? "Loading details…" : "Load interaction details"}</Button>}
                          {approval.details?.action && <pre>
                            {String(
                              approval.details?.action?.command ??
                                approval.details?.action?.grantRoot ??
                                JSON.stringify(approval.details?.action??{},null,2),
                            )}
                          </pre>}
                          {approval.details?.action?.reason ? (
                            <p>{String(approval.details.action.reason)}</p>
                          ) : null}
                          {approval.kind === "approval" && <p>
                            {approval.decision
                              ? `Decision: ${approval.decision}`
                              : "Review the action before allowing it."}
                          </p>}
                          {approval.kind === "questions" && approval.details?.questions && <QuestionForm key={approval.interactionId} questions={approval.details.questions} disabled={busy || !connected || approval.status!=="pending" || approval.turnId!==detail.session.activeTurnId} onAnswer={answers=>{void operation("answerQuestions",{sessionId:detail.session.sessionId,turnId:approval.turnId,interactionId:approval.interactionId,requestId:crypto.randomUUID(),answers});}}/>}
                          {approval.kind === "approval" && <div className="actions">
                            {(["allow", "deny"] as const).map((decision) => (
                              <Button
                                key={decision}
                                variant={
                                  decision === "allow" ? "default" : "outline"
                                }
                                disabled={
                                  busy ||
                                  !connected ||
                                  !approval.details?.action ||
                                  approval.status !== "pending" ||
                                  approval.turnId !==
                                    detail.session.activeTurnId
                                }
                                onClick={() => {
                                  void operation("decideApproval", {
                                    sessionId: detail.session.sessionId,
                                    turnId: approval.turnId,
                                    interactionId: approval.interactionId,
                                    decision,
                                    requestId:crypto.randomUUID(),
                                  });
                                }}
                              >
                                {decision === "allow" ? "Allow" : "Deny"}
                              </Button>
                            ))}
                          </div>}
                          {approval.kind === "unsupported" && <p>Interrupt the turn or handle this request in the native client.</p>}
                          {!connected && (
                            <p>
                              Reconnect and reconcile the host before deciding.
                            </p>
                          )}
                        </Card>
                      );})}
                  </div>
                  {detail.interactionsError && <p role="alert">{detail.interactionsError.message}</p>}
                  <ol
                    ref={history}
                    className="history"
                    aria-label="Conversation history"
                    tabIndex={0}
                  >
                    {beforeCursor && <li><Button disabled={loadingOlder} onClick={() => {
                      const sessionId = selected, cursor = beforeCursor, list = history.current, controller = historyController.current;
                      const height = list?.scrollHeight ?? 0, top = list?.scrollTop ?? 0;
                      followHistory.current = false; setLoadingOlder(true);
                      void api<History>("readSessionHistory",{sessionId,beforeCursor:cursor,limit:50},controller?.signal).then(page => {
                        if (selectedRef.current !== sessionId || controller?.signal.aborted) return;
                        if (page.historyError) throw new ApiError(page.historyError);
                        setBeforeCursor(page.beforeCursor);
                        setMessages(previous => mergeNativeMessages(previous,page.messages));
                        requestAnimationFrame(() => { if (list && selectedRef.current === sessionId) list.scrollTop = top+list.scrollHeight-height; });
                      }).catch(cause => { if (selectedRef.current === sessionId) setHistoryError(describe(cause)); }).finally(() => { if (selectedRef.current === sessionId) setLoadingOlder(false); });
                    }}>{loadingOlder ? "Loading older history…" : "Load older history"}</Button></li>}
                    {historyEntries(events, messages, liveMessages).map((entry) => (
                      <li className={`entry ${entry.kind}`} key={entry.id}>
                        <div className="row">
                          <strong>{entry.title}</strong>
                          <time dateTime={entry.timestamp}>
                            {time(entry.timestamp)}
                          </time>
                        </div>
                        {entry.text && <pre>{entry.text}</pre>}
                      </li>
                    ))}
                  </ol>
                  {historyError && <p className="empty-state" role="status">{historyError}</p>}
                  {!events.length && !messages.length && !liveMessages.length && !historyError && (
                    <p className="empty-state">No saved messages or management events yet.</p>
                  )}
                  <details className="operation-history">
                    <summary>
                      Request delivery ({detail.operations.length})
                    </summary>
                    <ul>
                      {detail.operations.map((op) => (
                        <li key={op.commandId}>
                          <strong>
                            {op.operation.replace("sessions_", "")} ·{" "}
                            {op.status}
                          </strong>
                          <p className="mono">{op.requestId}</p>
                          {op.error && (
                            <p>
                              {op.error.code}: {op.error.message}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                  {detail.session.managed && <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void operation(canSteer ? "steerTurn" : "sendMessage", {
                        sessionId: detail.session.sessionId,
                        ...(canSteer ? {turnId:activeTurn!.turnId} : {mode}),
                        message,
                        requestId: crypto.randomUUID(),
                      });
                    }}
                  >
                    <label htmlFor="message">Message</label>
                    <Textarea
                      id="message"
                      rows={3}
                      required
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      disabled={busy || (!canSend && !canSteer)}
                      placeholder={
                        canSend
                          ? "Send a message in this conversation…"
                          : "Wait for the active turn or host recovery."
                      }
                    />
                    <div className="actions">
                      <NativeSelect aria-label="Turn mode" value={activeTurn?.mode??mode} disabled={busy || Boolean(activeTurn)} onChange={event=>setMode(event.target.value as "default"|"plan")}><NativeSelectOption value="default">Default</NativeSelectOption><NativeSelectOption value="plan">Plan</NativeSelectOption></NativeSelect>
                      <Button
                        type="submit"
                        disabled={busy || (!canSend && !canSteer) || !message.trim()}
                      >
                        {canSteer ? "Add instruction" : "Send message"}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={
                          busy || !connected || !detail.session.activeTurnId
                        }
                        onClick={() => {
                          void operation("interruptTurn", {
                            sessionId: detail.session.sessionId,
                            turnId: detail.session.activeTurnId,
                            requestId: crypto.randomUUID(),
                          });
                        }}
                      >
                        Interrupt turn
                      </Button>
                    </div>
                    <p className="muted">
                      Acceptance and interrupt delivery are separate from a
                      confirmed terminal state.
                    </p>
                  </form>}
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
