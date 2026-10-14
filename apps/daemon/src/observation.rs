use crate::service::{Service, public};
use dewbow_protocol::{content_ref, error, id, now};
use serde_json::{Value, json};

impl Service {
    pub(crate) fn project(
        &self,
        sid: &str,
        record: &Value,
    ) -> anyhow::Result<(Option<Value>, Option<Value>)> {
        let item = &record["item"];
        let kind = item["type"].as_str().unwrap_or("unknown");
        let item_id = item["id"].as_str().unwrap_or("");
        let created = record["createdAtMs"]
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|d| d.to_rfc3339())
            .unwrap_or_else(now);
        let complete = !record["completedAtMs"].is_null();
        if ["userMessage", "agentMessage", "plan"].contains(&kind) {
            let text = if kind == "userMessage" {
                item["content"]
                    .as_array()
                    .map(|content| {
                        content
                            .iter()
                            .filter(|v| v["type"] == "text")
                            .filter_map(|v| v["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            } else {
                item["text"].as_str().unwrap_or("").to_string()
            };
            return Ok((
                Some(
                    json!({"id":item_id,"turnId":record["turnId"],"ordinal":record["ordinal"],"updatedOrdinal":record["updatedOrdinal"],"createdAt":created,"turnStatus":record["turnStatus"],"itemComplete":complete,"role":if kind=="userMessage"{"user"}else{"assistant"},"text":text,"phase":if kind=="plan"{json!("plan")}else{item["phase"].clone()},"clientId":item["clientId"]}),
                ),
                None,
            ));
        }
        if kind == "reasoning" {
            return Ok((None, None));
        }
        let mut activity = json!({"id":item_id,"turnId":record["turnId"],"ordinal":record["ordinal"],"updatedOrdinal":record["updatedOrdinal"],"createdAt":created,"type":kind,"title":kind,"status":item["status"],"itemComplete":complete,"contents":[]});
        let mut refs = Vec::new();
        if kind == "commandExecution" {
            activity["title"] = json!("Command");
            activity["command"] = item["command"].clone();
            let existing = self.store.content_meta(sid, item_id)?;
            let finished = ["completed", "failed", "declined"]
                .iter()
                .any(|s| item["status"] == *s);
            let (content, bytes, captured_complete) =
                if let Some((content, bytes, known, captured)) =
                    existing.filter(|(_, _, known, captured)| *known || *captured)
                {
                    if finished && captured {
                        self.store.finish_capture(&content)?;
                    }
                    (content, bytes, known || finished && captured)
                } else {
                    let body = item["aggregatedOutput"].as_str().unwrap_or("");
                    let complete = finished && body.is_empty();
                    let content = self
                        .store
                        .save_content(sid, item_id, "output", body, complete)?;
                    (content, body.len(), complete)
                };
            let mut reference = content_ref(&content, "output", bytes, captured_complete);
            if finished && !captured_complete {
                reference["completeness"] = json!("unknown");
            }
            refs.push(reference);
        } else if kind == "fileChange" {
            activity["title"] = json!("File changes");
            let mut paths = Vec::new();
            if let Some(changes) = item["changes"].as_array() {
                for (index, change) in changes.iter().enumerate() {
                    paths.push(change["path"].clone());
                    let body = change["diff"].as_str().unwrap_or("");
                    let content = self.store.save_content(
                        sid,
                        &format!("{item_id}:diff:{index}"),
                        "diff",
                        body,
                        complete,
                    )?;
                    let mut reference = content_ref(&content, "diff", body.len(), complete);
                    reference["label"] = change["path"].clone();
                    refs.push(reference);
                }
            }
            activity["paths"] = json!(paths);
        } else {
            let body = item.to_string();
            let content = self
                .store
                .save_content(sid, item_id, "output", &body, complete)?;
            refs.push(content_ref(&content, "output", body.len(), complete));
        }
        activity["contents"] = json!(refs);
        self.store
            .put("activity", &format!("{sid}:{item_id}"), &activity)?;
        Ok((None, Some(activity)))
    }
    pub(crate) async fn history(&self, sid: &str, input: &Value) -> anyhow::Result<Value> {
        let session = self.summary(sid).await?;
        let thread = session["codexThreadId"].as_str();
        let mut messages = Vec::new();
        let mut activities = Vec::new();
        let mut history_error = Value::Null;
        let mut page = json!({});
        if let Some(thread) = thread {
            match dewbow_sdk::history::read(&self.config.codex_home, thread, input) {
                Ok(value) => {
                    page = value;
                    for record in page["items"].as_array().unwrap() {
                        let (message, activity) = self.project(sid, record)?;
                        messages.extend(message);
                        activities.extend(activity);
                    }
                }
                Err(cause) => history_error = json!(cause),
            }
        }
        let events = self
            .store
            .events(sid, input["cursor"].as_u64().unwrap_or(0))?;
        let more = events.len() > 500;
        let events = events.into_iter().take(500).collect::<Vec<_>>();
        let cursor = events
            .last()
            .and_then(|e| e["cursor"].as_u64())
            .unwrap_or(input["cursor"].as_u64().unwrap_or(0));
        let ids = self
            .live
            .lock()
            .unwrap()
            .values()
            .filter(|row| row["sessionId"] == sid)
            .filter_map(|row| row.get("message").or_else(|| row.get("activity")))
            .filter_map(|item| item["id"].as_str().map(str::to_string))
            .collect::<Vec<_>>();
        if let Some(thread) = thread
            && history_error.is_null()
            && let Ok(saved) =
                dewbow_sdk::history::persisted_items(&self.config.codex_home, thread, &ids)
        {
            self.live.lock().unwrap().retain(|_, row| {
                row["sessionId"] != sid
                    || row
                        .get("message")
                        .or_else(|| row.get("activity"))
                        .and_then(|item| item["id"].as_str())
                        .is_none_or(|id| !saved.contains(id))
            });
        }
        let live = self
            .live
            .lock()
            .unwrap()
            .values()
            .filter(|v| v["sessionId"] == sid)
            .cloned()
            .collect::<Vec<_>>();
        let live_messages = live
            .iter()
            .filter_map(|row| row.get("message"))
            .cloned()
            .collect::<Vec<_>>();
        for row in live {
            if let Some(activity) = row.get("activity")
                && input.get("beforeCursor").is_none()
                && input.get("afterCursor").is_none()
                && !activities.iter().any(|a| a["id"] == activity["id"])
            {
                activities.push(activity.clone());
            }
        }
        Ok(
            json!({"events":events,"nextCursor":cursor,"hasMore":more,"messages":messages,"activities":activities,"beforeCursor":page["beforeCursor"],"afterCursor":page["afterCursor"],"updateCursor":page["updateCursor"],"hasMoreUpdates":page["hasMoreUpdates"].as_bool().unwrap_or(false),"liveMessages":live_messages,"historyError":history_error,"eventsError":null}),
        )
    }
    pub(crate) fn read_content(&self, input: &Value) -> anyhow::Result<Value> {
        let sid = dewbow_protocol::text(input, "sessionId")?;
        let content = dewbow_protocol::text(input, "contentId")?;
        let cursor = input["contentCursor"]
            .as_str()
            .map(|s| {
                s.split_once(':')
                    .filter(|(id, _)| *id == content)
                    .and_then(|(_, n)| n.parse::<usize>().ok())
            })
            .transpose_option()
            .ok_or_else(|| error("INVALID_INPUT", "Invalid content cursor."))?
            .unwrap_or(0);
        let limit = input["limitBytes"].as_u64().unwrap_or(65536) as usize;
        anyhow::ensure!(
            (4..=262144).contains(&limit),
            error("INVALID_INPUT", "Invalid content range.")
        );
        let (body, bytes, complete) = self.store.chunk(sid, content, cursor, limit)?;
        let end = cursor + body.len();
        Ok(
            json!({"contentId":content,"text":body,"byteOffset":cursor,"byteLength":bytes,"nextCursor":if end<bytes{json!(format!("{content}:{end}"))}else{Value::Null},"completeness":if complete{"complete"}else{"partial"},"availability":"available"}),
        )
    }
    pub(crate) async fn native_event(&self, message: Value) -> anyhow::Result<()> {
        let method = message["method"].as_str().unwrap_or("");
        if method == "runtime/exited" {
            for mut session in self.store.list("session")? {
                session["connectionState"] = json!("disconnected");
                session["runtimeState"] = json!("unknown");
                if let Some(turn_id) = session["activeTurnId"].as_str()
                    && let Some(mut turn) = self.store.get("turn", turn_id)?
                {
                    turn["state"] = json!("unknown");
                    self.store.put("turn", turn_id, &turn)?;
                }
                self.emit(&mut session, "runtime_exited", json!({}))?;
            }
            if !self.stopped.load(std::sync::atomic::Ordering::Relaxed) {
                self.shutting_down.notify_one();
            }
            return Ok(());
        }
        let params = &message["params"];
        let thread = params["threadId"]
            .as_str()
            .or_else(|| params.pointer("/thread/id").and_then(Value::as_str));
        let Some(thread) = thread else {
            return Ok(());
        };
        let Some(mut session) = self
            .store
            .list("session")?
            .into_iter()
            .find(|s| s["codexThreadId"] == thread)
        else {
            if message.get("id").is_some() {
                self.runtime.reject(message["id"].clone()).await?;
            }
            return Ok(());
        };
        let sid = session["sessionId"].as_str().unwrap().to_string();
        let Some(turn_id) = session["activeTurnId"].as_str().map(str::to_string) else {
            return Ok(());
        };
        let mut turn = self.store.get("turn", &turn_id)?.unwrap();
        let native_turn = params["turnId"]
            .as_str()
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        let Some(native_turn) = native_turn else {
            return Ok(());
        };
        if !turn["codexTurnId"].is_null() && turn["codexTurnId"] != native_turn {
            if message.get("id").is_some() {
                self.runtime.reject(message["id"].clone()).await?;
            }
            return Ok(());
        }
        turn["codexTurnId"] = json!(native_turn);
        if message.get("id").is_some() {
            let iid = id();
            let questions = params["questions"]
                .as_array()
                .filter(|q| !q.is_empty() && q.len() <= 20);
            let is_questions = method == "item/tool/requestUserInput" && questions.is_some();
            let is_approval = [
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
                "item/permissions/requestApproval",
            ]
            .contains(&method);
            let mut details = if is_questions {
                json!({"questions":questions.unwrap().iter().map(|q|json!({"questionId":q["id"],"header":q["header"],"prompt":q["question"],"options":q["options"],"allowCustom":q["options"].is_null() || q["isOther"]==true,"secret":q["isSecret"]==true})).collect::<Vec<_>>()})
            } else {
                json!({"action":{"kind":method,"command":params["command"],"cwd":params["cwd"],"reason":params["reason"],"permissions":params["permissions"],"availableDecisions":params["availableDecisions"]}})
            };
            let mut kind = if is_questions {
                "questions"
            } else if is_approval {
                "approval"
            } else {
                "unsupported"
            };
            if details.to_string().len() > 1_048_576 {
                kind = "unsupported";
                details = json!({"action":{"kind":"unsupported","reason":"Interaction exceeds the supported size. Interrupt the turn."}});
            }
            let raw = details.to_string();
            let content = self.store.save_content(&sid, &iid, "output", &raw, true)?;
            let blocking = params["isBlocking"].as_bool().unwrap_or(true);
            let interaction = json!({"interactionId":iid,"sessionId":sid,"turnId":turn_id,"itemId":params["itemId"],"kind":kind,"authority":"operator","blocking":blocking,"status":"pending","createdAt":now(),"observedAt":now(),"decision":null,"requestId":null,"content":content_ref(&content,"output",raw.len(),true),"sensitive":is_questions && questions.unwrap().iter().any(|q|q["isSecret"]==true),"runtimeId":self.instance,"nativeRequestId":message["id"],"nativeMethod":method});
            self.store.put("interaction", &iid, &interaction)?;
            if blocking {
                turn["state"] = json!(if kind == "approval" {
                    "awaiting_approval"
                } else {
                    "awaiting_input"
                });
                session["runtimeState"] = turn["state"].clone();
            }
            self.store.put("turn", &turn_id, &turn)?;
            self.emit(
                &mut session,
                "interaction_requested",
                json!({"interaction":public(interaction)}),
            )?;
            return Ok(());
        }
        if method == "turn/started" {
            turn["state"] = json!("running");
            session["runtimeState"] = json!("running");
        } else if method == "turn/completed" {
            let status = params["turn"]["status"].as_str().unwrap_or("");
            if !["completed", "interrupted", "failed"].contains(&status) {
                return Ok(());
            }
            turn["state"] = json!(if status == "failed" { "error" } else { status });
            session["runtimeState"] = json!(if status == "completed" {
                "idle"
            } else if status == "failed" {
                "error"
            } else {
                status
            });
            session["activeTurnId"] = Value::Null;
            for mut interaction in self.store.list("interaction")? {
                if interaction["turnId"] == turn_id {
                    interaction["status"] = json!(if interaction["status"] == "delivered" {
                        "resolved"
                    } else {
                        "invalidated"
                    });
                    self.store.put(
                        "interaction",
                        interaction["interactionId"].as_str().unwrap(),
                        &interaction,
                    )?;
                }
            }
        } else if method == "item/commandExecution/outputDelta" {
            if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str())
            {
                self.store.append_output(&sid, item, delta)?;
            }
        } else if method == "item/agentMessage/delta" {
            let item = params["itemId"].as_str().unwrap_or("");
            let key = format!("{sid}:{item}");
            let mut live = self.live.lock().unwrap();
            let row=live.entry(key).or_insert_with(||json!({"sessionId":sid,"message":{"id":item,"turnId":native_turn,"role":"assistant","text":"","phase":null,"createdAt":now(),"turnStatus":"running","itemComplete":false}}));
            let mut text = row["message"]["text"].as_str().unwrap_or("").to_string();
            let delta = params["delta"].as_str().unwrap_or("");
            if text.len() + delta.len() <= 1_048_576 {
                text.push_str(delta);
                row["message"]["text"] = json!(text);
            }
        } else if method == "item/started" || method == "item/completed" {
            let item = &params["item"];
            if item["type"] != "reasoning" {
                let finished = method == "item/completed";
                let record = json!({"item":item,"turnId":native_turn,"ordinal":null,"updatedOrdinal":null,"createdAtMs":chrono::Utc::now().timestamp_millis(),"completedAtMs":if finished{json!(chrono::Utc::now().timestamp_millis())}else{Value::Null},"turnStatus":turn["state"]});
                let (message, activity) = self.project(&sid, &record)?;
                let mut row = json!({"sessionId":sid});
                if let Some(message) = message {
                    row["message"] = message;
                }
                if let Some(activity) = activity {
                    row["activity"] = activity;
                }
                let mut live = self.live.lock().unwrap();
                live.insert(format!("{sid}:{}", item["id"].as_str().unwrap_or("")), row);
                while live.len() > 1000 {
                    live.pop_first();
                }
            }
        }
        turn["observedAt"] = json!(now());
        self.store.put("turn", &turn_id, &turn)?;
        self.emit(&mut session, method, json!({}))?;
        Ok(())
    }
}
trait TransposeOption<T> {
    fn transpose_option(self) -> Option<Option<T>>;
}
impl<T> TransposeOption<T> for Option<Option<T>> {
    fn transpose_option(self) -> Option<Option<T>> {
        match self {
            None => Some(None),
            Some(Some(v)) => Some(Some(v)),
            Some(None) => None,
        }
    }
}
