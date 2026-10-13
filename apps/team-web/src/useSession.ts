import { useEffect, useRef, useState } from "react";
import type { ApiError, CoreHistory, CoreSessionDetails, SessionBindingDetails } from "@dewbow/team-protocol";
import { call, errorDetail } from "./api.js";
import { emptyHistory, mergeHistory, restrictHistory, type ChatHistoryState } from "@dewbow/core-ui/chat/model";

export function useSession(bindingId: string) {
  const [details, setDetails] = useState<SessionBindingDetails | null>(null);
  const [lastCore, setLastCore] = useState<CoreSessionDetails | null>(null);
  const [history, setHistory] = useState<ChatHistoryState>(emptyHistory);
  const [error, setError] = useState<ApiError | null>(null);
  const [historyError, setHistoryError] = useState<ApiError | null>(null);
  const savedRef = useRef(emptyHistory());
  const controllerRef = useRef<AbortController|null>(null);
  const [loadingOlder,setLoadingOlder] = useState(false);
  const olderRead = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    savedRef.current = emptyHistory();
    let saved = savedRef.current;
    setLoadingOlder(false); olderRead.current = false;
    setDetails(null); setLastCore(null); setHistory(saved); setError(null); setHistoryError(null);
    async function poll() {
      try {
        const current = await call<SessionBindingDetails>("getSessionBinding", { bindingId }, controller.signal);
        if (controller.signal.aborted) return;
        setDetails(current); setError(null);
        if (current.core) setLastCore(current.core);
        if (current.core?.contextAuthority === "operator") {
          savedRef.current = restrictHistory(savedRef.current); saved = savedRef.current; setHistory(saved);
        }
        if (current.binding.sessionId && !current.coreError) {
          try {
            for (let pages = 0; pages < 25; pages++) {
              saved = savedRef.current;
              const cursor = saved.updateCursor;
              const page = await call<CoreHistory>("readBindingHistory",{bindingId,cursor:saved.eventCursor,limit:50,...(saved.contextCursor!==undefined ? {contextCursor:saved.contextCursor} : {}),...(cursor ? { updateCursor:cursor } : {})},controller.signal);
              if (controller.signal.aborted) return;
              saved = mergeHistory(savedRef.current,page,cursor || saved.contextCursor!==undefined ? "newer" : "initial"); savedRef.current = saved;
              setHistory(saved); setHistoryError(page.historyError ?? page.eventsError ?? null);
              if (page.historyError || page.eventsError || (!page.hasMore && !page.hasMoreUpdates && !page.hasMoreContexts)) break;
            }
          } catch (cause) { if (!controller.signal.aborted) setHistoryError(errorDetail(cause)); }
        } else if (current.coreError) setHistoryError(current.coreError);
      } catch (cause) { if (!controller.signal.aborted) setError(errorDetail(cause)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [bindingId]);
  async function loadOlder() {
    const controller = controllerRef.current, cursor = savedRef.current.beforeCursor;
    if (!controller || controller.signal.aborted || !cursor && !savedRef.current.beforeContextCursor || olderRead.current) return;
    olderRead.current = true;
    setLoadingOlder(true);
    try {
      const page = await call<CoreHistory>("readBindingHistory",{bindingId,...(cursor ? {beforeCursor:cursor} : {}),...(savedRef.current.beforeContextCursor ? {beforeContextCursor:savedRef.current.beforeContextCursor} : {}),cursor:savedRef.current.eventCursor,limit:50},controller.signal);
      if (controller.signal.aborted) return;
      if (!cursor) page.beforeCursor=savedRef.current.beforeCursor;
      if (!savedRef.current.beforeContextCursor) page.beforeContextCursor=savedRef.current.beforeContextCursor??null;
      savedRef.current = mergeHistory(savedRef.current,page,"older"); setHistory(savedRef.current); setHistoryError(page.historyError ?? page.eventsError ?? null);
    } catch (cause) { if (!controller.signal.aborted) setHistoryError(errorDetail(cause)); }
    finally { if (!controller.signal.aborted) { olderRead.current = false; setLoadingOlder(false); } }
  }
  return { details,lastCore,history,error,historyError,loadOlder,loadingOlder };
}
