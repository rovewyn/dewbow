import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { Store } from "@dewbow/core-protocol/store";
import { createHash } from "node:crypto";
import { HostDaemon } from "../dist/index.js";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@dewbow/core-protocol";
import {SessionContent} from "../dist/content.js";

async function until(predicate) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { const result = predicate(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Synthetic daemon check timed out");
}
test("owned runtime preserves conversations, deduplicates commands, routes exact interactions and recovers stopped turns", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dewbow-daemon-")));
  const executable = join(dir, "codex.mjs"); copyFileSync(new URL("fixtures/codex.mjs", import.meta.url), executable);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const config = { hostId: "synthetic-host", token: "synthetic-host-credential", codexHome: dir, codexExecutable: executable,
    controlPlaneUrl: `http://127.0.0.1:${server.address().port}`, statePath: join(dir, "daemon.sqlite"), model: "synthetic-host" };
  const nativeConfig = join(dir, "synthetic-config.json");
  writeFileSync(nativeConfig, JSON.stringify({ model: "synthetic-default", developer_instructions: "Host baseline instructions." }));
  const rpc = () => readFileSync(join(dir, "synthetic-rpc.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  let socket, ready = 0, daemon = new HostDaemon(config);
  const frames = [];
  const nativeId = "00000000-0000-4000-8000-000000000001";
  const blockedId = "00000000-0000-4000-8000-000000000002";
  writeFileSync(join(dir, "synthetic-threads.json"), JSON.stringify({
    [nativeId]: { id: nativeId, cwd: dir, status: { type: "idle" }, turns: [{ id: "native-turn", status: "completed" }] },
    [blockedId]: { id: blockedId, cwd: dir, status: { type: "idle" }, turns: [], blocked: true },
  }));
  const nativeDb = new DatabaseSync(join(dir, "state_1.sqlite"));
  nativeDb.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT)");
  nativeDb.prepare("INSERT INTO threads VALUES(?,?,?,?)").run(nativeId, "Synthetic saved conversation", dir, '"cli"'); nativeDb.prepare("INSERT INTO threads VALUES(?,?,?,?)").run(blockedId, "Externally owned conversation", dir, '"cli"'); nativeDb.close();
  const historyDb = new DatabaseSync(join(dir, "thread_history_1.sqlite"));
  historyDb.exec(`CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY);
    CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER);`);
  historyDb.prepare("INSERT INTO thread_turns VALUES(?,?,?)").run(nativeId, "native-turn", "completed");
  historyDb.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?,?)").run(nativeId,"native-turn","native-message",1,1700000000000,
    JSON.stringify({type:"agentMessage",id:"native-message",text:"Native saved reply",phase:"final_answer"}),"agentMessage",1,1700000000000,1700000000001); historyDb.close();
  server.on("connection", connection => {
    socket = connection;
    connection.on("message", raw => {
      const frame = JSON.parse(raw); frames.push(frame);
      if (frame.type === "hello") connection.send(JSON.stringify({ type: "sync", cursors: {} }));
      if (frame.type === "report") { ready++; connection.send(JSON.stringify({ type: "ready" })); }
    });
  });
  const issue = async command => {
    const start = frames.length;
    socket.send(JSON.stringify({ type: "command", command }));
    return until(() => frames.slice(start).findLast(f => f.type === "result" && f.result.commandId === command.commandId)?.result);
  };
  const history = async (queryId, input) => {
    socket.send(JSON.stringify({ type: "query", query: { queryId, operation: "readSessionHistory", input } }));
    return until(() => frames.find(f => f.type === "query_result" && f.response.queryId === queryId)?.response);
  };
  const command = (id, operation, sessionId, input, turnId = null) => ({ commandId:id,operation,sessionId,turnId,authority:"operator",input:{...input,...(operation!=="createSession" ? {sessionId} : {}),...(turnId && operation!=="sendMessage" ? {turnId} : {}),requestId:input.requestId??id,...(operation === "sendMessage" ? {mode:input.mode??"default"} : {})} });
  const event = (sessionId, type) => frames.findLast(f => f.type === "event" && f.event.sessionId === sessionId && f.event.type === type)?.event;
  const query=async(operation,input,authority="agent")=>{const queryId=`query-${frames.length}-${Math.random()}`;socket.send(JSON.stringify({type:"query",query:{queryId,operation,input,authority}}));return until(()=>frames.find(frame=>frame.type === "query_result" && frame.response.queryId===queryId)?.response);};
  try {
    await daemon.start(); await until(() => ready === 1);
    socket.send(JSON.stringify({ type: "query", query: { queryId: "discover", operation: "discoverSessions", input: {} } }));
    const discovered = await until(() => frames.find(f => f.type === "query_result" && f.response.queryId === "discover")?.response);
    assert.equal(discovered.result.sessions[0].name, "Synthetic saved conversation");
    const discoveredHome = discovered.result.sessions.find(row => row.id === nativeId).codexHome;
    socket.send(JSON.stringify({ type: "query", query: { queryId: "history", operation: "readSessionHistory", input: { codexThreadId: nativeId } } }));
    const saved = await until(() => frames.find(f => f.type === "query_result" && f.response.queryId === "history")?.response);
    assert.equal(saved.result.messages[0].text, "Native saved reply");
    socket.send(JSON.stringify({ type: "query", query: { queryId: "old-history", operation: "history", input: { codexThreadId: nativeId } } }));
    const unsupported = await until(() => frames.find(f => f.type === "query_result" && f.response.queryId === "old-history")?.response);
    assert.equal(unsupported.error.code, "INVALID_INPUT");
    const duplicateDaemon = new HostDaemon(config);
    await assert.rejects(duplicateDaemon.start(), e => e.detail.code === "RECOVERY_REQUIRED");
    const duplicateAgain = new HostDaemon(config);
    await assert.rejects(duplicateAgain.start(), e => e.detail.code === "RECOVERY_REQUIRED");
    const sessionOptions = { model: "synthetic-editor", reasoningEffort: "high", instructionsAppend: "Review the article." };
    const agentRef = { id: "editor", revision: "1" };
    const create = command("create-1", "createSession", "session-1", { hostId: config.hostId, workDir: dir, requestId: "create-1", agentRef, sessionOptions });
    assert.equal((await issue(create)).status, "delivered");
    const thread = event("session-1", "session_created").payload.session.codexThreadId;
    const snapshot = event("session-1", "session_created").payload.session.sessionConfig;
    assert.deepEqual(snapshot.overrides, sessionOptions); assert.deepEqual(snapshot.agentRef, agentRef);
    assert.equal(snapshot.resolved.model, "synthetic-editor"); assert.equal(snapshot.resolved.reasoningEffort, "high");
    assert.equal(snapshot.resolved.developerInstructions, "Host baseline instructions.\n\nReview the article.");
    assert.equal((await issue({ ...create, input: { ...create.input, sessionOptions: { instructionsAppend: "Review the article.", reasoningEffort: "high", model: "synthetic-editor" } } })).status, "delivered");
    assert.equal((await issue({ ...create, input: { ...create.input, sessionOptions: { ...sessionOptions, instructionsAppend: "Changed instructions." } } })).error.code, "REQUEST_CONFLICT");
    assert.equal(rpc().filter(request => request.method === "thread/start").length, 1);
    assert.equal(event("session-1", "session_created").payload.session.codexThreadId, thread);
    const beforeHistory = rpc().length;
    const empty = await history("new-history", { codexThreadId: thread, codexHome: dir });
    assert.equal(empty.error, undefined);
    assert.deepEqual(empty.result.messages,[]); assert.equal(empty.result.beforeCursor,null); assert.equal(empty.result.afterCursor,null);
    if (process.platform === "win32") {
      const alias = await history("new-history-case-alias", { codexThreadId: thread, codexHome: dir.toUpperCase() });
      assert.deepEqual(alias.result.messages, []); assert.equal(alias.error, undefined);
    }
    assert.equal(rpc().length, beforeHistory);
    assert.equal((await history("missing-native-history", { codexThreadId: blockedId })).error.code, "SESSION_NOT_FOUND");
    assert.equal((await history("invalid-history-page", { codexThreadId: thread, limit: 0 })).error.code, "READ_FAILED");
    const send = command("send-1", "sendMessage", "session-1", { message: "approval", requestId: "send-1" }, "turn-1");
    assert.equal((await issue(send)).status, "delivered");
    const pending = await until(() => event("session-1", "interaction_requested"));
    const interaction = pending.payload.interaction;
    assert.equal(frames.findLast(f => f.type === "event" && f.event.sessionId === "session-1").event.payload.turn.state, "awaiting_approval");
    assert.equal(frames.filter(f => f.type === "event" && f.event.turnId === "turn-1" && f.event.type === "turn_started").length, 1);
    assert.equal((await issue(command("busy", "sendMessage", "session-1", { message: "extra", requestId: "busy" }, "extra-turn"))).error.code, "SESSION_BUSY");
    const stale = command("stale-interaction", "decideApproval", "session-1", { interactionId: "missing", decision: "allow" }, "turn-1");
    assert.equal((await issue(stale)).error.code, "STALE_INTERACTION");
    const decision = command("allow-1", "decideApproval", "session-1", { interactionId: interaction.interactionId, decision: "allow" }, "turn-1");
    const decisionResult = await issue(decision);
    assert.equal(decisionResult.status, "delivered", JSON.stringify(decisionResult));
    await until(() => event("session-1", "turn_completed"));
    assert.equal(event("session-1", "assistant_message").payload.text, "Allowed");
    assert.equal((await history("missing-started-history", { codexThreadId: thread })).error.code, "SESSION_NOT_FOUND");
    const followup = command("send-2", "sendMessage", "session-1", { message: "late-start approval deny", requestId: "send-2" }, "turn-2");
    await issue(followup);
    const second = await until(() => { const a = event("session-1", "interaction_requested")?.payload.interaction; return a?.turnId === "turn-2" ? a : null; });
    assert.equal(frames.findLast(f => f.type === "event" && f.event.sessionId === "session-1").event.payload.turn.state, "awaiting_approval");
    assert.equal(frames.filter(f => f.type === "event" && f.event.turnId === "turn-2" && f.event.type === "turn_started").length, 1);
    await issue(command("deny-2", "decideApproval", "session-1", { interactionId: second.interactionId, decision: "deny" }, "turn-2"));
    await until(() => event("session-1", "turn_completed")?.turnId === "turn-2");
    assert.equal(event("session-1", "assistant_message").payload.text, "Denied");
    assert.equal((await issue(command("wait-3", "sendMessage", "session-1", { message: "rpc-only wait", requestId: "wait-3" }, "turn-3"))).status, "delivered");
    assert.equal(event("session-1", "turn_started").payload.session.runtimeState, "running");
    assert.equal(event("session-1", "turn_started").payload.turn.state, "running");
    assert.equal((await issue(command("create-2", "createSession", "session-2", { hostId: config.hostId, workDir: dir, requestId: "create-2" }))).status, "delivered");
    const defaultSnapshot = event("session-2", "session_created").payload.session.sessionConfig;
    assert.deepEqual(defaultSnapshot.overrides, {});
    assert.equal(defaultSnapshot.resolved.model, "synthetic-host"); assert.equal(defaultSnapshot.resolved.reasoningEffort, "medium");
    assert.equal(defaultSnapshot.resolved.developerInstructions, "Host baseline instructions.");
    const defaultHistory = await history("default-empty-history", { codexThreadId: event("session-2", "session_created").payload.session.codexThreadId });
    assert.deepEqual(defaultHistory.result.messages,[]); assert.equal(defaultHistory.result.beforeCursor,null); assert.equal(defaultHistory.result.afterCursor,null);
    for (const [id, options] of [["invalid-model", { model: "unavailable" }], ["invalid-effort", { reasoningEffort: "unsupported" }], ["invalid-tools", { mcpServers: {} }]]) {
      assert.equal((await issue(command(id, "createSession", id, { hostId: config.hostId, workDir: dir, requestId: id, sessionOptions: options }))).error.code, "INVALID_INPUT");
    }
    assert.equal(rpc().filter(request => request.method === "thread/start").length, 2);
    await issue(command("other-send", "sendMessage", "session-2", { message: "late-start reply", requestId: "other-send" }, "other-turn"));
    await until(() => event("session-2", "turn_completed"));
    assert.equal(frames.filter(f => f.type === "event" && f.event.turnId === "other-turn" && f.event.type === "turn_started").length, 1);
    assert.equal((await issue(command("interrupt-3", "interruptTurn", "session-1", { requestId: "interrupt-3" }, "turn-3"))).status, "delivered");
    await until(() => event("session-1", "turn_completed")?.turnId === "turn-3");
    assert.equal(event("session-1", "turn_completed").payload.turn.state, "interrupted");
    for(const scenario of ["ordinary question","foreign question","bad namespace question","missing origin turn question","unknown origin question","conflict question","secret question","bad flag question"]) {
      const turnId=`test-${scenario}`,operation=command(turnId,"sendMessage","session-1",{message:scenario,mode:"plan"},turnId);
      assert.equal((await issue(operation)).status,"delivered");
      const requested=await until(()=>{const item=event("session-1","interaction_requested")?.payload.interaction;return item?.turnId===turnId ? item : null;});
      await new Promise(resolve=>setTimeout(resolve,20));
      const current=(await query("readInteractions",{sessionId:"session-1"},"operator")).result.interactions.find(item=>item.interactionId===requested.interactionId);
      assert.equal(current.authority,scenario === "ordinary question" ? "agent" : "operator",scenario);
      assert.equal(current.kind,scenario === "bad flag question" ? "unsupported" : "questions");
      const steer=command(`steer-${turnId}`,"steerTurn","session-1",{message:"Additional synthetic instruction"},turnId);
      assert.equal((await issue(steer)).status,"delivered");assert.equal((await issue(steer)).status,"delivered");
      assert.equal(event("session-1","user_message").payload.turn.mode,"plan");
      assert.equal(rpc().filter(item=>item.method === "turn/steer" && item.params.clientUserMessageId===steer.commandId).length,1);
      const answer=command(`answer-${turnId}`,"answerQuestions","session-1",{interactionId:current.interactionId,answers:[{questionId:"choice",answers:["Continue"]}]},turnId);
      if(scenario === "ordinary question") {
        const bad={...answer,commandId:`bad-${turnId}`,input:{...answer.input,requestId:`bad-${turnId}`,answers:[{questionId:"missing",answers:["Continue"]}]}};
        assert.equal((await issue(bad)).error.code,"INVALID_INPUT");
        assert.equal((await issue({...answer,authority:"agent"})).status,"delivered");
        assert.equal((await issue({...answer,authority:"agent"})).status,"delivered");
        await until(()=>event("session-1","turn_completed")?.turnId===turnId);
      } else {
        assert.equal((await issue({...answer,authority:"agent"})).error.code,"FORBIDDEN");
        if(current.sensitive){const agent=(await query("readInteractions",{sessionId:"session-1"})).result.interactions.find(item=>item.interactionId===current.interactionId);assert.equal(agent.details,undefined);assert.equal((await query("readSessionContent",{codexThreadId:thread,codexHome:dir,contentId:current.content.contentId})).error.code,"FORBIDDEN");}
        if(scenario === "secret question" || scenario === "foreign question") {
          const operator={...answer,commandId:`operator-${turnId}`,input:{...answer.input,requestId:`operator-${turnId}`}};
          assert.equal((await issue(operator)).status,"delivered");await until(()=>event("session-1","turn_completed")?.turnId===turnId);
          const privateItem=(await query("readInteractions",{sessionId:"session-1"})).result.interactions.find(item=>item.interactionId===current.interactionId);
          assert.equal(privateItem.sensitive,true);assert.equal(privateItem.details,undefined);
          const live=await query("readEvents",{sessionId:"session-1",cursor:0,limit:500});
          assert.ok(live.result.liveMessages.filter(item=>item.turnId===event("session-1","turn_completed").payload.turn.codexTurnId).every(item=>item.text==="" && item.availability === "restricted"));
        } else {await issue(command(`stop-${turnId}`,"interruptTurn","session-1",{},turnId));await until(()=>event("session-1","turn_completed")?.turnId===turnId);}
      }
      assert.equal((await issue(command(`stale-${turnId}`,"steerTurn","session-1",{message:"stale"},turnId))).error.code,"STALE_TURN");
    }
    const nativeSessionId = `native:${createHash("sha256").update(JSON.stringify([config.hostId, discoveredHome, nativeId])).digest("hex")}`;
    await issue(command("large-callback","sendMessage","session-1",{message:"oversized approval"},"large-turn"));
    const large=await until(()=>{const item=event("session-1","interaction_requested")?.payload.interaction;return item?.turnId === "large-turn" ? item : null;});
    assert.equal(large.kind,"unsupported");assert.ok(Buffer.byteLength(JSON.stringify(large))<2000);
    await issue(command("large-stop","interruptTurn","session-1",{},"large-turn"));await until(()=>event("session-1","turn_completed")?.turnId === "large-turn");
    await issue(command("late-callback-turn","sendMessage","session-1",{message:"stale callback wait"},"late-callback-turn"));
    assert.equal(event("session-1","turn_started").payload.turn.codexTurnId,JSON.parse(readFileSync(join(dir,"synthetic-threads.json"),"utf8"))[thread].turns.at(-1).id);
    assert.ok(!frames.some(frame=>frame.type === "event" && frame.event.type === "interaction_requested" && frame.event.turnId === "late-callback-turn"));
    await issue(command("late-callback-stop","interruptTurn","session-1",{},"late-callback-turn"));await until(()=>event("session-1","turn_completed")?.turnId === "late-callback-turn");
    const connectNative = command("connect-native", "connectSession", nativeSessionId, { sessionId: nativeSessionId, requestId: "connect-native" });
    assert.equal((await issue(connectNative)).status, "delivered");
    assert.equal(event(nativeSessionId, "session_connected").payload.session.codexThreadId, nativeId);
    assert.equal((await issue(connectNative)).status, "delivered");
    assert.equal(JSON.parse(readFileSync(join(dir, "synthetic-threads.json"), "utf8"))[nativeId].turns.length, 1);
    await issue(command("native-send", "sendMessage", nativeSessionId, { message: "wait", requestId: "native-send" }, "native-followup"));
    await issue(command("native-stop", "interruptTurn", nativeSessionId, { requestId: "native-stop" }, "native-followup"));
    await until(() => event(nativeSessionId, "turn_completed")?.payload.turn.state === "interrupted");
    const blockedSessionId = `native:${createHash("sha256").update(JSON.stringify([config.hostId, discoveredHome, blockedId])).digest("hex")}`;
    const blocked = await issue(command("connect-blocked", "connectSession", blockedSessionId, { sessionId: blockedSessionId, requestId: "connect-blocked" }));
    assert.equal(blocked.error.code, "SESSION_IN_USE");
    assert.equal(event(blockedSessionId, "operation_error").payload.session.connectionState, "error");
    assert.equal(event(blockedSessionId, "operation_error").payload.session.runtimeState, "unknown");
    assert.equal(event(blockedSessionId, "operation_error").payload.operation, "connectSession");
    socket.send(JSON.stringify({ type: "query", query: { queryId: "events-first", operation: "readEvents", input: { sessionId: "session-1", cursor: 0, limit: 1 } } }));
    const eventPage = await until(() => frames.find(f => f.type === "query_result" && f.response.queryId === "events-first")?.response.result);
    assert.equal(eventPage.events.length, 1); assert.equal(eventPage.hasMore, true);
    assert.equal(eventPage.nextCursor, 1);
    assert.ok(eventPage.events.every(e => e.payload.text === undefined));
    assert.equal((await issue(command("blocked-send", "sendMessage", blockedSessionId, { message: "must not start", requestId: "blocked-send" }, "blocked-turn"))).error.code, "RECOVERY_REQUIRED");
    await issue(command("wait-4", "sendMessage", "session-1", { message: "wait", requestId: "wait-4" }, "turn-4"));
    await daemon.stop();
    const journal = new Store(config.statePath);
    assert.deepEqual(journal.get("session", "session-1").sessionConfig, snapshot);
    assert.deepEqual(journal.get("session", "session-2").sessionConfig, defaultSnapshot);
    assert.ok(journal.history("session-1", 0, 1000).every(e => e.payload.text === undefined));
    assert.ok(journal.list("command").every(j => j.command.input.message === undefined && j.command.input.answers === undefined));
    assert.ok(journal.list("interaction").every(item=>item.details===undefined));
    const crashCommand = command("crash-gap", "sendMessage", "session-2", { message: "reply", requestId: "crash-gap" }, "crash-turn");
    const fingerprint = createHash("sha256").update(canonicalJson([crashCommand.operation, crashCommand.sessionId, crashCommand.turnId, crashCommand.input,crashCommand.authority])).digest("hex");
    journal.put("command", crashCommand.commandId, { command: crashCommand, fingerprint, result: { commandId: crashCommand.commandId, status: "unknown", error: null } });
    const observedCommand=command("observed-steer","steerTurn",nativeSessionId,{message:"Previously delivered synthetic steer"},"native-followup");
    const observedFingerprint=createHash("sha256").update(canonicalJson([observedCommand.operation,observedCommand.sessionId,observedCommand.turnId,observedCommand.input,observedCommand.authority])).digest("hex");
    journal.put("command",observedCommand.commandId,{command:observedCommand,fingerprint:observedFingerprint,result:{commandId:observedCommand.commandId,status:"unknown",error:null}});
    const savedHistory=new DatabaseSync(join(dir,"thread_history_1.sqlite")),ownedNativeTurn=event(nativeSessionId,"turn_completed").payload.turn.codexTurnId;
    savedHistory.prepare("INSERT INTO thread_turns VALUES(?,?,?)").run(nativeId,ownedNativeTurn,"interrupted");
    savedHistory.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?,?)").run(nativeId,ownedNativeTurn,"observed-user-item",2,1700000000010,JSON.stringify({type:"userMessage",id:"observed-user-item",clientId:observedCommand.commandId,content:[{type:"text",text:"Previously delivered synthetic steer"}]}),"userMessage",2,1700000000010,1700000000011);savedHistory.close();
    const content=new SessionContent(`${config.statePath}.contents.sqlite`),secondThread=event("session-2","session_created").payload.session.codexThreadId;
    const scope=createHash("sha256").update(JSON.stringify([process.platform === "win32" ? dir.toLowerCase() : dir,secondThread])).digest("hex");
    for(let index=0;index<40;index++) {
      const id=`large-history-${index}`,details={questions:[{questionId:"choice",header:"Choice",prompt:"Choose",options:null,allowCustom:true,secret:false}],answers:[{questionId:"choice",answers:["x".repeat(250000)]}]};
      journal.put("interaction",id,{interactionId:id,sessionId:"session-2",turnId:"other-turn",itemId:id,kind:"questions",authority:"agent",blocking:true,sensitive:false,status:"resolved",createdAt:new Date().toISOString(),observedAt:new Date().toISOString(),decision:null,requestId:id,codexRequestId:index,runtimeId:"previous-runtime",nativeMethod:"item/tool/requestUserInput",content:content.put(scope,id,"output","Interaction details",JSON.stringify(details),"complete")});
    }
    content.close();
    journal.close();
    writeFileSync(nativeConfig, JSON.stringify({ model: "synthetic-editor", model_reasoning_effort: "high", developer_instructions: "Changed host instructions.", sandbox_workspace_write: { network_access: true, exclude_slash_tmp: true } }));
    daemon = new HostDaemon({ ...config, model: "synthetic-editor" }); await daemon.start(); await until(() => ready === 2);
    const interactionPage=(await query("readInteractions",{sessionId:"session-2"})).result;
    assert.equal(interactionPage.interactions.length,40);
    assert.ok(Buffer.byteLength(JSON.stringify(interactionPage))<8*1024*1024);
    assert.ok(interactionPage.interactions.some(item=>item.details) && interactionPage.interactions.some(item=>!item.details));
    const lazy=interactionPage.interactions.find(item=>!item.details);
    assert.equal((await query("readSessionContent",{codexThreadId:secondThread,codexHome:dir,contentId:lazy.content.contentId})).result.byteLength,lazy.content.byteLength);
    const restored = frames.findLast(f => f.type === "report").report;
    assert.equal(restored.sessions.find(s => s.sessionId === "session-1").activeTurnId, null);
    assert.deepEqual(restored.sessions.find(s => s.sessionId === "session-1").sessionConfig, snapshot);
    assert.deepEqual(restored.sessions.find(s => s.sessionId === "session-2").sessionConfig, defaultSnapshot);
    const resume = rpc().findLast(request => request.method === "thread/resume" && request.params.threadId === thread);
    assert.equal(resume.params.developerInstructions, snapshot.resolved.developerInstructions);
    assert.equal(resume.params.developerInstructions.split("Review the article.").length, 2);
    assert.equal(resume.params.config.model_reasoning_effort, "high");
    assert.equal(resume.params.config.sandbox_workspace_write.network_access, false);
    assert.ok(!rpc().some(request => ["config/value/write", "config/batchWrite"].includes(request.method)));
    assert.equal(rpc().filter(request => request.method === "thread/start").length, 2);
    assert.equal(restored.turns.find(t => t.turnId === "turn-4").state, "interrupted");
    assert.equal(restored.turns.find(t => t.turnId === "crash-turn").state, "interrupted");
    assert.equal((await issue(crashCommand)).status, "unknown");
    const nativeSteerCount=rpc().filter(item=>item.method === "turn/steer").length;
    assert.equal((await issue(observedCommand)).status,"delivered");
    assert.equal(rpc().filter(item=>item.method === "turn/steer").length,nativeSteerCount,"Positive native client evidence reconciles without repeating execution.");
    await issue(command("followup-after-restart", "sendMessage", "session-1", { message: "reply", requestId: "after-restart" }, "turn-5"));
    await until(() => event("session-1", "turn_completed")?.turnId === "turn-5");
    assert.equal(restored.sessions.find(s => s.sessionId === nativeSessionId).connectionState, "connected");
    assert.equal(restored.sessions.find(s => s.sessionId === blockedSessionId).connectionState, "error");
    assert.ok(!frames.some(f => f.type === "event" && f.event.sessionId === blockedSessionId && f.event.type === "recovery_required"));
    await issue(command("native-after-restart", "sendMessage", nativeSessionId, { message: "reply", requestId: "native-after-restart" }, "native-after-restart"));
    await until(() => event(nativeSessionId, "turn_completed")?.turnId === "native-after-restart");
    const persisted = JSON.parse(readFileSync(join(dir, "synthetic-threads.json"), "utf8"));
    assert.equal(Object.keys(persisted).length, 4);
    assert.equal(persisted[nativeId].turns.length, 3);
    assert.equal(persisted[blockedId].turns.length, 0);
    assert.equal(persisted[thread].turns.length, 15);
    const replay = frames.filter(f => f.type === "event" && f.event.sessionId === "session-1").map(f => f.event);
    assert.equal(new Set(replay.map(e => e.eventId)).size, Math.max(...replay.map(e => e.cursor)));
    assert.ok(!JSON.stringify(frames).includes(config.token));
    await daemon.stop();
    const missing = new Store(config.statePath), invalid = missing.get("session", "session-2");
    invalid.sessionConfig.resolved = null; missing.put("session", "session-2", invalid); missing.close();
    writeFileSync(nativeConfig, JSON.stringify({ unavailableModel: "synthetic-editor" }));
    daemon = new HostDaemon(config); await daemon.start(); await until(() => ready === 3);
    const rejected = frames.findLast(frame => frame.type === "report").report;
    assert.equal(rejected.sessions.find(s => s.sessionId === "session-1").runtimeState, "unknown");
    assert.equal(rejected.sessions.find(s => s.sessionId === "session-2").runtimeState, "unknown");
    assert.deepEqual(rejected.sessions.find(s => s.sessionId === "session-1").sessionConfig, snapshot);
    assert.equal((await issue(command("no-fallback", "sendMessage", "session-1", { message: "Must not execute", requestId: "no-fallback" }, "no-fallback"))).error.code, "RECOVERY_REQUIRED");
    assert.equal(rpc().filter(request => request.method === "thread/start").length, 2);
  } finally { await daemon.stop(); socket?.terminate(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }); }
});
