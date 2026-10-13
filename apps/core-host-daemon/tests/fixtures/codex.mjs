#!/usr/bin/env node
// Synthetic app-server. Never opens a native Codex home or uses model credentials.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const path = join(process.env.CODEX_HOME, "synthetic-threads.json");
const threads = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const callbacks = new Map();
let callback = 100;
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const persist = () => writeFileSync(path, JSON.stringify(threads));
const settings = () => {
  const file = join(process.env.CODEX_HOME, "synthetic-config.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};
const models = ["synthetic-default", "synthetic-editor", "synthetic-host"].map((model, index) => ({ model, isDefault: index === 0,
  defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"].map(reasoningEffort => ({ reasoningEffort })) }));
function configured(params, previous = {}) {
  const defaults = settings(), workspace = params.config?.sandbox_workspace_write ?? defaults.sandbox_workspace_write ?? {};
  return { model: params.model ?? previous.model ?? defaults.model ?? "synthetic-default", modelProvider: params.modelProvider ?? "openai",
    reasoningEffort: params.config?.model_reasoning_effort ?? previous.reasoningEffort ?? defaults.model_reasoning_effort ?? "medium",
    developerInstructions: params.developerInstructions ?? previous.developerInstructions ?? defaults.developer_instructions ?? "",
    approvalPolicy: params.approvalPolicy ?? "on-request", approvalsReviewer: params.approvalsReviewer ?? "user", cwd: params.cwd ?? previous.cwd,
    sandbox: { type: "workspaceWrite", writableRoots: workspace.writable_roots ?? [], networkAccess: workspace.network_access ?? false,
      excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var ?? false, excludeSlashTmp: workspace.exclude_slash_tmp ?? false },
  };
}
function finish(thread, status) {
  const turn = thread.turns.at(-1); if (!turn || turn.status !== "inProgress") return;
  turn.status = status; thread.status = { type: "idle" }; persist();
  send({ method: "turn/completed", params: { threadId: thread.id, turn } });
}
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (!message.method && callbacks.has(message.id)) {
    appendFileSync(join(process.env.CODEX_HOME,"synthetic-rpc.jsonl"),JSON.stringify(message)+"\n");
    const thread = callbacks.get(message.id); callbacks.delete(message.id);
    send({ method: "serverRequest/resolved", params: { threadId: thread.id, requestId: message.id } });
    send({ method: "item/completed", params: { threadId: thread.id, turnId: thread.turns.at(-1).id, item: { type: "agentMessage", id: randomUUID(), text: message.result?.answers ? JSON.stringify(message.result.answers) : message.result?.decision === "accept" ? "Allowed" : "Denied", phase: "final_answer" } } });
    finish(thread, "completed"); return;
  }
  const reply = result => send({ id: message.id, result });
  const params = message.params ?? {};
  appendFileSync(join(process.env.CODEX_HOME, "synthetic-rpc.jsonl"), JSON.stringify(message) + "\n");
  if (message.method === "initialize") reply({});
  else if (message.method === "config/read") reply({ config: settings() });
  else if (message.method === "model/list") reply({ data: models.filter(model => model.model !== settings().unavailableModel), nextCursor: null });
  else if (message.method === "thread/start") {
    const effective = configured(params);
    const thread = { id: randomUUID(), cwd: params.cwd, turns: [], status: { type: "idle" }, effective };
    mkdirSync(join(process.env.CODEX_HOME,"sessions"),{recursive:true});
    thread.path=join(process.env.CODEX_HOME,"sessions",`rollout-${thread.id}.jsonl`);
    threads[thread.id] = thread; persist(); reply({ thread, ...effective });
  } else if (message.method === "thread/resume") {
    const thread = threads[params.threadId];
    if (!thread || thread.blocked) { send({ id: message.id, error: { code: -32000, message: thread ? "Thread already has an active writer" : "Thread not found" } }); return; }
    if (thread.turns.at(-1)?.status === "inProgress") thread.turns.at(-1).status = "interrupted";
    thread.effective = configured(params, thread.effective); thread.cwd = thread.effective.cwd;
    thread.status = { type: "idle" }; persist(); reply({ thread, ...thread.effective });
  } else if (message.method === "thread/read") {
    const thread=threads[params.threadId];
    reply({thread});
  } else if (message.method === "thread/inject_items") {
    const thread=threads[params.threadId];
    if(!existsSync(thread.path))writeFileSync(thread.path,JSON.stringify({type:"session_meta",payload:{id:thread.id}})+"\n");
    for(const item of params.items)appendFileSync(thread.path,JSON.stringify({type:"response_item",payload:item})+"\n");
    reply({});
  } else if (message.method === "turn/start") {
    const thread = threads[params.threadId];
    if(params.input[0].text.includes("stale callback"))send({id:++callback,method:"item/commandExecution/requestApproval",params:{threadId:thread.id,turnId:thread.turns.at(-1).id,itemId:randomUUID(),command:"Expired callback"}});
    const turn = { id: randomUUID(), status: "inProgress", items: [], error: null };
    thread.turns.push(turn); thread.status = { type: "active" }; persist();
    const lateStart = params.input[0].text.includes("late-start");
    if (!params.input[0].text.includes("rpc-only") && !lateStart) send({ method: "turn/started", params: { threadId: thread.id, turn } });
    reply({ turn });
    const advance = () => {
      if(params.input[0].text.includes("question")) {
        const text=params.input[0].text,id=++callback,itemId=randomUUID();callbacks.set(id,thread);
        const raw={threadId:thread.id,turnId:turn.id,item:{type:"function_call",call_id:itemId,name:text.includes("foreign") ? "mcp_question" : "request_user_input",namespace:text.includes("bad namespace") ? 42 : "functions"}};
        if(text.includes("missing origin turn"))delete raw.turnId;
        if(!text.includes("unknown origin"))send({method:"rawResponseItem/completed",params:raw});
        send({id,method:"item/tool/requestUserInput",params:{threadId:thread.id,turnId:turn.id,itemId,isBlocking:true,questions:[{id:"choice",header:"Choice",question:"Pick the synthetic outcome",isSecret:text.includes("secret"),isOther:text.includes("bad flag") ? "false" : false,options:[{label:"Continue",description:"Continue the synthetic turn"},{label:"Stop",description:"Stop the synthetic turn"}]}]}});
        if(text.includes("conflict"))send({method:"rawResponseItem/completed",params:{...raw,item:{...raw.item,name:"mcp_question"}}});
      } else if (params.input[0].text.includes("approval")) {
        const id = ++callback; callbacks.set(id, thread);
        send({ id, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, itemId: randomUUID(), command: "synthetic approval action", cwd: thread.cwd, reason:params.input[0].text.includes("oversized") ? "x".repeat(1100000) : "synthetic test" } });
        if (lateStart) send({ method: "turn/started", params: { threadId: thread.id, turn } });
      } else if (!params.input[0].text.includes("wait")) {
        if (lateStart) send({ method: "turn/started", params: { threadId: thread.id, turn } });
        send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: { type: "agentMessage", id: randomUUID(), text: "Synthetic reply", phase: "final_answer" } } });
        finish(thread, "completed");
      }
    };
    if (lateStart) setTimeout(advance, 20); else advance();
  } else if(message.method === "turn/steer") {
    const thread=threads[params.threadId],turn=thread.turns.at(-1);
    if(turn?.id!==params.expectedTurnId || turn.status!=="inProgress")send({id:message.id,error:{code:-32000,message:"Stale native turn"}});
    else reply({turnId:turn.id});
  } else if (message.method === "turn/interrupt") { reply({}); finish(threads[params.threadId], "interrupted"); }
});
