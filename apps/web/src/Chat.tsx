import { useEffect, useRef, useState } from "react";
import { ChatView } from "@dewbow/ui/chat";
import type { ChatContentState, ChatDraft, ChatRequest } from "@dewbow/ui/chat";
import { buildChatModel, projectHistoryWindow } from "@dewbow/ui/chat/model";
import type { ContentPage, ContentRef, Interaction, InteractionDetails } from "@dewbow/protocol";
import { api, ApiError, readInteractionDetails } from "./api";
import type { Detail, OperationSummary } from "./api";
import type { useHistory } from "./useHistory";

interface PendingInput { operation: string; input: Record<string, unknown>; result: OperationSummary | null }
export interface ChatMemory { drafts: Map<string, ChatDraft>; inputs: Map<string, PendingInput> }
export const createChatMemory = (): ChatMemory => ({ drafts: new Map(), inputs: new Map() });
const labels: Record<string, string> = { sendMessage: "Send message", steerTurn: "Add instruction", answerQuestions: "Answer questions", decideApproval: "Decide approval", interruptTurn: "Interrupt turn", connectSession: "Connect session", createSession: "Create session" };
const isMessage = (operation: string) => ["sendMessage", "steerTurn"].includes(operation);
const describe = (cause: unknown) => cause instanceof Error ? cause.message : "Request failed.";
const inputKey = (sessionId: string, operation: string, requestId: string) => JSON.stringify([sessionId, operation, requestId]);
function pendingKey(operation: OperationSummary) { return inputKey(operation.sessionId, operation.operation, operation.requestId); }
function matchesPending(pending: PendingInput | undefined, operation: OperationSummary): pending is PendingInput {
  return Boolean(pending && operation.authority === "operator" && pending.operation === operation.operation && pending.input.sessionId === operation.sessionId && pending.input.requestId === operation.requestId && (!pending.result || pending.result.commandId === operation.commandId));
}

export function Chat({ detail, connected, memory, globalBusy, observed }: { detail: Detail; connected: boolean; memory: ChatMemory; globalBusy: boolean; observed: ReturnType<typeof useHistory> }) {
  const sessionId = detail.session.sessionId;
  const [draft, setDraft] = useState<ChatDraft>(() => memory.drafts.get(sessionId) ?? { text: "", mode: "default" });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [contents, setContents] = useState(new Map<string, ChatContentState>()), contentRef = useRef(contents);
  const [details, setDetails] = useState(new Map<string, InteractionDetails>()), [loadingInteractions, setLoadingInteractions] = useState(new Set<string>());
  const reads = useRef<AbortController | null>(null), contentReads = useRef(new Set<string>()), interactionReads = useRef(new Set<string>()), mutation = useRef(false);
  useEffect(() => { const abort = new AbortController(); reads.current = abort; return () => abort.abort(); }, [sessionId]);
  function changeDraft(next: ChatDraft) { memory.drafts.set(sessionId, next); setDraft(next); }
  function updateContent(contentId: string, value: ChatContentState) { const next = new Map(contentRef.current).set(contentId, value); contentRef.current = next; setContents(next); }
  useEffect(() => {
    for (const operation of detail.operations) {
      const key = pendingKey(operation), pending = memory.inputs.get(key);
      if (!matchesPending(pending, operation) || !["delivered", "error"].includes(operation.status)) continue;
      memory.inputs.delete(key);
      if (operation.status === "delivered" && typeof pending.input.message === "string") {
        const saved = memory.drafts.get(sessionId);
        if (saved?.text === pending.input.message) { const next = { ...saved, text: "" }; memory.drafts.set(sessionId, next); setDraft(next); }
      }
      setRetryId(current => current === operation.commandId ? null : current);
    }
  }, [detail.operations, memory, sessionId]);

  async function execute(operation: string, input: Record<string, unknown>) {
    if (mutation.current) return;
    const abort = reads.current; if (!abort || abort.signal.aborted) return;
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    const requestId = String(input.requestId), key = inputKey(sessionId, operation, requestId), pending: PendingInput = { operation, input, result: null };
    memory.inputs.set(key, pending);
    try {
      const result = await api<OperationSummary>(operation, input, abort.signal); pending.result = result;
      if (["delivered", "error"].includes(result.status) && memory.inputs.get(key) === pending) {
        memory.inputs.delete(key);
        const saved = memory.drafts.get(sessionId);
        if (result.status === "delivered" && typeof input.message === "string" && input.message === saved?.text) memory.drafts.set(sessionId, { ...saved, text: "" });
      }
      if (abort.signal.aborted) return;
      setNotice(`${labels[operation] ?? operation}: ${result.status}. Turn completion is observed separately.`);
      if (["delivered", "error"].includes(result.status)) {
        setRetryId(null); setDraft(memory.drafts.get(sessionId) ?? { text: "", mode: "default" });
        if (result.error) setError(result.error.message);
      }
    } catch (cause) {
      if (cause instanceof ApiError && !cause.detail.retryable && memory.inputs.get(key) === pending) memory.inputs.delete(key);
      if (abort.signal.aborted) return;
      setError(describe(cause));
    } finally { if (!abort.signal.aborted) { mutation.current = false; setBusy(false); } }
  }
  function run(operation: string, input: Record<string, unknown>) { void execute(operation, { sessionId, ...input, requestId: crypto.randomUUID() }); }
  async function loadInteraction(interaction: Interaction) {
    const contentId = interaction.content.contentId, abort = reads.current;
    if (!contentId || !abort || abort.signal.aborted || interactionReads.current.has(contentId)) return;
    interactionReads.current.add(contentId); setLoadingInteractions(new Set(interactionReads.current));
    try { const value = await readInteractionDetails(sessionId, contentId, abort.signal); if (!abort.signal.aborted) setDetails(previous => new Map(previous).set(contentId, value)); }
    catch (cause) { if (!abort.signal.aborted) setError(describe(cause)); }
    finally { if (!abort.signal.aborted) { interactionReads.current.delete(contentId); setLoadingInteractions(new Set(interactionReads.current)); } }
  }
  async function loadContent(ref: ContentRef, action: "first" | "more" | "refresh") {
    const contentId = ref.contentId, abort = reads.current;
    if (!contentId || !abort || abort.signal.aborted || contentReads.current.has(contentId)) return;
    const previous = contentRef.current.get(contentId), cursor = action === "more" ? previous?.nextCursor : null;
    if (action === "more" && !cursor) return;
    contentReads.current.add(contentId);
    const baseline: ChatContentState = action === "more" && previous ? previous : { status: "ready", text: "", nextCursor: null, bytesLoaded: 0, completeness: ref.completeness, error: null };
    updateContent(contentId, { ...baseline, status: "loading", error: null });
    try {
      const page = await api<ContentPage>("readSessionContent", { sessionId, contentId, limitBytes: 65536, ...(cursor ? { contentCursor: cursor } : {}) }, abort.signal);
      if (abort.signal.aborted) return;
      const bytes = new TextEncoder().encode(page.text).length;
      if (page.contentId !== contentId || page.byteOffset !== baseline.bytesLoaded || page.nextCursor && (!bytes || page.nextCursor === cursor)) throw new Error("Content read did not advance from the expected position.");
      updateContent(contentId, { status: "ready", text: baseline.text + page.text, nextCursor: page.nextCursor, bytesLoaded: page.byteOffset + bytes, completeness: page.completeness, error: null });
    } catch (cause) { if (!abort.signal.aborted) updateContent(contentId, { ...baseline, status: "error", error: describe(cause) }); }
    finally { if (!abort.signal.aborted) contentReads.current.delete(contentId); }
  }
  function retry(requestKey: string) {
    const cached = memory.inputs.get(requestKey);
    if (cached) { void execute(cached.operation, cached.input); return; }
    const operation = detail.operations.find(item => item.commandId === requestKey && item.authority === "operator"); if (!operation) return;
    const cachedInput = memory.inputs.get(pendingKey(operation));
    if (matchesPending(cachedInput, operation)) { void execute(cachedInput!.operation, cachedInput!.input); return; }
    const requestId = operation.requestId;
    if (isMessage(operation.operation)) { setRetryId(operation.commandId); setNotice("Enter the exact original message. This retry preserves its request ID and operation."); return; }
    const interaction = detail.interactions.find(item => item.requestId === requestId && item.turnId === operation.turnId), retained = interaction?.details ?? details.get(interaction?.content.contentId ?? "");
    if (operation.operation === "interruptTurn" || operation.operation === "connectSession") { void execute(operation.operation, { sessionId, requestId, ...(operation.turnId ? { turnId: operation.turnId } : {}) }); return; }
    if (interaction && operation.operation === "decideApproval" && interaction.decision) { void execute(operation.operation, { sessionId, requestId, turnId: interaction.turnId, interactionId: interaction.interactionId, decision: interaction.decision }); return; }
    if (interaction && operation.operation === "answerQuestions" && retained?.answers) { void execute(operation.operation, { sessionId, requestId, turnId: interaction.turnId, interactionId: interaction.interactionId, answers: retained.answers }); return; }
    setError("The original input is unavailable. Load the recorded interaction details before retrying.");
    if (interaction) void loadInteraction(interaction);
  }
  const active = detail.turns.find(turn => turn.turnId === detail.session.activeTurnId), original = detail.operations.find(item => item.commandId === retryId && item.authority === "operator");
  const ready = connected && detail.session.connectionState === "connected";
  const pendingMessage = detail.operations.some(item => isMessage(item.operation) && ["accepted", "unknown"].includes(item.status)) || [...memory.inputs.values()].some(item => item.input.sessionId === sessionId && isMessage(item.operation));
  const canSteer = ready && !pendingMessage && active?.codexTurnId && ["running", "awaiting_input", "awaiting_approval"].includes(active.state);
  const canSend = ready && detail.session.managed && detail.session.codexThreadId && detail.session.runtimeState !== "unknown" && !detail.session.activeTurnId && !pendingMessage;
  const interactions = detail.interactions.map(item => ({ ...item, ...(item.details ?? details.get(item.content.contentId ?? "") ? { details: item.details ?? details.get(item.content.contentId ?? "")! } : {}) }));
  const requests: ChatRequest[] = detail.operations.map(item => ({ key: item.commandId, requestId: item.requestId, label: labels[item.operation] ?? item.operation, status: item.status, error: item.error ? `${item.error.code}: ${item.error.message}` : item.authority === "agent" && item.status === "unknown" ? "Retry through the original client." : null, canRetry: item.authority === "operator" && item.operation !== "createSession" && (item.status === "unknown" || matchesPending(memory.inputs.get(pendingKey(item)), item) && item.status === "accepted") }));
  for (const [key, pending] of memory.inputs) if (pending.input.sessionId === sessionId && !detail.operations.some(item => matchesPending(pending, item))) requests.push({ key, requestId: String(pending.input.requestId), label: labels[pending.operation] ?? pending.operation, status: pending.result?.status ?? "unknown", error: pending.result?.error?.message ?? (pending.result ? null : "Delivery is not confirmed. Retry the original request."), canRetry: !busy });
  const model = buildChatModel({ sessionKey: sessionId, turns: detail.turns, ...projectHistoryWindow(observed.history, detail.turns, detail.session.activeTurnId), interactions, requests });
  const originalTurn = original ? detail.turns.find(turn => turn.turnId === original.turnId) : undefined;
  return <>
    {error && <p className="chat-error" role="alert">{error}</p>}{notice && <p className="chat-notice" role="status">{notice}</p>}
    <ChatView model={model} draft={draft} onDraftChange={changeDraft}
      composer={{ action: original && ready ? "retry" : canSteer ? "steer" : canSend ? "send" : "disabled", turnId: active?.turnId ?? null, mode: originalTurn?.mode ?? active?.mode ?? draft.mode, modeLocked: Boolean(active || original), retryRequestKey: retryId, busy: busy || globalBusy, reason: original ? "Retry uses the original request ID, mode and message." : !ready ? "Reconnect the host to send. Your draft stays in this session." : pendingMessage ? "An earlier message is unresolved. Inspect request delivery before continuing." : null }}
      history={{ loading: observed.loading, hasOlder: Boolean(observed.history.beforeCursor), loadingOlder: observed.loadingOlder, error: [observed.error, detail.interactionsError?.message].filter(Boolean).join(" · ") || null }}
      contents={contents} loadingInteractions={loadingInteractions} canReadContent={() => true} contentReadsAvailable={connected} canRespond={() => true} canSubmitInteraction={item => ready && item.turnId === detail.session.activeTurnId && item.status === "pending"}
      onSend={input => run("sendMessage", input)} onSteer={input => run("steerTurn", input)} onAnswer={input => run("answerQuestions", input)} onDecideApproval={input => run("decideApproval", input)}
      onInterrupt={ready && detail.session.activeTurnId ? () => run("interruptTurn", { turnId: detail.session.activeTurnId }) : null}
      onRetry={retry} onRetryMessage={({ requestKey, message }) => { const target = detail.operations.find(item => item.commandId === requestKey && item.authority === "operator"); const turn = target && detail.turns.find(item => item.turnId === target.turnId); if (!target || !turn) { setError("The original turn metadata is unavailable."); return; } void execute(target.operation, { sessionId, requestId: target.requestId, message, ...(target.operation === "steerTurn" ? { turnId: target.turnId } : { mode: turn.mode }) }); }}
      onCancelRetry={retryId ? () => setRetryId(null) : null} onLoadOlder={() => void observed.loadOlder()} onLoadContent={(ref, action) => void loadContent(ref, action)} onLoadInteraction={item => void loadInteraction(item)} />
  </>;
}
