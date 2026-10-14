import type { HistoryPosition, ManagementErrorData } from "@dewbow/protocol";

/** Reconnect with committed history cursors, rather than replaying token deltas. */
export function subscribeUpdates<T>(path: string, position: () => HistoryPosition, receive: (value: T) => void, onError: (error: ManagementErrorData) => void): () => void {
  let source: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  function retry(error: ManagementErrorData) {
    source?.close(); source = undefined;
    if (closed) return;
    onError(error); clearTimeout(timer);
    if (error.code !== "UNAUTHORIZED") timer = setTimeout(connect, 1500);
  }
  function connect() {
    if (closed) return;
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(position())) if (value !== undefined) url.searchParams.set(key, String(value));
    const current = source = new EventSource(url.href);
    const update = (event: MessageEvent) => {
      if (closed || source !== current) return;
      try { receive(JSON.parse(event.data) as T); }
      catch { retry({ code: "STREAM_UNAVAILABLE", message: "Updates are unavailable. Reconnecting…", retryable: true }); }
    };
    current.addEventListener("snapshot", update); current.addEventListener("update", update);
    current.addEventListener("streamError", event => {
      if (closed || source !== current) return;
      try { retry(JSON.parse((event as MessageEvent).data) as ManagementErrorData); }
      catch { retry({ code: "STREAM_UNAVAILABLE", message: "Updates are unavailable. Reconnecting…", retryable: true }); }
    });
    current.onerror = () => { if (source === current && !closed) retry({ code: "STREAM_UNAVAILABLE", message: "Updates disconnected. Reconnecting…", retryable: true }); };
  }
  connect();
  return () => { closed = true; clearTimeout(timer); source?.close(); source = undefined; };
}
