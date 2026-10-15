//! Synthetic app-server for process, callback, recovery and history acceptance.
//! This executable requires an explicitly supplied synthetic CODEX_HOME.
use dewbow_protocol::{id, now};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Write},
    path::PathBuf,
};
fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn notify(method: &str, params: Value) {
    emit(json!({"method":method,"params":params}));
}
fn save(db: &Connection, thread: &str, turn: &str, item: &Value, complete: bool) {
    let ordinal: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(updated_at_ordinal),0)+1 FROM thread_items",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.execute("INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,updated_at_ordinal,created_at_ms,completed_at_ms,item_json,item_type) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8) ON CONFLICT(thread_id,item_id) DO UPDATE SET updated_at_ordinal=excluded.updated_at_ordinal,completed_at_ms=excluded.completed_at_ms,item_json=excluded.item_json",rusqlite::params![thread,turn,item["id"].as_str().unwrap(),ordinal,chrono::Utc::now().timestamp_millis(),if complete{Some(chrono::Utc::now().timestamp_millis())}else{None},item.to_string(),item["type"].as_str().unwrap()]).unwrap();
}
fn finish(db: &Connection, thread: &str, turn: &str, status: &str, reply: &str) {
    if status == "completed" {
        let item = json!({"type":"agentMessage","id":id(),"text":reply,"phase":"final_answer"});
        save(db, thread, turn, &item, true);
        notify(
            "item/completed",
            json!({"threadId":thread,"turnId":turn,"item":item}),
        );
    }
    db.execute(
        "UPDATE thread_turns SET status=? WHERE thread_id=? AND turn_id=?",
        rusqlite::params![status, thread, turn],
    )
    .unwrap();
    notify(
        "turn/completed",
        json!({"threadId":thread,"turn":{"id":turn,"status":status}}),
    );
}
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|a| a == "--version") {
        println!("codex-cli 0.162.1");
        return;
    }
    if args.get(1).is_some_and(|a| a == "login") {
        return;
    }
    if args.get(1).is_some_and(|a| a == "migrate-rollouts") {
        println!("{{\"outcomes\":[]}}");
        return;
    }
    let home =
        PathBuf::from(std::env::var_os("CODEX_HOME").expect("Synthetic CODEX_HOME required"));
    for key in [
        "CODEX_APP_TOOLS_PIPE_PATH",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
        "DEWBOW_TEST_CANARY",
    ] {
        assert!(
            std::env::var_os(key).is_none(),
            "Parent execution context must not enter the standalone runtime"
        );
    }
    assert!(
        home.join("synthetic.fixture").exists(),
        "Refuse to write an unmarked native home"
    );
    let db = Connection::open(home.join("thread_history_1.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE IF NOT EXISTS thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,updated_at_ordinal INTEGER,created_at_ms INTEGER,completed_at_ms INTEGER,item_json TEXT,item_type TEXT,PRIMARY KEY(thread_id,item_id));CREATE TABLE IF NOT EXISTS thread_turns(thread_id TEXT,turn_id TEXT,status TEXT);CREATE TABLE IF NOT EXISTS thread_history_projection_state(thread_id TEXT);").unwrap();
    let state = Connection::open(home.join("state_1.sqlite")).unwrap();
    state.execute_batch("CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,saved_config TEXT);").unwrap();
    let mut callbacks = HashMap::<i64, (String, String)>::new();
    let mut next_callback = 1000;
    for line in io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let params = &value["params"];
        let request = value["id"].clone();
        let method = value["method"].as_str().unwrap_or("");
        if method.is_empty() {
            if let Some((thread, turn)) = value["id"].as_i64().and_then(|id| callbacks.remove(&id))
            {
                finish(
                    &db,
                    &thread,
                    &turn,
                    if value["result"]["decision"] == "cancel" {
                        "interrupted"
                    } else {
                        "completed"
                    },
                    if value["result"]["decision"] == "decline" {
                        "Denied"
                    } else {
                        "Answered"
                    },
                );
            }
            continue;
        }
        if method == "initialized" {
            continue;
        }
        if method == "initialize" && home.join("upgrade-fail-initialize-once").exists() {
            fs::remove_file(home.join("upgrade-fail-initialize-once")).unwrap();
            emit(
                json!({"id":request,"error":{"code":-32000,"message":"synthetic initialization failure"}}),
            );
            continue;
        }
        // Explicit, one-shot faults are confined to this marked synthetic native fixture.
        if method == "model/list" && home.join("upgrade-fail-models-once").exists() {
            fs::remove_file(home.join("upgrade-fail-models-once")).unwrap();
            emit(
                json!({"id":request,"error":{"code":-32000,"message":"synthetic startup probe failure"}}),
            );
            continue;
        }
        if method == "model/list" && home.join("upgrade-slow-models-once").exists() {
            fs::remove_file(home.join("upgrade-slow-models-once")).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(4));
        }
        if method == "initialize" && home.join("upgrade-hang-initialize-once").exists() {
            fs::remove_file(home.join("upgrade-hang-initialize-once")).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(8));
        }
        let result = match method {
            "initialize" => json!({"userAgent":"fixture"}),
            "config/read" => {
                json!({"config":{"model":"fixture-model","model_provider":"openai","model_reasoning_effort":"medium","developer_instructions":"","sandbox_workspace_write":{}}})
            }
            "model/list" => {
                json!({"data":[{"model":"fixture-model","isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium"}]}],"nextCursor":null})
            }
            "thread/list" => {
                let mut statement = state
                    .prepare("SELECT id,title,cwd FROM threads WHERE archived=?")
                    .unwrap();
                let rows=statement.query_map([if params["archived"]==true{1}else{0}],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"cwd":r.get::<_,String>(2)?,"createdAt":0,"updatedAt":0,"status":{"type":"notLoaded"}}))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
                json!({"data":rows,"nextCursor":null})
            }
            "thread/start" | "thread/resume" => {
                if method == "thread/start" && home.join("upgrade-slow-start-once").exists() {
                    fs::remove_file(home.join("upgrade-slow-start-once")).unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(800));
                }
                if method == "thread/resume"
                    && home
                        .join(format!("{}.writer", params["threadId"].as_str().unwrap()))
                        .exists()
                {
                    emit(
                        json!({"id":request,"error":{"code":-32000,"message":"Thread writer lock in use"}}),
                    );
                    continue;
                }
                let thread = if method == "thread/start" {
                    id()
                } else {
                    params["threadId"].as_str().unwrap().to_string()
                };
                let defaults = json!({"model":"fixture-model","modelProvider":"openai","reasoningEffort":"medium","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false}});
                let mut result = defaults;
                let cwd = if method == "thread/start" {
                    params["cwd"].as_str().unwrap().to_string()
                } else {
                    state
                        .query_row("SELECT cwd FROM threads WHERE id=?", [&thread], |r| {
                            r.get::<_, String>(0)
                        })
                        .unwrap()
                };
                let turns = db
                    .prepare("SELECT turn_id,status FROM thread_turns WHERE thread_id=?")
                    .unwrap()
                    .query_map([&thread], |r| {
                        Ok(json!({"id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?}))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                result["thread"] =
                    json!({"id":thread,"cwd":cwd,"status":{"type":"idle"},"turns":turns});
                result["cwd"] = json!(cwd);
                state.execute("INSERT OR IGNORE INTO threads VALUES(?1,'Synthetic conversation',?2,'cli',0,0,0,?3)",rusqlite::params![thread,cwd,result.to_string()]).unwrap();
                result
            }
            "turn/start" => {
                let thread = params["threadId"].as_str().unwrap();
                let turn = id();
                let text = params["input"][0]["text"].as_str().unwrap();
                db.execute(
                    "INSERT INTO thread_turns VALUES(?,?,'inProgress')",
                    [thread, &turn],
                )
                .unwrap();
                let item = json!({"type":"userMessage","id":id(),"content":[{"type":"text","text":text}],"clientId":params["clientUserMessageId"]});
                save(&db, thread, &turn, &item, true);
                if text != "UNCERTAIN_COMPLETE" {
                    emit(json!({"id":request,"result":{"turn":{"id":turn,"status":"inProgress"}}}));
                }
                notify(
                    "turn/started",
                    json!({"threadId":thread,"turn":{"id":turn}}),
                );
                notify(
                    "item/completed",
                    json!({"threadId":thread,"turnId":turn,"item":item}),
                );
                if text == "QUESTIONS" || text == "APPROVAL" {
                    next_callback += 1;
                    callbacks.insert(next_callback, (thread.into(), turn.clone()));
                    let mut params =
                        json!({"threadId":thread,"turnId":turn,"itemId":id(),"isBlocking":true});
                    if text == "QUESTIONS" {
                        params["questions"] = json!([{"id":"choice","header":"Choice","question":"Pick one","isOther":true,"isSecret":false,"options":[{"label":"One","description":"First choice"}]}]);
                    } else {
                        params["command"] = json!("synthetic command");
                        params["availableDecisions"] = json!(["accept", "cancel"]);
                    }
                    emit(
                        json!({"id":next_callback,"method":if text=="QUESTIONS"{"item/tool/requestUserInput"}else{"item/commandExecution/requestApproval"},"params":params}),
                    );
                } else if text == "OUTPUT" {
                    let command = id();
                    let started = json!({"type":"commandExecution","id":command,"command":"synthetic Unicode output","status":"inProgress","aggregatedOutput":""});
                    notify(
                        "item/started",
                        json!({"threadId":thread,"turnId":turn,"item":started}),
                    );
                    let output = "中文 🚀\n".repeat(30000);
                    for chunk in output.as_bytes().chunks(12000) {
                        notify(
                            "item/commandExecution/outputDelta",
                            json!({"threadId":thread,"turnId":turn,"itemId":command,"delta":std::str::from_utf8(chunk).unwrap()}),
                        );
                    }
                    let completed = json!({"type":"commandExecution","id":command,"command":"synthetic Unicode output","status":"completed","aggregatedOutput":format!("{}[truncated]", "中文 🚀\n".repeat(10000))});
                    save(&db, thread, &turn, &completed, true);
                    notify(
                        "item/completed",
                        json!({"threadId":thread,"turnId":turn,"item":completed}),
                    );
                    let change = json!({"type":"fileChange","id":id(),"status":"completed","changes":[{"path":"synthetic.txt","diff":"@@ -0,0 +1 @@\n+DIFF_CANARY\n"}]});
                    save(&db, thread, &turn, &change, true);
                    notify(
                        "item/completed",
                        json!({"threadId":thread,"turnId":turn,"item":change}),
                    );
                    finish(&db, thread, &turn, "completed", "Output complete");
                } else if text != "WAIT" {
                    finish(
                        &db,
                        thread,
                        &turn,
                        "completed",
                        &format!("Synthetic response: {text}"),
                    );
                }
                continue;
            }
            "turn/interrupt" => {
                finish(
                    &db,
                    params["threadId"].as_str().unwrap(),
                    params["turnId"].as_str().unwrap(),
                    "interrupted",
                    "",
                );
                json!({})
            }
            "turn/steer" => json!({"turnId":params["expectedTurnId"]}),
            _ => {
                emit(
                    json!({"id":request,"error":{"code":-32601,"message":"unsupported synthetic method"}}),
                );
                continue;
            }
        };
        emit(json!({"id":request,"result":result}));
    }
    let _ = now();
}
