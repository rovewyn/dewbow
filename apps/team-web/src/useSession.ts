import { useEffect, useRef, useState } from "react";
import type { ApiError, BindingUpdates, ChannelConversationDetails, ChannelConversationUpdates, CoreHistory, CoreSessionDetails, SessionBindingDetails } from "@dewbow/team-protocol";
import { subscribeUpdates } from "@dewbow/core-ui/chat/updates";
import { emptyHistory, mergeHistory, restrictHistory } from "@dewbow/core-ui/chat/model";
import { call, errorDetail, confirmSubscriptionAuth } from "./api.js";

export function useSession(bindingId: string, conversationId?: string) {
  const [details, setDetails] = useState<SessionBindingDetails | null>(null), [lastCore, setLastCore] = useState<CoreSessionDetails | null>(null);
  const [conversation, setConversation] = useState<ChannelConversationDetails | null>(null), [history, setHistory] = useState(emptyHistory);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null), [historyError, setHistoryError] = useState<ApiError | null>(null);
  const saved = useRef(emptyHistory()), sessionId = useRef<string | null>(null), actualBindingId = useRef(bindingId);
  const controller = useRef<AbortController | null>(null), olderRead = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    saved.current = emptyHistory(); sessionId.current = null; actualBindingId.current = bindingId;
    setDetails(null); setLastCore(null); setConversation(null); setHistory(saved.current); setHistoryLoaded(false); setError(null); setHistoryError(null); setLoadingOlder(false); olderRead.current = false;
    if (!bindingId && !conversationId) return () => abort.abort();
    const path = conversationId ? `/api/subscribeChannelConversationUpdates?${new URLSearchParams({ conversationId })}` : `/api/subscribeBindingUpdates?${new URLSearchParams({ bindingId })}`;
    const dispose = subscribeUpdates<BindingUpdates | ChannelConversationUpdates>(path, () => ({ cursor: saved.current.eventCursor, updateCursor: saved.current.updateCursor, contextCursor: saved.current.contextCursor, resumeSessionId: sessionId.current ?? undefined }), value => {
      if (abort.signal.aborted) return;
      if ("conversation" in value) setConversation(value.conversation);
      if (value.details) {
        const current = value.details;
        if (actualBindingId.current !== current.binding.bindingId) { actualBindingId.current = current.binding.bindingId; saved.current = emptyHistory(); setHistoryLoaded(false); setLastCore(null); }
        sessionId.current = current.binding.sessionId;
        setDetails(current); setError(null);
        if (current.core) setLastCore(current.core);
        if (current.core?.contextAuthority === "operator") saved.current = restrictHistory(saved.current);
        if (current.coreError) setHistoryError(current.coreError);
      }
      if (value.history) {
        setHistoryLoaded(true);
        const direction = saved.current.updateCursor || saved.current.contextCursor !== undefined ? "newer" : "initial";
        saved.current = mergeHistory(saved.current, value.history, direction);
        setHistoryError(value.history.historyError ?? value.history.eventsError ?? value.details?.coreError ?? null);
      }
      setHistory(saved.current);
    }, cause => { if (!abort.signal.aborted) { setError(cause); void confirmSubscriptionAuth(); } });
    return () => { abort.abort(); dispose(); };
  }, [bindingId, conversationId]);
  async function loadOlder() {
    const abort = controller.current, cursor = saved.current.beforeCursor, target = actualBindingId.current;
    if (!target || !abort || abort.signal.aborted || !cursor && !saved.current.beforeContextCursor || olderRead.current) return;
    olderRead.current = true; setLoadingOlder(true);
    try {
      const page = await call<CoreHistory>("readBindingHistory", { bindingId: target, ...(cursor ? { beforeCursor: cursor } : {}), ...(saved.current.beforeContextCursor ? { beforeContextCursor: saved.current.beforeContextCursor } : {}), cursor: saved.current.eventCursor, limit: 50 }, abort.signal);
      if (abort.signal.aborted || target !== actualBindingId.current) return;
      if (!cursor) page.beforeCursor = saved.current.beforeCursor;
      if (!saved.current.beforeContextCursor) page.beforeContextCursor = saved.current.beforeContextCursor ?? null;
      saved.current = mergeHistory(saved.current, page, "older"); setHistory(saved.current); setHistoryError(page.historyError ?? page.eventsError ?? null);
    } catch (cause) { if (!abort.signal.aborted) setHistoryError(errorDetail(cause)); }
    finally { if (!abort.signal.aborted) { olderRead.current = false; setLoadingOlder(false); } }
  }
  return { details, lastCore, conversation, history, historyLoaded, error, historyError, loadOlder, loadingOlder };
}
