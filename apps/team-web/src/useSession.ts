import { useEffect, useState } from "react";
import type { ApiError, CoreHistory, CoreSessionDetails, SessionBindingDetails } from "@dewbow-team/protocol";
import { call, errorDetail } from "./api.js";
import { emptyHistory, mergeHistory, type HistoryState } from "./history.js";

export function useSession(bindingId: string) {
  const [details, setDetails] = useState<SessionBindingDetails | null>(null);
  const [lastCore, setLastCore] = useState<CoreSessionDetails | null>(null);
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  const [error, setError] = useState<ApiError | null>(null);
  const [historyError, setHistoryError] = useState<ApiError | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saved = emptyHistory();
    setDetails(null); setLastCore(null); setHistory(saved); setError(null); setHistoryError(null);
    async function poll() {
      try {
        const current = await call<SessionBindingDetails>("getSessionBinding", { bindingId }, controller.signal);
        if (controller.signal.aborted) return;
        setDetails(current); setError(null);
        if (current.core) setLastCore(current.core);
        if (current.binding.sessionId && !current.coreError) {
          try {
            for (let pages = 0; pages < 25; pages++) {
              const cursor = saved.messageCursor;
              const page = await call<CoreHistory>("readMemberSessionHistory", { bindingId, cursor: saved.eventCursor, limit: 100,
                ...(cursor ? { messageCursor: cursor } : {}) }, controller.signal);
              if (controller.signal.aborted) return;
              saved = mergeHistory(saved, page, cursor);
              setHistory(saved); setHistoryError(page.historyError ?? page.eventsError ?? null);
              if (page.historyError || page.eventsError || (!page.hasMore && page.nextMessageCursor === null)) break;
            }
          } catch (cause) { if (!controller.signal.aborted) setHistoryError(errorDetail(cause)); }
        } else if (current.coreError) setHistoryError(current.coreError);
      } catch (cause) { if (!controller.signal.aborted) setError(errorDetail(cause)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [bindingId]);
  return { details, lastCore, history, error, historyError };
}
