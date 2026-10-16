import { useEffect, useRef, useState } from "react";
import type { RemoteSessionUpdates, SessionDetails, SessionUpdates } from "@dewbow/protocol";
import { emptyHistory, mergeHistory } from "@dewbow/ui/chat/model";
import { subscribeUpdates } from "@dewbow/ui/chat/updates";
import { api, ApiError } from "./api";
import { sessionUpdatesPath } from "./apiRoutes";
import type { History } from "./api";
import { parseSelection, selectionInput } from "./targets";
import { RemoteUpdates } from "./remoteUpdates";

export function useHistory(key: string) {
  const { sessionId, target } = parseSelection(key);
  const [history, setHistory] = useState(emptyHistory), saved = useRef(emptyHistory());
  const [details, setDetails] = useState<SessionDetails | null>(null), [authExpired, setAuthExpired] = useState(false);
  const [loading, setLoading] = useState(true), [loadingOlder, setLoadingOlder] = useState(false), [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), olderRead = useRef(false);
  const instance = useRef<string | null>(null);
  const generation = useRef(0);
  const [observedKey, setObservedKey] = useState("");
  const [runtimeId, setRuntimeId] = useState("");
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; saved.current = emptyHistory(); setHistory(saved.current);
    setObservedKey(key); setDetails(null); setLoading(true); setError(null); setAuthExpired(false); setLoadingOlder(false); olderRead.current = false; instance.current = null;
    if (!sessionId) return () => abort.abort();
    const remoteUpdates = target ? new RemoteUpdates(target, sessionId) : null;
    const dispose = subscribeUpdates<SessionUpdates | RemoteSessionUpdates>(sessionUpdatesPath(sessionId, target), () => target ? {} : ({ cursor: saved.current.eventCursor, updateCursor: saved.current.updateCursor }), envelope => {
      let value: SessionUpdates;
      if (abort.signal.aborted) return;
      if (remoteUpdates) {
        const observed = remoteUpdates.consume(envelope as RemoteSessionUpdates);
        if (observed.reset) { saved.current = emptyHistory(); generation.current++; }
        value = observed.value;
      } else value = envelope as SessionUpdates;
      if (abort.signal.aborted || value.details.session.sessionId !== sessionId) return;
      if (instance.current !== value.instanceId) {
        saved.current = emptyHistory();
        instance.current = value.instanceId;
        generation.current++;
        setRuntimeId(value.instanceId);
      }
      setDetails(value.details);
      saved.current = mergeHistory(saved.current, value.history, saved.current.updateCursor ? "newer" : "initial");
      setHistory(saved.current); setLoading(false);
      setError([value.history.historyError, value.history.eventsError].filter(Boolean).map(item => `${item!.code}: ${item!.message}`).join(" · ") || null);
    }, cause => {
      if (abort.signal.aborted) return;
      setDetails(null);
      setError(cause.message); setLoading(false);
      void api("listHosts", {}, abort.signal).catch(error => { if (!abort.signal.aborted && error instanceof ApiError && error.detail.code === "UNAUTHORIZED") setAuthExpired(true); });
    });
    return () => { abort.abort(); dispose(); };
  }, [key]);
  async function loadOlder() {
    const abort = controller.current, cursor = saved.current.beforeCursor;
    if (!abort || abort.signal.aborted || !cursor || olderRead.current) return;
    olderRead.current = true; setLoadingOlder(true);
    const originalGeneration = generation.current;
    try {
      const page = await api<History>("readSessionHistory", { ...selectionInput(key), beforeCursor: cursor, cursor: saved.current.eventCursor, limit: 50 }, abort.signal);
      if (abort.signal.aborted || generation.current !== originalGeneration) return;
      saved.current = mergeHistory(saved.current, page, "older"); setHistory(saved.current);
      setError([page.historyError, page.eventsError].filter(Boolean).map(item => `${item!.code}: ${item!.message}`).join(" · ") || null);
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Older history could not be read."); }
    finally { if (!abort.signal.aborted) { olderRead.current = false; setLoadingOlder(false); } }
  }
  return { details: observedKey === key ? details : null, runtimeId, authExpired, history, loading, loadingOlder, error, loadOlder };
}
