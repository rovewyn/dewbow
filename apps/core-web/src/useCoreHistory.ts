import { useEffect, useRef, useState } from "react";
import { emptyHistory, mergeHistory } from "@dewbow/core-ui/chat/model";
import { api } from "./api";
import type { History } from "./api";

export function useCoreHistory(sessionId: string) {
  const [history, setHistory] = useState(emptyHistory), saved = useRef(emptyHistory());
  const [loading, setLoading] = useState(true), [loadingOlder, setLoadingOlder] = useState(false), [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), olderRead = useRef(false);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; saved.current = emptyHistory(); setHistory(saved.current);
    setLoading(true); setError(null); setLoadingOlder(false); olderRead.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        for (let count = 0; count < 25; count++) {
          const snapshot = saved.current, updateCursor = snapshot.updateCursor;
          const page = await api<History>("readSessionHistory", { sessionId, cursor: snapshot.eventCursor, limit: 50, ...(snapshot.contextCursor!==undefined ? {contextCursor:snapshot.contextCursor} : {}), ...(updateCursor ? { updateCursor } : {}) }, abort.signal);
          if (abort.signal.aborted) return;
          saved.current = mergeHistory(saved.current, page, updateCursor || snapshot.contextCursor!==undefined ? "newer" : "initial"); setHistory(saved.current);
          setError([page.historyError, page.eventsError].filter(Boolean).map(item => `${item!.code}: ${item!.message}`).join(" · ") || null);
          if (page.historyError || page.eventsError || !page.hasMore && !page.hasMoreUpdates && !page.hasMoreContexts) break;
        }
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "History could not be read."); }
      finally { if (!abort.signal.aborted) { setLoading(false); timer = setTimeout(() => void poll(), 1500); } }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [sessionId]);
  async function loadOlder() {
    const abort = controller.current, cursor = saved.current.beforeCursor;
    if (!abort || abort.signal.aborted || !cursor && !saved.current.beforeContextCursor || olderRead.current) return;
    olderRead.current = true; setLoadingOlder(true);
    try {
      const page = await api<History>("readSessionHistory", { sessionId, ...(cursor ? {beforeCursor:cursor} : {}), ...(saved.current.beforeContextCursor ? {beforeContextCursor:saved.current.beforeContextCursor} : {}), cursor: saved.current.eventCursor, limit: 50 }, abort.signal);
      if (abort.signal.aborted) return;
      if (!cursor) page.beforeCursor=saved.current.beforeCursor;
      if (!saved.current.beforeContextCursor) page.beforeContextCursor=saved.current.beforeContextCursor??null;
      saved.current = mergeHistory(saved.current, page, "older"); setHistory(saved.current);
      setError([page.historyError, page.eventsError].filter(Boolean).map(item => `${item!.code}: ${item!.message}`).join(" · ") || null);
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Older history could not be read."); }
    finally { if (!abort.signal.aborted) { olderRead.current = false; setLoadingOlder(false); } }
  }
  return { history, loading, loadingOlder, error, loadOlder };
}
