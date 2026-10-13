import { useCallback, useEffect, useState } from "react";
import type { ChannelConversationDetails } from "@dewbow/team-protocol";
import { call, errorDetail } from "./api.js";
import type { Catalog, Route } from "./model.js";
import { ErrorNotice, PageHeading, Badge } from "./ui.js";
import { useMutation } from "./useMutation.js";
import { SessionPage, type TeamChatMemory } from "./SessionPage.js";

export function ChannelWorkbench({conversationId,catalog,navigate,memory}:{conversationId:string;catalog:Catalog;navigate:(route:Route)=>void;memory:TeamChatMemory}) {
  const [view,setView]=useState<ChannelConversationDetails|null>(null),[error,setError]=useState<ReturnType<typeof errorDetail>|null>(null),[message,setMessage]=useState("");
  const load=useCallback(async(signal?:AbortSignal)=>{
    try {const value=await call<ChannelConversationDetails>("readChannelConversation",{conversationId},signal);if(!signal?.aborted){setView(value);setError(null);}}
    catch(cause){if(!signal?.aborted)setError(errorDetail(cause));}
  },[conversationId]);
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{await load(controller.signal);if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),2000);};void poll();return()=>{controller.abort();clearTimeout(timer);};},[load]);
  const action=useMutation(async()=>load()),send=useMutation(async()=>{setMessage("");await load();});
  const human=view?.conversation.mode==="human",takeover=view?.takeovers.find(t=>t.takeoverId===view.conversation.takeoverId),active=human && takeover?.phase==="active";
  return <><PageHeading eyebrow="CHANNELS" title="Conversation workbench" description={view ? `User ${view.conversation.userId}` : "Loading conversation"} actions={<button className="button secondary" onClick={()=>navigate({page:"channels"})}>Back to channels</button>} />
    <ErrorNotice error={error} /><ErrorNotice error={action.error} onRetry={action.retryRequired?action.retry:undefined} /><ErrorNotice error={send.error} onRetry={send.retryRequired?send.retry:undefined} />
    {view && <>
      <div className="card form-body"><div className="card-actions"><Badge tone={human?"warning":"good"}>{human ? "Human takeover" : "Automatic"}</Badge>{human ? <button className="button secondary" disabled={!active || action.busy || action.retryRequired || send.busy || send.retryRequired} onClick={()=>void action.send("endChannelTakeover",{conversationId})}>End takeover</button> : <button className="button primary" disabled={!view.conversation.bindingId || action.busy || action.retryRequired} onClick={()=>void action.send("beginChannelTakeover",{conversationId})}>Take over</button>}</div>
        {human && <><p role="status">{takeover?.phase === "pausing" ? "Pausing execution…" : takeover?.phase === "interrupting" ? "Waiting for the active turn to stop…" : takeover?.phase === "syncing" ? "Synchronizing human history and waiting for pending sends…" : takeover?.phase === "resuming" ? "Resuming execution submissions…" : "Messages are synchronized as context. The agent does not run."}</p>{takeover?.error && <p className="danger-text" role="alert">{takeover.error}</p>}{view.corePause==="externallyResumed" && <p className="notice warning">The Core pause was released externally. Team remains in human takeover and does not submit queued input.</p>}{view.corePause==="unknown" && <p className="muted">Core pause state is unknown. Confirmed takeover still permits human sending.</p>}</>}
      </div>
      {human && <form className="card form-body" onSubmit={event=>{event.preventDefault();if(active && message.trim())void send.send("sendChannelMessage",{conversationId,message});}}><label>Send to user<textarea rows={4} maxLength={100000} value={message} disabled={!active || send.busy || send.retryRequired} onChange={event=>setMessage(event.target.value)} /></label><button className="button primary" disabled={!active || !message.trim() || send.busy || send.retryRequired}>Send to user</button><p className="field-hint">Sent as the original chatbot. Delivery and context synchronization are tracked separately.</p></form>}
      {view.conversation.bindingId && <SessionPage key={view.conversation.bindingId} bindingId={view.conversation.bindingId} catalog={catalog} navigate={navigate} memory={memory} readOnly={human} embedded onBindingChanged={()=>{}} />}
      {view.records.some(record=>record.syncStatus!=="confirmed") && <div className="card form-body"><h2>Pending context synchronization</h2>{view.records.filter(record=>record.syncStatus!=="confirmed").map(record=><p key={record.contextId}>{record.source} · {record.syncStatus}{record.text && <span className="chat-message-body">{record.text}</span>}{record.error ? ` · ${record.error}` : ""}</p>)}</div>}
      {view.deliveries.some(delivery=>!["completed","suppressed"].includes(delivery.status)) && <div className="card form-body"><h2>Pending deliveries</h2>{view.deliveries.filter(delivery=>!["completed","suppressed"].includes(delivery.status)).map(delivery=><p key={delivery.deliveryId}>{delivery.direction} · {delivery.source??"agent"} · {delivery.status}{delivery.error?` · ${delivery.error}`:""}</p>)}<button className="text-button" onClick={()=>navigate({page:"channels"})}>Manage failed deliveries</button></div>}
    </>}
  </>;
}
