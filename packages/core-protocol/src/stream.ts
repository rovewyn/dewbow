import type { ServerResponse } from "node:http";

/** Process-local notifications. Durable records and history remain authoritative. */
export class ChangeSignal {
  private readonly listeners = new Set<(topic: string) => void>();
  subscribe(listener: (topic: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify(topic: string): void { for (const listener of this.listeners) listener(topic); }
}

/** Coalesce changes while a read is in flight; never poll an idle subscription. */
export async function observeChanges(subscribe: (notify: () => void) => () => void, read: (initial: boolean) => Promise<void>, signal: AbortSignal): Promise<void> {
  let dirty = true, initial = true, wake: (() => void) | undefined;
  const notify = () => { dirty = true; wake?.(); };
  const unsubscribe = subscribe(notify);
  const abort = () => wake?.();
  signal.addEventListener("abort", abort);
  try {
    while (!signal.aborted) {
      if (!dirty) await new Promise<void>(resolve => { wake = resolve; if (dirty || signal.aborted) resolve(); });
      wake = undefined;
      if (signal.aborted) break;
      dirty = false;
      await read(initial); initial = false;
      if (!signal.aborted) await new Promise<void>(resolve => {
        const timer = setTimeout(done, 100);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  } finally { unsubscribe(); signal.removeEventListener("abort", abort); }
}

export function createEventStream(response: ServerResponse, authorize: () => void) {
  const controller = new AbortController();
  let sequence = 0;
  const close = () => { controller.abort(); clearInterval(heartbeat); if (!response.writableEnded) response.end(); };
  const error = (code = "STREAM_UNAVAILABLE") => {
    if (!controller.signal.aborted) response.write(`event: streamError\ndata: ${JSON.stringify({ code, message: "The subscription must reconnect or sign in again.", retryable: true })}\n\n`);
    close();
  };
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  response.flushHeaders();
  const heartbeat = setInterval(() => {
    try { authorize(); response.write(": keepalive\n\n"); } catch { error("UNAUTHORIZED"); }
  }, 15000);
  heartbeat.unref(); response.once("close", close);
  return { signal: controller.signal, close, error,
    send(event: "snapshot" | "update", value: unknown): void {
      if (controller.signal.aborted) return;
      try { authorize(); } catch { error("UNAUTHORIZED"); return; }
      if (response.writableLength > 16 * 1024 * 1024) { error(); return; }
      response.write(`id: ${++sequence}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    },
  };
}

/** Fetch-based SSE reader for authenticated service-to-service subscriptions. */
export async function* readEventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", event = "message", data: string[] = [], size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length + size > 16 * 1024 * 1024) throw new Error("Subscription frame exceeds its budget.");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) yield { event, data: JSON.parse(data.join("\n")) as unknown };
          event = "message"; data = []; size = 0;
        } else if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) { const value = line.slice(5).replace(/^ /, ""); data.push(value); size += value.length; }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
