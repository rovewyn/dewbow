import { useEffect, useRef, useState } from "react";
import type { ApiError, ContentPage, ContentRef, InteractionDetails, BindingOperation, SessionBindingResult, SessionBinding } from "@dewbow/team-protocol";
import { ChatView, type ChatContentState, type ChatDraft, type ChatRequest } from "@dewbow/core-ui/chat";
import { buildChatModel, projectHistoryWindow } from "@dewbow/core-ui/chat/model";
import { ApiClientError, call, errorDetail, readInteractionDetails } from "./api.js";
import type { Catalog, Route } from "./model.js";
import { Badge, ErrorNotice, PageHeading, shortId } from "./ui.js";
import { useSession } from "./useSession.js";

interface PendingInput { operation: string; input: Record<string, unknown>; result: SessionBindingResult | null }
export interface TeamChatMemory { drafts: Map<string, ChatDraft>; inputs: Map<string, PendingInput> }
export const createTeamChatMemory = (): TeamChatMemory => ({ drafts: new Map(), inputs: new Map() });
const labels: Record<string, string> = { createMemberSession: "Create session", createAgentSession: "Create agent session", connectSessionBinding: "Connect session", sendBindingMessage: "Send message", steerBindingTurn: "Add instruction", answerBindingQuestions: "Answer questions", interruptBindingTurn: "Interrupt turn" };
const isMessage = (operation: string) => ["sendBindingMessage", "steerBindingTurn"].includes(operation);
function unresolved(request: BindingOperation) { return request.result ? ["accepted", "unknown"].includes(request.result.status) : !request.error || request.error.retryable; }

export function SessionPage({ bindingId, catalog, navigate, onBindingChanged, memory, readOnly=false, embedded=false }: { bindingId: string; catalog: Catalog; navigate: (route: Route) => void; onBindingChanged: (binding: SessionBinding) => void; memory: TeamChatMemory; readOnly?: boolean; embedded?: boolean }) {
  const observed = useSession(bindingId), details = observed.details;
  const binding = details?.binding ?? catalog.bindings.find(item => item.bindingId === bindingId);
  const logicalOperation = (operation: string) => operation === "retrySessionBindingCreation" ? binding?.createOperation ?? "createMemberSession" : operation;
  const requestKey = (bindingId: string, operation: string, requestId: string) => JSON.stringify([bindingId, logicalOperation(operation), requestId]);
  const member = catalog.members.find(item => item.memberId === binding?.memberId);
  const session = details?.core?.session, display = details?.core ?? observed.lastCore, requests = details?.requests ?? [];
  const [tab, setTab] = useState<"conversation" | "configuration">("conversation");
  const [draft, setDraft] = useState<ChatDraft>(() => memory.drafts.get(bindingId) ?? { text: "", mode: "default" });
  const [retryKey, setRetryKey] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [contents, setContents] = useState(new Map<string, ChatContentState>()), contentRef = useRef(contents);
  const [interactionDetails, setInteractionDetails] = useState(new Map<string, InteractionDetails>()), [loadingInteractions, setLoadingInteractions] = useState(new Set<string>());
  const controller = useRef<AbortController | null>(null), mutation = useRef(false), contentReads = useRef(new Set<string>()), interactionReads = useRef(new Set<string>());
  const privateContext = observed.history.restricted || details?.core?.contextAuthority === "operator", privacy = useRef(privateContext); privacy.current = privateContext;
  const hostUnavailable = details?.core?.interactionsError?.code === "HOST_UNAVAILABLE" || observed.historyError?.code === "HOST_UNAVAILABLE";
  const unavailable = !details?.core || Boolean(details.coreError || observed.error || hostUnavailable);
  const ready = !unavailable && session?.connectionState === "connected";
  const paused=Boolean(session?.executionPause), executionReady=ready && !paused && !readOnly;
  const active = details?.core?.turns.find(turn => turn.turnId === session?.activeTurnId);
  const operatorUrl = catalog.service.coreUrl ? `${catalog.service.coreUrl.replace(/\/$/, "")}/#${new URLSearchParams({ session: binding?.sessionId ?? "" })}` : undefined;
  useEffect(() => { const abort = new AbortController(); controller.current = abort; return () => abort.abort(); }, [bindingId]);
  useEffect(() => { if (privateContext) { const empty = new Map<string, ChatContentState>(); contentRef.current = empty; setContents(empty); setInteractionDetails(new Map()); } }, [privateContext]);
  function changeDraft(next: ChatDraft) { memory.drafts.set(bindingId, next); setDraft(next); }
  function release(key: string, pending: PendingInput, delivered: boolean) {
    if (memory.inputs.get(key) !== pending) return;
    memory.inputs.delete(key);
    const saved = memory.drafts.get(bindingId);
    if (delivered && typeof pending.input.message === "string" && pending.input.message === saved?.text) memory.drafts.set(bindingId, { ...saved, text: "" });
  }
  useEffect(() => {
    for (const request of requests) {
      const key = requestKey(bindingId, request.operation, request.requestId), pending = memory.inputs.get(key);
      if (!pending || unresolved(request) || pending.result?.operation && pending.result.operation.commandId !== request.result?.commandId) continue;
      release(key, pending, request.result?.status === "delivered");
      setDraft(memory.drafts.get(bindingId) ?? { text: "", mode: "default" }); setRetryKey(current => current === key ? null : current);
    }
  }, [details, bindingId, memory]);
  async function command(operation: string, input: Record<string, unknown>) {
    const abort = controller.current; if (mutation.current || !abort || abort.signal.aborted) return;
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    const requestId = String(input.requestId ?? binding?.createRequestId), key = requestKey(bindingId, operation, requestId), pending: PendingInput = { operation, input, result: null };
    memory.inputs.set(key, pending);
    try {
      const result = await call<SessionBindingResult>(operation, input, abort.signal); pending.result = result;
      const terminal = result.operation ? ["delivered", "error"].includes(result.operation.status) : result.error && !result.error.retryable;
      if (terminal) release(key, pending, result.operation?.status === "delivered");
      if (abort.signal.aborted) return;
      onBindingChanged(result.binding); setError(result.error); setNotice(`${labels[logicalOperation(operation)] ?? operation}: ${result.operation?.status ?? "unknown"}. Turn completion is observed separately.`);
      if (terminal) { setRetryKey(null); setDraft(memory.drafts.get(bindingId) ?? { text: "", mode: "default" }); }
    } catch (cause) {
      if (cause instanceof ApiClientError && !cause.detail.retryable) release(key, pending, false);
      if (abort.signal.aborted) return;
      const value = errorDetail(cause); if (!value.retryable) release(key, pending, false);
      if (!abort.signal.aborted) setError(value);
    } finally { if (!abort.signal.aborted) { mutation.current = false; setBusy(false); } }
  }
  function run(operation: string, input: Record<string, unknown>) { void command(operation, { bindingId, ...input, requestId: crypto.randomUUID() }); }
  async function loadInteraction(contentId: string) {
    const abort = controller.current; if (privacy.current || !contentId || !abort || abort.signal.aborted || interactionReads.current.has(contentId)) return;
    interactionReads.current.add(contentId); setLoadingInteractions(new Set(interactionReads.current));
    try { const value = await readInteractionDetails(bindingId, contentId, abort.signal); if (!abort.signal.aborted && !privacy.current) setInteractionDetails(previous => new Map(previous).set(contentId, value)); }
    catch (cause) { if (!abort.signal.aborted) setError(errorDetail(cause)); }
    finally { if (!abort.signal.aborted) { interactionReads.current.delete(contentId); setLoadingInteractions(new Set(interactionReads.current)); } }
  }
  function updateContent(contentId: string, value: ChatContentState) { const next = new Map(contentRef.current).set(contentId, value); contentRef.current = next; setContents(next); }
  async function loadContent(ref: ContentRef, action: "first" | "more" | "refresh") {
    const contentId = ref.contentId, abort = controller.current;
    if (privacy.current || ref.authority !== "agent" || !contentId || !abort || abort.signal.aborted || contentReads.current.has(contentId)) return;
    const previous = contentRef.current.get(contentId), cursor = action === "more" ? previous?.nextCursor : null;
    if (action === "more" && !cursor) return;
    const baseline: ChatContentState = action === "more" && previous ? previous : { status: "ready", text: "", nextCursor: null, bytesLoaded: 0, completeness: ref.completeness, error: null };
    contentReads.current.add(contentId); updateContent(contentId, { ...baseline, status: "loading", error: null });
    try {
      const page = await call<ContentPage>("readBindingContent", { bindingId, contentId, limitBytes: 65536, ...(cursor ? { contentCursor: cursor } : {}) }, abort.signal);
      if (abort.signal.aborted || privacy.current) return;
      const bytes = new TextEncoder().encode(page.text).length;
      if (page.contentId !== contentId || page.byteOffset !== baseline.bytesLoaded || page.nextCursor && (!bytes || page.nextCursor === cursor)) throw new Error("Content read did not advance from the expected position.");
      updateContent(contentId, { status: "ready", text: baseline.text + page.text, nextCursor: page.nextCursor, bytesLoaded: page.byteOffset + bytes, completeness: page.completeness, error: null });
    } catch (cause) { if (!abort.signal.aborted && !privacy.current) updateContent(contentId, { ...baseline, status: "error", error: errorDetail(cause).message }); }
    finally { if (!abort.signal.aborted) contentReads.current.delete(contentId); }
  }
  function retry(key: string) {
    const cached = memory.inputs.get(key); if (cached) { void command(cached.operation, cached.input); return; }
    const request = requests.find(item => requestKey(bindingId, item.operation, item.requestId) === key); if (!request) return;
    if (request.operation === "createMemberSession" || request.operation === "createAgentSession") { void command("retrySessionBindingCreation", { bindingId }); return; }
    if (isMessage(request.operation)) { setRetryKey(key); setNotice("Enter the exact original message. Retry preserves the original Team request and its Core mapping."); setTab("conversation"); return; }
    const interaction = details?.core?.interactions.find(item => item.interactionId === request.interactionId && item.turnId === request.turnId);
    const retained = interaction?.details ?? interactionDetails.get(interaction?.content.contentId ?? "");
    if (request.operation === "answerBindingQuestions" && !retained?.answers) { setError({ code: "ORIGINAL_INPUT_REQUIRED", message: privacy.current ? "The original answers are unavailable in Team. Inspect the original interaction in Core." : "Load the original interaction answers before retrying.", retryable: false }); if (interaction?.content.contentId) void loadInteraction(interaction.content.contentId); return; }
    void command(request.operation, { bindingId, requestId: request.requestId, ...(request.turnId ? { turnId: request.turnId } : {}), ...(request.operation === "answerBindingQuestions" ? { interactionId: request.interactionId, answers: retained!.answers } : {}) });
  }
  const pendingMessage = requests.some(item => isMessage(item.operation) && unresolved(item)) || [...memory.inputs.values()].some(item => item.input.bindingId === bindingId && isMessage(item.operation));
  const canSteer = !privateContext && executionReady && !pendingMessage && active?.codexTurnId && ["running", "awaiting_input", "awaiting_approval"].includes(active.state);
  const canSend = !privateContext && executionReady && !pendingMessage && session?.codexThreadId && session.runtimeState !== "unknown" && !session.activeTurnId;
  const original = requests.find(item => requestKey(bindingId, item.operation, item.requestId) === retryKey && isMessage(item.operation));
  const originalTurn = display?.turns.find(turn => turn.turnId === original?.turnId);
  const chatRequests: ChatRequest[] = requests.map(item => ({ key: requestKey(bindingId, item.operation, item.requestId), requestId: item.requestId, label: labels[item.operation] ?? item.operation, status: item.result?.status ?? (item.error && !item.error.retryable ? "error" : "unknown"), error: item.error ? `${item.error.code}: ${item.error.message}` : null, canRetry: !unavailable && !busy && unresolved(item) }));
  for (const [key, pending] of memory.inputs) if (pending.input.bindingId === bindingId && !chatRequests.some(item => item.key === key)) chatRequests.push({ key, requestId: String(pending.input.requestId ?? binding?.createRequestId), label: labels[logicalOperation(pending.operation)] ?? pending.operation, status: pending.result?.operation?.status ?? "unknown", error: pending.result?.error?.message ?? "Delivery is not confirmed. Retry the original request.", canRetry: !unavailable && !busy });
  const interactions = (display?.interactions ?? []).map(item => ({ ...item, ...(item.details ?? interactionDetails.get(item.content.contentId ?? "") ? { details: item.details ?? interactionDetails.get(item.content.contentId ?? "")! } : {}) }));
  const model = buildChatModel({ sessionKey: bindingId, turns: display?.turns ?? [], ...projectHistoryWindow(observed.history, display?.turns ?? [], session?.activeTurnId ?? null), interactions, requests: chatRequests, restricted: privateContext });
  if (paused || readOnly) model.requests=model.requests.map(request=>({...request,canRetry:false}));
  const creation = requests.find(item => item.operation === binding?.createOperation), connect = requests.find(item => item.operation === "connectSessionBinding" && unresolved(item));
  return <>
    {embedded ? <h2>{member?.name ?? catalog.definitions.find(item=>item.definitionId===binding?.agentRef.id)?.name ?? "Agent session"}</h2> : <PageHeading eyebrow="AGENT SESSION" title={member?.name ?? catalog.definitions.find(item => item.definitionId === binding?.agentRef.id)?.name ?? "Agent session"} description={binding?.workDir ?? "Loading session…"} actions={<button className="button secondary" onClick={() => navigate(member ? { page: "teams", teamId: member.teamId } : { page: "sessions" })}>← Back</button>} />}
    <div className="session-toolbar"><div className="status-group"><Badge tone={ready ? "good" : "warning"}>{!unavailable && session ? session.connectionState : "Connection unknown"}</Badge><Badge tone={!unavailable && session?.runtimeState === "running" ? "purple" : "neutral"}>{!unavailable && session ? session.runtimeState.replaceAll("_", " ") : "Runtime unknown"}</Badge><span className="muted">{binding?.hostId} · {shortId(binding?.sessionId ?? null)}</span></div><div className="heading-actions">
      {creation && unresolved(creation) && (!binding?.sessionId || creation.result?.status === "unknown" || creation.error) && <button className="button secondary small" disabled={busy} onClick={() => void command("retrySessionBindingCreation", { bindingId })}>Retry creation</button>}
      <button className="button secondary small" disabled={busy || unavailable || !binding?.sessionId || Boolean(session?.activeTurnId) || ready} onClick={() => void command("connectSessionBinding", { bindingId, requestId: connect?.requestId ?? crypto.randomUUID() })}>{connect ? "Retry connection" : "Connect session"}</button>
    </div></div>
    <ErrorNotice error={observed.error ?? details?.coreError ?? null} /><ErrorNotice error={error} />{notice && <p className="notice" role="status">{notice}</p>}
    {privateContext && <div className="notice warning"><p>This conversation contains private operator input. Continue in Core.</p>{operatorUrl && <a href={operatorUrl} target="_blank" rel="noreferrer">Open Core ↗</a>}</div>}
    <div className="tabs" role="tablist" aria-label="Session views">{(["conversation", "configuration"] as const).map((item, index, items) => <button role="tab" id={`tab-${item}`} aria-controls={`panel-${item}`} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} key={item} onClick={() => setTab(item)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]!;
      setTab(next); document.getElementById(`tab-${next}`)?.focus();
    }}>{item}</button>)}</div>
    <section className="conversation-panel" id="panel-conversation" role="tabpanel" aria-labelledby="tab-conversation" hidden={tab !== "conversation"}>
      <ChatView hideComposer={readOnly} model={model} draft={draft} onDraftChange={changeDraft}
        composer={{ action: original && executionReady ? "retry" : canSteer ? "steer" : canSend ? "send" : "disabled", turnId: active?.turnId ?? null, mode: original?.mode ?? originalTurn?.mode ?? active?.mode ?? draft.mode, modeLocked: Boolean(active || original), retryRequestKey: retryKey, busy, reason: paused ? "Execution submissions are paused on this host daemon. Reading and interruption remain available." : original ? "Retry preserves the original request, mode and Core mapping." : privateContext ? "Continue this private conversation in Core." : unavailable || !ready ? "Reconnect the session to send. Your draft stays in this binding." : pendingMessage ? "An earlier message is unresolved. Inspect request delivery." : null }}
        history={{ loading: !details, hasOlder: Boolean(observed.history.beforeCursor || observed.history.beforeContextCursor), loadingOlder: observed.loadingOlder, error: [observed.historyError, display?.interactionsError].filter(Boolean).map(item => item!.message).join(" · ") || null }}
        contents={contents} loadingInteractions={loadingInteractions} canReadContent={ref => !privateContext && ref.authority === "agent"} contentReadsAvailable={!unavailable} canRespond={item => !privateContext && item.kind === "questions" && item.authority === "agent" && !item.sensitive} canSubmitInteraction={item => Boolean(executionReady && item.status === "pending" && item.turnId === session?.activeTurnId)} {...(operatorUrl ? { operatorUrl } : {})}
        onSend={input => run("sendBindingMessage", input)} onSteer={input => run("steerBindingTurn", input)} onAnswer={input => run("answerBindingQuestions", input)} onDecideApproval={() => setError({ code: "FORBIDDEN", message: "Decide approvals in Core.", retryable: false })}
        onInterrupt={ready && session?.activeTurnId ? () => run("interruptBindingTurn", { turnId: session.activeTurnId }) : null}
        onRetry={retry} onRetryMessage={({ requestKey: key, message }) => { const target = requests.find(item => requestKey(bindingId, item.operation, item.requestId) === key && isMessage(item.operation)); if (target) void command(target.operation, { bindingId, requestId: target.requestId, message, ...(target.operation === "steerBindingTurn" ? { turnId: target.turnId } : { mode: target.mode ?? "default" }) }); }} onCancelRetry={retryKey ? () => setRetryKey(null) : null}
        onLoadOlder={() => void observed.loadOlder()} onLoadContent={(ref, action) => void loadContent(ref, action)} onLoadInteraction={item => { if (item.content.authority === "agent" && item.content.contentId) void loadInteraction(item.content.contentId); }} />
    </section>
    {tab === "configuration" && <section className="card configuration-panel" id="panel-configuration" role="tabpanel" aria-labelledby="tab-configuration"><div className="section-heading"><h2>Session configuration</h2><Badge tone="purple">Fixed at creation</Badge></div><p className="muted">Definition {binding?.agentRef.id === "default" ? "Default Codex" : shortId(binding?.agentRef.id ?? null)} · revision {binding?.agentRef.revision}</p>
      {unavailable && display && <p className="field-hint">Showing the last observed Core snapshot.</p>}
      <div className="info-grid"><div><span>Model</span><strong>{display?.session.sessionConfig?.resolved?.model ?? "Not resolved yet"}</strong></div><div><span>Reasoning effort</span><strong>{display?.session.sessionConfig?.resolved?.reasoningEffort ?? "Model default"}</strong></div><div><span>Approval policy</span><strong>{display?.session.sessionConfig?.resolved?.approvalPolicy ?? "From host"}</strong></div><div><span>Provider</span><strong>{display?.session.sessionConfig?.resolved?.modelProvider ?? "From host"}</strong></div></div>
      <h3>Requested overrides</h3><pre className="code-block">{details?.requestedOptions ? JSON.stringify(details.requestedOptions, null, 2) : "Creation record unavailable."}</pre><h3>Resolved additional developer instructions</h3><pre className="code-block">{display?.session.sessionConfig?.resolved?.developerInstructions ?? "Core has not resolved the configuration."}</pre>
    </section>}
  </>;
}
