import type { ContentRef } from "@dewbow/core-protocol";
import type { ChatViewProps, ChatContentState } from "./types.js";
import { Button, Badge } from "../ui/index.js";

export function ContentView({ content, state, allowed, available, onLoad }: { content: ContentRef; state: ChatContentState | undefined; allowed: boolean; available: boolean; onLoad: ChatViewProps["onLoadContent"] }) {
  if (!allowed) return <p className="chat-muted">This content requires the Core operator.</p>;
  if (!content.contentId || content.availability === "unavailable") return <p className="chat-muted">{content.label}: content unavailable.</p>;
  const status = state?.completeness ?? content.completeness;
  const lines = content.kind === "diff" && state ? state.text.split("\n") : null;
  return <section className="chat-content" aria-label={content.label}>
    <div className="chat-content-heading"><strong>{content.label}</strong><Badge variant="outline">{status === "complete" ? "Full content available" : status === "partial" ? "Partially recorded" : "Completeness unknown"}</Badge></div>
    {!state && <Button variant="outline" disabled={!available} onClick={() => onLoad(content, "first")}>Load {content.kind === "diff" ? "file diff" : "tool output"}</Button>}
    {state && <>
      <pre className={content.kind === "diff" ? "chat-diff" : "chat-output"} tabIndex={0} aria-label={`${content.label} text`}>
        {lines && lines.length <= 5000 ? lines.map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "chat-diff-add" : line.startsWith("-") && !line.startsWith("---") ? "chat-diff-remove" : ""}>{line}{index < lines.length - 1 ? "\n" : ""}</span>) : state.text}
      </pre>
      <div className="chat-content-actions">
        <small className="chat-muted">{state.bytesLoaded.toLocaleString()} bytes loaded</small>
        {state.status === "loading" && <span role="status">Loading content…</span>}
        {state.nextCursor && <Button variant="outline" disabled={!available || state.status === "loading"} onClick={() => onLoad(content, "more")}>Load more content</Button>}
        {!state.nextCursor && status !== "complete" && <Button variant="outline" disabled={!available || state.status === "loading"} onClick={() => onLoad(content, "refresh")}>Refresh content</Button>}
        {state.status === "error" && <><span role="alert">{state.error}</span><Button variant="outline" disabled={!available} onClick={() => onLoad(content, state.text ? "more" : "first")}>Retry content read</Button></>}
      </div>
    </>}
  </section>;
}
