import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, ChatViewProps } from "./types.js";
import type { SessionActivity } from "@dewbow/core-protocol";
import { Badge, Button, NativeSelect, NativeSelectOption, Textarea } from "../ui/index.js";
import { ContentView } from "./ContentView.js";
import { InteractionCard } from "./InteractionCard.js";

const messageLabels = { user: "You", instruction: "Additional instruction", progress: "Codex · progress", final: "Codex" };
function Message({ message }: { message: ChatMessage }) {
  return <article className={`chat-message chat-message-${message.kind}`} data-message-id={message.id}>
    <div className="chat-message-heading"><strong>{messageLabels[message.kind]}</strong>{!message.complete && <span className="chat-muted">In progress</span>}</div>
    <div className="chat-message-body">{message.restricted ? "This turn contains private operator input. View it in Core." : message.text}</div>
  </article>;
}

function ActivityGroup({ activities, view }: { activities: SessionActivity[]; view: ChatViewProps }) {
  return <details className="chat-activities"><summary>Tool activity <span>{activities.length}</span></summary><div className="chat-activity-list">
    {activities.map(activity => <article className="chat-activity" key={activity.id}>
      <div className="chat-content-heading"><strong>{activity.title}</strong><Badge variant="outline">{activity.status ?? (activity.itemComplete ? "Recorded" : "Running")}</Badge></div>
      {activity.command && <pre className="chat-action">{activity.command}</pre>}
      {activity.paths && <ul>{activity.paths.map(path => <li key={path}>{path}</li>)}</ul>}
      {activity.availability === "restricted" ? <p>This activity requires the Core operator.</p> : activity.contents.map((content, index) => <ContentView key={`${content.contentId}-${index}`} content={content} state={content.contentId ? view.contents.get(content.contentId) : undefined} allowed={view.canReadContent(content)} available={view.contentReadsAvailable} onLoad={view.onLoadContent} />)}
    </article>)}
  </div></details>;
}

/** All I/O and durable state belong to the host; this view owns visual disclosure and scrolling. */
export function ChatView(view: ChatViewProps) {
  const id = useId(), list = useRef<HTMLDivElement>(null), follow = useRef(true);
  const prepend = useRef<{ height: number; top: number; anchor: string | null; offset: number; restoreFocus: boolean } | null>(null), previousSession = useRef("");
  const [atBottom, setAtBottom] = useState(true);
  function pauseFollow() { follow.current = false; setAtBottom(false); }
  useLayoutEffect(() => {
    const element = list.current; if (!element) return;
    if (previousSession.current !== view.model.sessionKey) {
      previousSession.current = view.model.sessionKey; follow.current = true; prepend.current = null;
    }
    if (prepend.current && !view.history.loadingOlder) {
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-chat-entry]")].find(item => item.dataset.chatEntry === prepend.current?.anchor);
      if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - prepend.current.offset;
      else element.scrollTop = prepend.current.top + element.scrollHeight - prepend.current.height;
      if (prepend.current.restoreFocus) element.focus({ preventScroll: true });
      prepend.current = null;
    } else if (follow.current && !prepend.current) element.scrollTop = element.scrollHeight;
  }, [view.model, view.history.loadingOlder]);
  const enabled = view.composer.action !== "disabled" && !view.composer.busy;
  const attention = view.model.turns.flatMap(turn => turn.interactions.filter(item => ["pending", "requested", "delivered"].includes(item.status)));
  return <div className="dewbow-chat">
    {attention.length > 0 && <div className="chat-attention" role="status"><strong>{attention.length} {attention.length === 1 ? "response needs" : "responses need"} attention</strong><Button variant="outline" onClick={() => {
      const target = [...(list.current?.querySelectorAll<HTMLElement>("[data-interaction-id]") ?? [])].find(item => item.dataset.interactionId === attention[0]!.interactionId);
      target?.scrollIntoView({ block: "center" }); target?.focus({ preventScroll: true });
    }}>View request</Button></div>}
    {view.model.notices.map(notice => <p className="chat-notice" role="status" key={notice}>{notice}</p>)}
    {view.history.error && <p className="chat-error" role="alert">{view.history.error}</p>}
    <div ref={list} className="chat-timeline" role="region" aria-label="Conversation history" tabIndex={0} onClickCapture={event => { if ((event.target as HTMLElement).closest("summary, button")) pauseFollow(); }} onScroll={() => {
      const element = list.current; if (!element) return;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; setAtBottom(follow.current);
    }}>
      {view.history.hasOlder && <div className="chat-older"><Button variant="outline" disabled={view.history.loadingOlder} onClick={event => {
        const element = list.current;
        if (element) { const edge = element.getBoundingClientRect().top; const anchor = [...element.querySelectorAll<HTMLElement>("[data-chat-entry]")].find(item => item.getBoundingClientRect().bottom > edge);
          prepend.current = { height: element.scrollHeight, top: element.scrollTop, anchor: anchor?.dataset.chatEntry ?? null, offset: anchor ? anchor.getBoundingClientRect().top - edge : 0, restoreFocus: event.currentTarget === document.activeElement }; }
        follow.current = false; view.onLoadOlder();
      }}>{view.history.loadingOlder ? "Loading older history…" : "Load older history"}</Button></div>}
      {!view.model.turns.length && <p className="chat-empty" role="status">{view.history.loading ? "Loading conversation…" : "No messages yet."}</p>}
      {view.model.turns.map(turn => <section className="chat-turn" key={turn.key} aria-label="Conversation turn" data-turn-key={turn.key}>
        <div className="chat-turn-heading">{turn.mode && <Badge variant="outline">{turn.mode === "plan" ? "Plan" : "Default"}</Badge>}{turn.state && <span>{turn.state.replaceAll("_", " ")}</span>}</div>
        {turn.entries.map((entry, index) => {
          if (entry.kind === "activity" && turn.entries[index - 1]?.kind === "activity") return null;
          const activities: SessionActivity[] = [];
          if (entry.kind === "activity") for (const candidate of turn.entries.slice(index)) { if (candidate.kind !== "activity") break; activities.push(candidate.activity); }
          return <div data-chat-entry={entry.id} key={entry.id}>{entry.kind === "message" ? <Message message={entry.message} /> : entry.kind === "progress" ? <div className="chat-plan"><strong>Progress</strong><pre>{entry.progress.text}</pre></div> : entry.kind === "interaction" ? <InteractionCard interaction={entry.interaction} view={view} /> : <ActivityGroup activities={activities} view={view} />}</div>;
        })}
        {turn.interactions.some(item => ["resolved", "invalidated"].includes(item.status)) && <details className="chat-activities"><summary>Interaction history</summary><div className="chat-activity-list">{turn.interactions.filter(item => ["resolved", "invalidated"].includes(item.status)).map(item => <InteractionCard interaction={item} view={view} key={item.interactionId} />)}</div></details>}
        {turn.orderIncomplete && <p className="chat-order-note">Some activity is still live or has incomplete source order.</p>}
      </section>)}
    </div>
    {!atBottom && <Button className="chat-jump" variant="outline" onClick={() => { follow.current = true; if (list.current) list.current.scrollTop = list.current.scrollHeight; setAtBottom(true); }}>Jump to latest</Button>}
    {view.model.requests.length > 0 && <details className="chat-requests"><summary>Request delivery ({view.model.requests.length})</summary><ul>
      {view.model.requests.map(request => <li key={request.key}><div className="chat-content-heading"><strong>{request.label}</strong><Badge variant="outline">{request.status}</Badge></div><code>{request.requestId}</code>{request.error && <p role="alert">{request.error}</p>}{request.canRetry && <Button variant="outline" onClick={() => view.onRetry(request.key)}>Retry original request</Button>}</li>)}
    </ul></details>}
    <form className="chat-composer" onSubmit={event => {
      event.preventDefault(); if (!enabled || !view.draft.text.trim()) return;
      if (view.composer.action === "steer" && view.composer.turnId) view.onSteer({ turnId: view.composer.turnId, message: view.draft.text });
      else if (view.composer.action === "retry" && view.composer.retryRequestKey) view.onRetryMessage({ requestKey: view.composer.retryRequestKey, message: view.draft.text });
      else view.onSend({ message: view.draft.text, mode: view.draft.mode });
    }}>
      <label htmlFor={`${id}-message`}>Message</label>
      <Textarea id={`${id}-message`} rows={3} maxLength={100000} value={view.draft.text} disabled={view.composer.busy} placeholder={view.composer.action === "retry" ? "Enter the exact original message to retry…" : view.composer.action === "steer" ? "Add an instruction to this turn…" : "Give Codex a task…"} onChange={event => view.onDraftChange({ ...view.draft, text: event.target.value })} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      <div className="chat-composer-actions"><NativeSelect aria-label="Turn mode" value={view.composer.modeLocked ? view.composer.mode : view.draft.mode} disabled={view.composer.busy || view.composer.modeLocked} onChange={event => view.onDraftChange({ ...view.draft, mode: event.target.value as "default" | "plan" })}><NativeSelectOption value="default">Default</NativeSelectOption><NativeSelectOption value="plan">Plan</NativeSelectOption></NativeSelect>
        <Button type="submit" disabled={!enabled || !view.draft.text.trim()}>{view.composer.busy ? "Sending…" : view.composer.action === "retry" ? "Retry original message" : view.composer.action === "steer" ? "Add instruction" : "Send message"}</Button>
        {view.onCancelRetry && <Button type="button" variant="outline" onClick={view.onCancelRetry}>Cancel retry</Button>}
        {view.onInterrupt && <Button variant="outline" type="button" disabled={view.composer.busy} onClick={view.onInterrupt}>Interrupt turn</Button>}
      </div>
      <p className="chat-muted">{view.composer.reason ?? (view.composer.action === "steer" ? "Instructions keep the active turn's mode." : "Ctrl/⌘ + Enter to send. Draft stays in this session until refresh or sign-out.")}</p>
    </form>
  </div>;
}
