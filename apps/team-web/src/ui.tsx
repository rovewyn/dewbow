import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ApiError } from "@dewbow-team/protocol";
import { useMutation } from "./useMutation.js";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warning" | "purple" | "danger" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-mark" aria-hidden="true">◇</span><h3>{title}</h3><p>{children}</p></div>;
}

export function ErrorNotice({ error, onRetry }: { error: ApiError | null; onRetry?: (() => void) | undefined }) {
  if (!error) return null;
  return <div className="notice error" role="alert"><div><strong>{error.code.replaceAll("_", " ")}</strong><p>{error.message}</p></div>{onRetry && <button className="button secondary small" onClick={onRetry}>Retry same request</button>}</div>;
}

export function Modal({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled)")?.focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button></header>
    {children}
  </dialog>, document.body);
}

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></header>;
}

export function field(form: HTMLFormElement, name: string): string { return String(new FormData(form).get(name) ?? ""); }
export const shortId = (id: string | null): string => id ? id.slice(0, 8) : "Pending";

export function ConfirmAction({ title, children, operation, input, actionLabel, onClose, onSaved, danger = false }: {
  title: string; children: ReactNode; operation: string; input: Record<string, unknown>; actionLabel: string;
  onClose: () => void; onSaved: () => Promise<void>; danger?: boolean;
}) {
  const mutation = useMutation(async () => { onClose(); await onSaved(); });
  return <Modal title={title} onClose={onClose} busy={mutation.busy}><div className="form-body">{children}<ErrorNotice error={mutation.error} onRetry={mutation.retryRequired ? mutation.retry : undefined} /></div><footer className="form-footer"><button className="button secondary" disabled={mutation.busy} onClick={onClose}>Cancel</button><button className={`button ${danger ? "danger" : "primary"}`} disabled={mutation.busy || mutation.retryRequired} onClick={() => void mutation.send(operation, input)}>{actionLabel}</button></footer></Modal>;
}
