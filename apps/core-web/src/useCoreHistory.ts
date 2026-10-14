import { useEffect, useRef, useState } from "react";
import type { SessionDetails, SessionUpdates } from "@dewbow/core-protocol";
import { emptyHistory, mergeHistory } from "@dewbow/core-ui/chat/model";
import { subscribeUpdates } from "@dewbow/core-ui/chat/updates";
import { api, ApiError } from "./api";
import type { History } from "./api";

export function useCoreHistory(sessionId: string) {
  const [history, setHistory] = useState(emptyHistory), saved = useRef(emptyHistory());
  const [details, setDetails] = useState<SessionDetails | null>(null), [authExpired, setAuthExpired] = useState(false);
  const [loading, setLoading] = useState(true), [loadingOlder, setLoadingOlder] = useState(false), [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), olderRead = useRef(false);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; saved.current = emptyHistory(); setHistory(saved.current);
    setDetails(null); setLoading(true); setError(null); setAuthExpired(false); setLoadingOlder(false); olderRead.current = false;
    if (!sessionId) return () => abort.abort();
    const dispose = subscribeUpdates<SessionUpdates>(`/api/subscribeSessionUpdates?${new URLSearchParams({ sessionId })}`, () => ({ cursor: saved.current.eventCursor, updateCursor: saved.current.updateCursor, contextCursor: saved.current.contextCursor }), value => {
      if (abort.signal.aborted || value.details.session.sessionId !== sessionId) return;
      setDetails(value.details);
      saved.current = mergeHistory(saved.current, value.history, saved.current.updateCursor || saved.current.contextCursor !== undefined ? "newer" : "initial");
      setHistory(saved.current); setLoading(false);
      setError([value.history.historyError, value.history.eventsError].filter(Boolean).map(item => `${item!.code}: ${item!.message}`).join(" · ") || null);
    }, cause => {
      if (abort.signal.aborted) return;
      setError(cause.message); setLoading(false);
      void api("listHosts", {}, abort.signal).catch(error => { if (!abort.signal.aborted && error instanceof ApiError && error.detail.code === "UNAUTHORIZED") setAuthExpired(true); });
    });
    return () => { abort.abort(); dispose(); };
  }, [sessionId]);
  async function loadOlder() {
    const abort = controller.current, cursor = saved.current.beforeCursor;
    if (!abort || abort.signal.aborted || !cursor && !saved.current.beforeContextCursor || olderRead.current) return;
    olderRead.current = true; setLoadingOlder(true);
    try {
      const page = await api<History>("readSessionHistory", { sessionId, ...(cursor ? { beforeCursor: cursor } : {}), ...(saved.current.beforeContextCursor ? { beforeContextCursor: saved.current.beforeContextCursor } : {}), cursor: saved.current.eventCursor, limit: 50 }, abort.signal);
      if (abort.signal.aborted) return;
      if (!cursor) page.beforeCursor = saved.current.beforeCursor;
      if (!saved.current.beforeContextCursor) page.beforeContextCursor = saved.current.beforeContextCursor ?? null;
      saved.current = mergeHistory(saved.current, page, "older"); setHistory(saved.current);
      setError([page.historyError, page.eventsError].filter(Boolean).map(item => `${item!.code}: ${item!.message}`).join(" · ") || null);
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Older history could not be read."); }
    finally { if (!abort.signal.aborted) { olderRead.current = false; setLoadingOlder(false); } }
  }
  return { details, authExpired, history, loading, loadingOlder, error, loadOlder };
}
