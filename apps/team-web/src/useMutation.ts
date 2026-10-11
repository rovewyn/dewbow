import { useRef, useState } from "react";
import type { ApiError } from "@dewbow-team/protocol";
import { call, errorDetail } from "./api.js";

export function useMutation<T>(onSuccess: (result: T) => void | Promise<void>) {
  const last = useRef<{ operation: string; input: Record<string, unknown> } | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [retryRequired, setRetryRequired] = useState(false);

  async function send(operation: string, input: Record<string, unknown>, addRequestId = true) {
    if (inFlight.current) return;
    const pending = retryRequired && last.current ? last.current : {
      operation, input: { ...input, ...(addRequestId && !input.requestId ? { requestId: crypto.randomUUID() } : {}) },
    };
    last.current = pending;
    inFlight.current = true;
    setBusy(true); setError(null);
    let confirmed = false;
    try {
      const result = await call<T>(pending.operation, pending.input);
      confirmed = true;
      last.current = null; setRetryRequired(false);
      await onSuccess(result);
    } catch (cause) {
      const detail = confirmed ? { code: "REFRESH_FAILED", message: "The change was saved. Refresh the workspace to view it.", retryable: false } : errorDetail(cause);
      setError(detail); setRetryRequired(detail.retryable);
      if (!detail.retryable) last.current = null;
    } finally { inFlight.current = false; setBusy(false); }
  }

  const retry = () => { if (last.current) void send(last.current.operation, last.current.input, false); };
  const resetError = () => { if (!inFlight.current && !retryRequired) setError(null); };
  return { busy, error, retryRequired, send, retry, resetError };
}
