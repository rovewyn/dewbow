import { fail, TeamError, type ChannelTakeover, type ChannelConversationDetails, type SessionBindingDetails, type SessionBindingResult } from "@dewbow/team-protocol";
import { SessionService } from "../session-service.js";
import { ChannelStore, key, type Conversation, type ContextRecord, type Delivery, type Watch } from "./store.js";
import { splitText } from "./dingtalk/messages.js";

/** Team owns speaking authority; the host daemon owns the execution pause. */
export class Takeovers {
  constructor(private readonly store: ChannelStore, private readonly sessions: SessionService, private readonly canWork: (conversation:Conversation)=>boolean = ()=>true) {}
  private conversation(id: string): Conversation { return this.store.get<Conversation>("channel_conversations",id) ?? fail("NOT_FOUND","Conversation not found."); }
  async read(id: string, observation?: SessionBindingDetails): Promise<ChannelConversationDetails> {
    const conversation = this.conversation(id), takeover = this.store.takeover(conversation);
    let corePause: ChannelConversationDetails["corePause"] = "unknown";
    try {
      if (conversation.bindingId) {
        const view = observation ?? await this.details(conversation.bindingId), pause = view.core!.session.executionPause;
        corePause = pause ? "paused" : conversation.mode === "human" && takeover?.pauseId ? "externallyResumed" : "unpaused";
      }
    } catch { /* Offline state remains explicit. */ }
    const {address:_address,sequence:_sequence,...publicConversation} = conversation;
    return {conversation:publicConversation,corePause,
      takeovers:this.store.list<ChannelTakeover>("channel_takeovers").filter(t=>t.conversationId===id),
      records:this.store.list<ContextRecord>("channel_contexts").filter(r=>r.conversationId===id).map(({text,...record})=>({...record,...(text===null ? {} : {text})})),
      deliveries:this.store.list<Delivery>("channel_deliveries").filter(d=>d.conversationId===id).slice(-200).map(({text:_text,payload:_payload,...delivery})=>({...delivery,bodyRetained:_text!==null})),
    };
  }
  begin(id: string, requestId: string): {takeoverId:string} {
    const conversation = this.conversation(id);
    if (conversation.mode === "human") fail("TAKEOVER_ACTIVE","This conversation is already being taken over.");
    if (!conversation.bindingId || conversation.pendingBindingId) fail("SESSION_NOT_READY","Select an existing session before taking over.");
    if (this.store.list<Delivery>("channel_deliveries").some(d=>d.conversationId===id && d.text==="/new" && ["pending","processing","unknown"].includes(d.status))) fail("SESSION_BUSY","Resolve the pending session replacement before taking over.");
    const takeoverId = key(id,"takeover",requestId);
    const takeover: ChannelTakeover = {takeoverId,conversationId:id,bindingId:conversation.bindingId,phase:"pausing",pauseId:null,interruptTurnId:null,endSequence:null,createdAt:new Date().toISOString(),endedAt:null,error:null};
    conversation.mode = "human"; conversation.takeoverId = takeoverId;
    this.store.put("channel_conversations",id,conversation); this.store.put("channel_takeovers",takeoverId,takeover);
    this.store.context(conversation,key(takeoverId,"start"),"takeoverStart","");
    for (const delivery of this.store.list<Delivery>("channel_deliveries")) if (delivery.conversationId===id && delivery.direction==="input" && ["pending","processing","unknown"].includes(delivery.status) && !delivery.operation) this.receive(conversation,delivery);
    for (const watch of this.store.list<Watch>("channel_turns")) if (watch.conversationId === id) {watch.complete=true;this.store.put("channel_turns",watch.watchId,watch);}
    for (const delivery of this.store.list<Delivery>("channel_deliveries")) {
      if (delivery.conversationId !== id || delivery.direction !== "output" || delivery.source === "operator" || delivery.status === "completed") continue;
      delivery.suppressed = true;
      if (!["processing","unknown"].includes(delivery.status)) {delivery.status="suppressed";delivery.text=null;delivery.payload=null;}
      this.store.put("channel_deliveries",delivery.deliveryId,delivery);
    }
    this.store.team.db.prepare("DELETE FROM channel_questions WHERE json_extract(data_json,'$.conversationId')=?").run(id);
    return {takeoverId};
  }
  end(id: string): {takeoverId:string} {
    const conversation = this.conversation(id), takeover = this.store.takeover(conversation);
    if (conversation.mode !== "human" || !takeover || takeover.phase !== "active") fail("TAKEOVER_NOT_READY","Wait for confirmed takeover before ending it.");
    if (this.store.list<Delivery>("channel_deliveries").some(d=>d.conversationId===id && d.direction==="input" && d.operation && ["pending","processing","unknown"].includes(d.status))) fail("TAKEOVER_PENDING","Reconcile the original input submission before ending takeover.");
    const marker = this.store.context(conversation,key(takeover.takeoverId,"end"),"takeoverEnd","");
    takeover.endSequence = marker.sequence; takeover.phase="syncing"; takeover.error=null;
    this.store.put("channel_takeovers",takeover.takeoverId,takeover);
    return {takeoverId:takeover.takeoverId};
  }
  send(id: string, message: string, requestId: string): {contextId:string} {
    const conversation = this.conversation(id), takeover = this.store.takeover(conversation);
    if (conversation.mode !== "human" || takeover?.phase !== "active") fail("TAKEOVER_NOT_READY","Human sending requires a confirmed active takeover.");
    const contextId = key(id,"operator",requestId);
    this.store.context(conversation,contextId,"operator",message);
    for (const [index,part] of splitText(message).entries()) this.store.output(conversation,key(contextId,index),part,conversation.bindingId,null,"operator",contextId);
    return {contextId};
  }
  /** All messages received before the end boundary are transcript, including slash commands. */
  receive(conversation: Conversation, delivery: Delivery): boolean {
    const current = this.conversation(conversation.conversationId), takeover = this.store.takeover(current);
    if (current.mode !== "human") return false;
    if (!takeover || takeover.endSequence !== null) {
      if (takeover) {delivery.deferredTakeoverId=takeover.takeoverId;this.store.put("channel_deliveries",delivery.deliveryId,delivery);}
      return true; // New inputs wait for the confirmed resume.
    }
    if (delivery.operation) {
      const request=delivery.requestId ? this.store.team.findRequest("channel",delivery.operation,delivery.requestId) : null;
      if(request){delivery.status="unknown";this.store.put("channel_deliveries",delivery.deliveryId,delivery);return true;}
      // Operation selection without a journal has not submitted anything to Core.
      delivery.operation=null;delivery.requestId=null;delivery.payload=null;
    }
    delivery.contextId=key(takeover.takeoverId,delivery.deliveryId);
    this.store.context(current,delivery.contextId,"user",delivery.text!);
    delivery.status="completed";delivery.text=null;delivery.payload=null;delivery.error=null;
    this.store.put("channel_deliveries",delivery.deliveryId,delivery);
    return true;
  }
  private async details(bindingId: string): Promise<SessionBindingDetails> {
    const details = await this.sessions.execute("getSessionBinding",{bindingId},"channel") as SessionBindingDetails;
    if (!details.core || details.coreError) throw new TeamError(details.coreError ?? {code:"CORE_UNAVAILABLE",message:"Core state is unavailable.",retryable:true});
    return details;
  }
  private async operation(takeover: ChannelTakeover, name: string, input: Record<string,unknown>, suffix: string): Promise<SessionBindingResult> {
    if(!this.canWork(this.conversation(takeover.conversationId))) fail("CHANNEL_DISABLED","Channel background work is stopped.",true);
    const result = await this.sessions.execute(name,{bindingId:takeover.bindingId,...input,requestId:key(takeover.takeoverId,suffix)},"channel") as SessionBindingResult;
    if (result.error) throw new TeamError(result.error);
    return result;
  }
  async tick(): Promise<void> {
    for (const conversation of this.store.list<Conversation>("channel_conversations")) {
      if (conversation.mode !== "human" || !this.canWork(conversation)) continue;
      const takeover = this.store.takeover(conversation); if (!takeover) continue;
      try {
        let details = await this.details(takeover.bindingId);
        if(!this.canWork(conversation))continue;
        if (takeover.phase === "pausing") {
          const result = await this.operation(takeover,"pauseBindingExecution",{},"pause");
          if (result.operation) takeover.pauseId = result.operation.commandId;
          if (result.operation?.status !== "delivered") {this.save(takeover);continue;}
          takeover.phase="interrupting"; this.save(takeover); details = await this.details(takeover.bindingId);
        }
        if (takeover.phase === "interrupting") {
          const active = details.core!.session.activeTurnId;
          if (active) {
            takeover.interruptTurnId=active;this.save(takeover);
            await this.operation(takeover,"interruptBindingTurn",{turnId:active},`interrupt:${active}`);
            continue; // An interrupt ACK does not prove the turn has ended.
          }
          if (details.core!.session.runtimeState === "unknown") fail("RECOVERY_REQUIRED","The active execution state is unknown.",true);
          takeover.phase="active"; this.save(takeover);
        }
        const records = this.store.list<ContextRecord>("channel_contexts").filter(r=>r.segmentId===takeover.takeoverId && r.syncStatus!=="confirmed").sort((a,b)=>a.sequence-b.sequence);
        for (const record of records) {
          if(!this.canWork(conversation))break;
          if (record.text === null) fail("RECOVERY_REQUIRED","Pending transcript content is unavailable.");
          const result = await this.sessions.execute("appendBindingContext",{bindingId:record.bindingId,contextId:record.contextId,segmentId:record.segmentId,source:record.source,text:record.text,requestId:key(record.contextId,"sync")},"channel") as SessionBindingResult;
          if (result.error || result.operation?.status !== "delivered") {
            record.syncStatus="unknown";record.error=result.error?.message??"Context persistence has not been confirmed.";
            this.store.put("channel_contexts",record.contextId,record);break;
          }
          record.syncStatus="confirmed";record.text=null;record.error=null;this.store.put("channel_contexts",record.contextId,record);
        }
        if (takeover.endSequence !== null && this.canWork(conversation)) {
          const unsynced = this.store.list<ContextRecord>("channel_contexts").some(r=>r.segmentId===takeover.takeoverId && r.sequence<=takeover.endSequence! && r.syncStatus!=="confirmed");
          const unsent = this.store.list<Delivery>("channel_deliveries").some(d=>d.conversationId===conversation.conversationId && d.direction==="output" && ["pending","processing","unknown","error"].includes(d.status) && (!d.suppressed || ["processing","unknown"].includes(d.status)));
          const unresolved = this.store.list<Delivery>("channel_deliveries").some(d=>d.conversationId===conversation.conversationId && d.direction==="input" && d.operation && ["pending","processing","unknown"].includes(d.status));
          if (unsynced || unsent || unresolved) continue;
          takeover.phase="resuming";this.save(takeover);
          details=await this.details(takeover.bindingId);
          const pause=details.core!.session.executionPause;
          if (pause) {
            if (pause.pauseId !== takeover.pauseId) fail("STALE_PAUSE","A different Core pause is current. Resolve it in Core.");
            const result=await this.operation(takeover,"resumeBindingExecution",{pauseId:takeover.pauseId},"resume");
            if (result.operation?.status !== "delivered") continue;
            details=await this.details(takeover.bindingId); if (details.core!.session.executionPause) continue;
          }
          takeover.phase="ended";takeover.endedAt=new Date().toISOString();takeover.error=null;this.save(takeover);
          const current=this.conversation(conversation.conversationId);current.mode="automatic";this.store.put("channel_conversations",current.conversationId,current);
        }
      } catch (error) {takeover.error=error instanceof TeamError ? `${error.detail.code}: ${error.detail.message}` : "Takeover operation could not be confirmed.";this.save(takeover);}
    }
  }
  private save(takeover: ChannelTakeover): void {
    const current=this.store.get<ChannelTakeover>("channel_takeovers",takeover.takeoverId);
    if (current?.endSequence !== null && current?.endSequence !== undefined && takeover.endSequence===null) {takeover.endSequence=current.endSequence;takeover.phase=current.phase;}
    this.store.put("channel_takeovers",takeover.takeoverId,takeover);
  }
}
