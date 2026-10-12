import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiError, MemberOperation, MemberSessionResult, SessionBinding,InteractionDetails } from "@dewbow/team-protocol";
import { call, errorDetail,readInteractionDetails } from "./api.js";
import { visibleMessages } from "./history.js";
import type { Catalog, Route } from "./model.js";
import { Badge, Empty, ErrorNotice, PageHeading, shortId } from "./ui.js";
import { useSession } from "./useSession.js";
import {QuestionForm} from "./QuestionForm.js";

function pending(request: MemberOperation): boolean {
  return request.result ? ["accepted", "unknown"].includes(request.result.status) : !request.error || request.error.retryable;
}

const operationLabels: Record<string, string> = { createMemberSession: "Create session", connectMemberSession: "Connect session", sendMemberMessage: "Send message", steerMemberTurn:"Add instruction",answerMemberQuestions:"Answer questions",interruptMemberTurn: "Interrupt turn" };
const isMessage=(operation:string)=>["sendMemberMessage","steerMemberTurn"].includes(operation);

export function SessionPage({ bindingId, catalog, navigate, onBindingChanged }: { bindingId: string; catalog: Catalog; navigate: (route: Route) => void; onBindingChanged: (binding: SessionBinding) => void }) {
  const observed = useSession(bindingId);
  const [tab, setTab] = useState<"conversation" | "configuration" | "requests">("conversation");
  const [message, setMessage] = useState("");
  const [mode,setMode]=useState<"default"|"plan">("default");
  const [retryRequestId, setRetryRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<ApiError | null>(null);
  const [uncertainCommand, setUncertainCommand] = useState<{ operation: string; input: Record<string, unknown> } | null>(null);
  const inFlight = useRef(false);
  const messageBodies = useRef(new Map<string, string>());
  const requestInputs=useRef(new Map<string,Record<string,unknown>>());
  const requestNames=useRef(new Map<string,string>());
  const [loadedInteractions,setLoadedInteractions]=useState(new Map<string,InteractionDetails>());
  const [loadingInteractions,setLoadingInteractions]=useState(new Set<string>());
  const detailReads=useRef<AbortController|null>(null);
  useEffect(()=>{const controller=new AbortController();detailReads.current=controller;setLoadedInteractions(new Map());setLoadingInteractions(new Set());return()=>controller.abort();},[bindingId]);
  const chatRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const details = observed.details;
  const binding = details?.binding ?? catalog.bindings.find(item => item.bindingId === bindingId);
  const member = catalog.members.find(item => item.memberId === binding?.memberId);
  const session = details?.core?.session;
  const display = details?.core ?? observed.lastCore;
  const requests = details?.requests ?? [];
  const messages = visibleMessages(observed.history);
  const uncertainSend = requests.find(request => isMessage(request.operation) && pending(request));
  const originalSend = retryRequestId ? requests.find(request => request.requestId === retryRequestId && isMessage(request.operation)) : undefined;
  const activeTurn=details?.core?.turns.find(turn=>turn.turnId===session?.activeTurnId);
  const unavailable = Boolean(details?.coreError || observed.error);
  const privateContext=details?.core?.contextAuthority === "operator";
  const canSteer=Boolean(!privateContext && !unavailable && session?.connectionState === "connected" && activeTurn?.codexTurnId && ["running","awaiting_input","awaiting_approval"].includes(activeTurn.state) && !uncertainSend && !uncertainCommand);
  const canSendNew = Boolean(!privateContext && !unavailable && session && session.connectionState === "connected" && session.runtimeState !== "unknown" && !session.activeTurnId && !uncertainSend && !uncertainCommand);
  const waitingDelivery = Boolean(originalSend?.result?.status === "accepted" && !originalSend.error);
  const canRetrySend = Boolean(retryRequestId && !waitingDelivery && !busy && !details?.coreError && !observed.error);
  useEffect(() => {
    if (!retryRequestId) return;
    const request = requests.find(item => item.requestId === retryRequestId && isMessage(item.operation));
    if (request?.result?.status === "delivered") {
      messageBodies.current.delete(retryRequestId); setRetryRequestId(null); setMessage(""); setCommandError(null);
    } else if (request && !pending(request)) { messageBodies.current.delete(retryRequestId); setRetryRequestId(null); }
  }, [details, retryRequestId]);
  useEffect(() => {
    const request = requests.find(item => uncertainCommand?.operation === "retryMemberSessionCreation"
      ? item.operation === "createMemberSession" && item.requestId === binding?.createRequestId
      : item.requestId === uncertainCommand?.input.requestId && item.operation === uncertainCommand?.operation);
    if (request && !pending(request)) { setUncertainCommand(null); setCommandError(request.error); }
  }, [details, uncertainCommand]);
  useEffect(() => { if (chatRef.current && stickToBottom.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [observed.history]);

  async function command(operation: string, input: Record<string, unknown>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setCommandError(null);
    if(typeof input.requestId === "string"){requestInputs.current.set(input.requestId,input);requestNames.current.set(input.requestId,operation);}
    try {
      const result = await call<MemberSessionResult>(operation, input);
      onBindingChanged(result.binding);
      setUncertainCommand(null);
      if (result.error) {
        setCommandError(result.error);
        if (result.error.retryable) setUncertainCommand({ operation, input });
        if (isMessage(operation) && !result.error.retryable) { messageBodies.current.delete(input.requestId as string); setRetryRequestId(null); }
      } else if (isMessage(operation) && result.operation?.status === "delivered") {
        messageBodies.current.delete(input.requestId as string); setMessage(""); setRetryRequestId(null);
      }
    } catch (cause) {
      const detail = errorDetail(cause); setCommandError(detail);
      setUncertainCommand(detail.retryable ? { operation, input } : null);
      if (isMessage(operation) && !detail.retryable) { messageBodies.current.delete(input.requestId as string); setRetryRequestId(null); }
    }
    finally { inFlight.current = false; setBusy(false); }
  }

  function retry(request: MemberOperation) {
    if (request.operation === "createMemberSession") void command("retryMemberSessionCreation", { bindingId });
    else if (isMessage(request.operation)) {
      requestNames.current.set(request.requestId,request.operation);
      setRetryRequestId(request.requestId); setMessage(messageBodies.current.get(request.requestId) ?? ""); setTab("conversation");
    } else if(request.operation === "answerMemberQuestions") {
      const input=requestInputs.current.get(request.requestId),answers=details?.core?.interactions.find(item=>item.interactionId===request.interactionId)?.details?.answers;
      if(input)void command(request.operation,input);
      else if(answers)void command(request.operation,{bindingId,requestId:request.requestId,turnId:request.turnId,interactionId:request.interactionId,answers});
      else setCommandError({code:"ORIGINAL_INPUT_REQUIRED",message:"The original structured answers are unavailable. Inspect the interaction in Core before retrying.",retryable:false});
    } else void command(request.operation, { bindingId, requestId: request.requestId, ...(request.turnId ? { turnId: request.turnId } : {}) });
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || (retryRequestId ? !canRetrySend : !canSendNew && !canSteer)) return;
    const requestId = retryRequestId ?? crypto.randomUUID();
    const text = messageBodies.current.get(requestId) ?? message;
    messageBodies.current.set(requestId, text); setRetryRequestId(requestId);
    const operation=requestNames.current.get(requestId) ?? originalSend?.operation ?? (canSteer ? "steerMemberTurn" : "sendMemberMessage");
    const input=requestInputs.current.get(requestId) ?? {bindingId,message:text,requestId,...(operation === "steerMemberTurn" ? {turnId:originalSend?.turnId??activeTurn!.turnId} : {mode:originalSend?.mode??mode})};
    void command(operation,input);
  }

  const connectRequest = requests.find(request => request.operation === "connectMemberSession" && pending(request));
  const interruptRequest = requests.find(request => request.operation === "interruptMemberTurn" && request.turnId === session?.activeTurnId && pending(request));
  const creation = requests.find(request => request.operation === "createMemberSession");
  const needsCreationRetry = Boolean(creation && pending(creation) && (!binding?.sessionId || creation.result?.status === "unknown" || creation.error));
  return <>
    <PageHeading eyebrow="MEMBER SESSION" title={member?.name ?? "Member session"} description={binding?.workDir ?? "Loading session…"} actions={<button className="button secondary" onClick={() => navigate(member ? { page: "teams", teamId: member.teamId } : { page: "sessions" })}>← Back</button>} />
    <div className="session-toolbar"><div className="status-group"><Badge tone={!unavailable && session?.connectionState === "connected" ? "good" : "warning"}>{!unavailable && session ? session.connectionState : "Connection unknown"}</Badge><Badge tone={!unavailable && session?.runtimeState === "running" ? "purple" : "neutral"}>{!unavailable && session ? session.runtimeState.replaceAll("_", " ") : "Runtime unknown"}</Badge><span className="muted">{binding?.hostId} · {shortId(binding?.sessionId ?? null)}</span></div>
      <div className="heading-actions">{needsCreationRetry && <button className="button secondary small" disabled={busy} onClick={() => void command("retryMemberSessionCreation", { bindingId })}>Retry creation</button>}
        <button className="button secondary small" disabled={busy || unavailable || Boolean(uncertainCommand) || !details || !binding?.sessionId || Boolean(session?.activeTurnId) || session?.connectionState === "connected"} onClick={() => void command("connectMemberSession", { bindingId, requestId: connectRequest?.requestId ?? crypto.randomUUID() })}>{connectRequest ? "Retry connection" : "Connect session"}</button>
        <button className="button secondary small" disabled={busy || unavailable || Boolean(uncertainCommand) || !session?.activeTurnId} onClick={() => void command("interruptMemberTurn", { bindingId, turnId: session!.activeTurnId, requestId: interruptRequest?.requestId ?? crypto.randomUUID() })}>Interrupt turn</button></div>
    </div>
    <ErrorNotice error={observed.error ?? details?.coreError ?? null} />
    {!binding?.sessionId && !commandError && <ErrorNotice error={creation?.error ?? null} />}
    <ErrorNotice error={commandError} onRetry={uncertainCommand && !busy ? () => void command(uncertainCommand.operation, uncertainCommand.input) : undefined} />
    {privateContext && <div className="notice warning"><p>This conversation contains private operator input. Continue in Core.</p>{catalog.service.coreUrl && <a className="button secondary" href={catalog.service.coreUrl} target="_blank" rel="noreferrer">Open Core ↗</a>}</div>}
    {!unavailable && session?.runtimeState === "awaiting_approval" && <div className="notice warning"><div><strong>Waiting for approval</strong><p>Review this action in Dewbow Core.</p></div>{catalog.service.coreUrl && <a className="button secondary small" href={catalog.service.coreUrl} target="_blank" rel="noreferrer">Open Core ↗</a>}</div>}
    <div className="tabs" role="tablist" aria-label="Session views">{(["conversation", "configuration", "requests"] as const).map((item, index, items) => <button role="tab" id={`tab-${item}`} aria-controls={`panel-${item}`} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} key={item} onClick={() => setTab(item)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]!;
      setTab(next); document.getElementById(`tab-${next}`)?.focus();
    }}>{item}</button>)}</div>
    {tab === "conversation" && <section className="conversation-panel" id="panel-conversation" role="tabpanel" aria-labelledby="tab-conversation">
      <ErrorNotice error={observed.historyError} />
      <ErrorNotice error={details?.core?.interactionsError??null}/>
      {details?.core?.interactions.filter(item=>["pending","requested","delivered"].includes(item.status)).map(raw=>{const item={...raw,details:raw.details??loadedInteractions.get(raw.content.contentId??"")};return <article className="card notice warning" key={item.interactionId}><div><strong>{item.kind === "questions" ? "Questions" : "Core operator action"} · {item.status}</strong>
        {!privateContext && item.kind === "questions" && item.authority === "agent" && !item.details && item.content.contentId && <button className="button secondary" disabled={busy || unavailable || loadingInteractions.has(item.content.contentId)} onClick={()=>{
          const contentId=item.content.contentId!,controller=detailReads.current;setLoadingInteractions(previous=>new Set(previous).add(contentId));
          void readInteractionDetails(bindingId,contentId,controller?.signal).then(details=>{if(!controller?.signal.aborted)setLoadedInteractions(previous=>new Map(previous).set(contentId,details));}).catch(cause=>{if(!controller?.signal.aborted)setCommandError(errorDetail(cause));}).finally(()=>{if(!controller?.signal.aborted)setLoadingInteractions(previous=>{const next=new Set(previous);next.delete(contentId);return next;});});
        }}>{loadingInteractions.has(item.content.contentId) ? "Loading questions…" : "Load questions"}</button>}
        {!privateContext && item.kind === "questions" && item.authority === "agent" && item.details?.questions ? <QuestionForm questions={item.details.questions} disabled={busy || unavailable || item.status!=="pending" || item.turnId!==session?.activeTurnId} onAnswer={answers=>void command("answerMemberQuestions",{bindingId,turnId:item.turnId,interactionId:item.interactionId,requestId:crypto.randomUUID(),answers})}/> : <p>Respond in Dewbow Core.</p>}
      </div>{item.authority === "operator" && catalog.service.coreUrl && <a className="button secondary" href={`${catalog.service.coreUrl.replace(/\/$/,"")}/#${new URLSearchParams({session:binding?.sessionId??""})}`} target="_blank" rel="noreferrer">Open Core ↗</a>}</article>;})}
      <div className="conversation" ref={chatRef} role="log" aria-label="Conversation history" aria-live="polite" onScroll={() => { if (chatRef.current) stickToBottom.current = chatRef.current.scrollHeight - chatRef.current.scrollTop - chatRef.current.clientHeight < 64; }}>
        {observed.history.beforeCursor && <button className="button secondary small" disabled={observed.loadingOlder} onClick={() => {
          const list = chatRef.current, height = list?.scrollHeight ?? 0, top = list?.scrollTop ?? 0;
          stickToBottom.current = false;
          void observed.loadOlder().then(() => requestAnimationFrame(() => { if (list && chatRef.current === list) list.scrollTop = top+list.scrollHeight-height; }));
        }}>{observed.loadingOlder ? "Loading older history…" : "Load older history"}</button>}
        {!messages.length ? <Empty title={details ? "No saved messages" : "Loading conversation"}>{binding?.sessionId ? "Messages come from the existing Codex conversation." : "Finish session creation to start the conversation."}</Empty> : messages.map(item => <article className={`message ${item.role}`} key={item.id}><div className="message-heading"><span className={`message-avatar ${item.role}`}>{item.role === "user" ? "Y" : "C"}</span><strong>{item.role === "user" ? "You" : "Codex"}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><pre className="message-text">{item.availability === "restricted" ? "This turn contains private operator input. View it in Core." : item.text}</pre></article>)}
      </div>
      {uncertainSend && !retryRequestId && <div className="notice warning"><p>An earlier message is unresolved. Retry it with the original text.</p><button className="button secondary small" onClick={() => retry(uncertainSend)}>Restore original message</button></div>}
      <form className="composer" onSubmit={send}><label className="sr-only" htmlFor="message">Message</label><textarea id="message" rows={3} maxLength={100000} value={message} readOnly={Boolean(retryRequestId && messageBodies.current.has(retryRequestId))} disabled={busy || (!retryRequestId && !canSendNew && !canSteer)} onChange={event => setMessage(event.target.value)} placeholder={retryRequestId ? "Enter the exact original message to retry" : canSteer ? "Add an instruction to this turn…" : "Give this agent a task…"} /><footer><select aria-label="Turn mode" value={originalSend?.mode??activeTurn?.mode??mode} disabled={busy || Boolean(activeTurn) || Boolean(retryRequestId)} onChange={event=>setMode(event.target.value as "default"|"plan")}><option value="default">Default</option><option value="plan">Plan</option></select><span className="muted">{retryRequestId ? waitingDelivery ? "Message accepted. Waiting for delivery." : "Retry uses the original request ID and message." : canSteer ? "Instruction uses the current turn mode." : canSendNew ? "This message stays in the existing session." : "Connect the session before continuing."}</span><button className="button primary" disabled={busy || !message.trim() || (retryRequestId ? !canRetrySend : !canSendNew && !canSteer)}>{busy ? "Sending…" : retryRequestId ? "Retry original message" : canSteer ? "Add instruction" : "Send message"}</button></footer></form>
    </section>}
    {tab === "configuration" && <section className="card configuration-panel" id="panel-configuration" role="tabpanel" aria-labelledby="tab-configuration"><div className="section-heading"><h2>Session configuration</h2><Badge tone="purple">Fixed at creation</Badge></div><p className="muted">Definition {binding?.agentRef.id === "default" ? "Default Codex" : shortId(binding?.agentRef.id ?? null)} · revision {binding?.agentRef.revision}</p>
      {unavailable && display && <p className="field-hint">Showing the last observed Core snapshot.</p>}
      <div className="info-grid"><div><span>Model</span><strong>{display?.session.sessionConfig?.resolved?.model ?? "Not resolved yet"}</strong></div><div><span>Reasoning effort</span><strong>{display?.session.sessionConfig?.resolved?.reasoningEffort ?? "Model default"}</strong></div><div><span>Approval policy</span><strong>{display?.session.sessionConfig?.resolved?.approvalPolicy ?? "From host"}</strong></div><div><span>Provider</span><strong>{display?.session.sessionConfig?.resolved?.modelProvider ?? "From host"}</strong></div></div>
      <h3>Requested overrides</h3><pre className="code-block">{details?.requestedOptions ? JSON.stringify(details.requestedOptions, null, 2) : "Creation record unavailable."}</pre><h3>Resolved additional developer instructions</h3><pre className="code-block">{display?.session.sessionConfig?.resolved?.developerInstructions ?? "Core has not resolved the configuration."}</pre>
    </section>}
    {tab === "requests" && <section id="panel-requests" role="tabpanel" aria-labelledby="tab-requests"><p className="muted">Delivery describes the command. Turn completion is reported separately by Core.</p><div className="request-list">{requests.map(request => <article className="request-row card" key={`${request.operation}:${request.requestId}`}><div><strong>{operationLabels[request.operation] ?? request.operation}</strong><code>{request.requestId}</code>{request.error && <p className="danger-text">{request.error.message}</p>}</div><Badge tone={request.result?.status === "delivered" ? "good" : "warning"}>{request.result?.status ?? (request.error?.retryable ? "unknown" : request.error ? "error" : "pending")}</Badge>{pending(request) && <button className="button secondary small" disabled={busy} onClick={() => retry(request)}>{request.operation === "sendMemberMessage" ? "Restore message" : "Retry"}</button>}</article>)}</div></section>}
  </>;
}
