use crate::{
    config::{Config, hidden},
    store::Store,
};
use dewbow_protocol::{error, id, now, text};
use dewbow_sdk::Runtime;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, broadcast};

pub(crate) async fn verify_cli(config: &Config) -> anyhow::Result<Value> {
    async fn invoke(config: &Config, args: &[&str]) -> anyhow::Result<std::process::Output> {
        let mut command = std::process::Command::new(&config.codex_executable);
        hidden(&mut command);
        command.args(args).env("CODEX_HOME", &config.codex_home);
        Ok(tokio::time::timeout(
            Duration::from_secs(15),
            tokio::process::Command::from(command)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Codex prerequisite check timed out"))??)
    }
    let version = invoke(config, &["--version"]).await?;
    anyhow::ensure!(
        version.status.success()
            && String::from_utf8_lossy(&version.stdout).trim() == "codex-cli 0.162.1",
        "A standalone Codex CLI 0.162.1 is required"
    );
    let login = invoke(config, &["login", "status"]).await?;
    anyhow::ensure!(
        login.status.success(),
        "Codex login is required for this native home"
    );
    Ok(json!({"codexVersion":"0.162.1","login":"configured"}))
}
pub async fn doctor(config: &Config) -> anyhow::Result<Value> {
    let mut result = verify_cli(config).await?;
    let (runtime, _events) = Runtime::spawn(&config.codex_executable, &config.codex_home).await?;
    let checked = async {
        runtime.initialize().await?;
        let models = runtime
            .request("model/list", json!({"includeHidden":true}))
            .await?;
        anyhow::ensure!(
            models["data"].is_array(),
            "Native model catalog is unavailable"
        );
        let inventory = runtime
            .request(
                "thread/list",
                json!({"limit":1,"archived":false,"useStateDbOnly":true}),
            )
            .await?;
        anyhow::ensure!(
            inventory["data"].is_array(),
            "Native inventory protocol is unavailable"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    runtime.stop().await?;
    checked?;
    result["appServer"] = json!("compatible");
    Ok(result)
}
pub struct Service {
    pub(crate) state: PathBuf,
    pub(crate) maintenance: crate::maintenance::Maintenance,
    pub config: Config,
    pub runtime: Arc<Runtime>,
    pub store: Store,
    pub instance: String,
    pub changed: broadcast::Sender<()>,
    pub shutting_down: tokio::sync::Notify,
    pub stopped: std::sync::atomic::AtomicBool,
    pub tickets: Mutex<HashMap<String, Instant>>,
    pub cookies: Mutex<HashMap<String, Instant>>,
    inventory: AsyncMutex<Option<(Instant, Value)>>,
    requests: AsyncMutex<()>,
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    pub(crate) live: Mutex<BTreeMap<String, Value>>,
}
pub fn public(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        for key in [
            "nativeModel",
            "nativeReasoningEffort",
            "runtimeId",
            "nativeRequestId",
            "nativeMethod",
            "fingerprint",
        ] {
            map.remove(key);
        }
    }
    value
}
impl Service {
    pub async fn open(config: Config, state: &Path) -> anyhow::Result<Arc<Self>> {
        let maintenance = crate::maintenance::Maintenance::open(state)?;
        let store = Store::open(state)?;
        if let Some(owner) = store.get("meta", "owner")?
            && let Some(pid) = owner["pid"].as_u64()
        {
            anyhow::ensure!(
                !dewbow_sdk::private::process_alive(pid as u32)?,
                "RECOVERY_REQUIRED: the previously owned native process is still alive; verify ownership before stopping it"
            );
        }
        for mut session in store.list("session")? {
            session["hostId"] = json!(config.host_id);
            session["connectionState"] = json!("disconnected");
            session["runtimeState"] = json!("unknown");
            session["lastKnownState"] = json!("unknown");
            session["lastKnownAt"] = json!(now());
            session["observedAt"] = json!(now());
            session["latestCursor"] = json!(0);
            session["managed"] = json!(true);
            session["name"] = json!("Conversation");
            session["native"] = Value::Null;
            store.put("session", session["sessionId"].as_str().unwrap(), &session)?;
        }
        for mut turn in store.list("turn")? {
            turn["state"] = json!("unknown");
            turn["observedAt"] = json!(now());
            turn["error"] = Value::Null;
            store.put("turn", turn["turnId"].as_str().unwrap(), &turn)?;
        }
        let (runtime, mut events) =
            Runtime::spawn(&config.codex_executable, &config.codex_home).await?;
        store.put("meta", "owner", &json!({"pid":runtime.pid}))?;
        if let Err(cause) = runtime.initialize().await {
            runtime.stop().await?;
            store.put("meta", "owner", &Value::Null)?;
            return Err(cause.into());
        }
        let (changed, _) = broadcast::channel(32);
        let service = Arc::new(Self {
            state: state.to_path_buf(),
            maintenance,
            config,
            runtime,
            store,
            instance: id(),
            changed,
            shutting_down: tokio::sync::Notify::new(),
            stopped: std::sync::atomic::AtomicBool::new(false),
            tickets: Mutex::new(HashMap::new()),
            cookies: Mutex::new(HashMap::new()),
            inventory: AsyncMutex::new(None),
            requests: AsyncMutex::new(()),
            locks: Mutex::new(HashMap::new()),
            live: Mutex::new(BTreeMap::new()),
        });
        let weak = Arc::downgrade(&service);
        tokio::spawn(async move {
            while let Some(message) = events.recv().await {
                let Some(service) = weak.upgrade() else {
                    break;
                };
                if service.native_event(message).await.is_err() {
                    service.shutting_down.notify_one();
                    break;
                }
            }
        });
        service.recover().await?;
        service.prune_operations().await?;
        let weak = Arc::downgrade(&service);
        let mut changes = service.changed.subscribe();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            interval.tick().await;
            loop {
                let cleanup = tokio::select! {
                    _ = interval.tick() => true,
                    change = changes.recv() => {
                        if matches!(change, Err(broadcast::error::RecvError::Closed)) {
                            break;
                        }
                        false
                    }
                };
                let Some(service) = weak.upgrade() else {
                    break;
                };
                if service.stopped.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                if cleanup && service.prune_operations().await.is_err() {
                    service.shutting_down.notify_one();
                    break;
                }
            }
        });
        Ok(service)
    }
    async fn prune_operations(&self) -> anyhow::Result<()> {
        let _requests = self.requests.lock().await;
        if self.stopped.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        let Some(_admission) = self.maintenance.admit_cleanup() else {
            return Ok(());
        };
        if self.store.prune_operations(chrono::Utc::now())? > 0 {
            let _ = self.changed.send(());
        }
        Ok(())
    }
    pub fn host(&self) -> Value {
        json!({"hostId":self.config.host_id,"name":self.config.name,"status":"connected","lastSeenAt":now()})
    }
    pub async fn inventory(&self) -> Value {
        let mut cache = self.inventory.lock().await;
        if cache
            .as_ref()
            .is_none_or(|(time, _)| time.elapsed() > Duration::from_secs(10))
        {
            *cache = Some((
                Instant::now(),
                dewbow_sdk::discovery::discover(
                    &self.runtime,
                    &self.config.codex_home,
                    &self.config.codex_executable,
                )
                .await,
            ));
        }
        cache.as_ref().unwrap().1.clone()
    }
    pub fn session(&self, session: &str) -> anyhow::Result<Value> {
        self.store
            .get("session", session)?
            .ok_or_else(|| error("NOT_FOUND", "Conversation is unavailable.").into())
    }
    pub async fn summary(&self, session: &str) -> anyhow::Result<Value> {
        if let Some(mut value) = self.store.get("session", session)? {
            if let Some(native) = self.inventory().await["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["id"] == value["codexThreadId"])
            {
                value["native"] = native.clone();
                value["name"] = native["name"].clone();
            }
            return Ok(public(value));
        }
        self.inventory().await["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == session)
            .map(|native| self.unmanaged(native))
            .ok_or_else(|| error("NOT_FOUND", "Conversation is unavailable.").into())
    }
    fn unmanaged(&self, native: &Value) -> Value {
        json!({"sessionId":native["id"],"hostId":self.config.host_id,"workDir":native["workDir"],"codexThreadId":native["id"],"sessionConfig":null,"connectionState":"disconnected","createdAt":native["createdAt"],"runtimeState":"unknown","lastKnownState":"unknown","lastKnownAt":now(),"observedAt":now(),"activeTurnId":null,"latestCursor":0,"managed":false,"name":native["name"],"native":native})
    }
    pub async fn details(&self, session: &str) -> anyhow::Result<Value> {
        let summary = self.summary(session).await?;
        let select = |kind: &str| -> anyhow::Result<Vec<Value>> {
            Ok(self
                .store
                .list(kind)?
                .into_iter()
                .filter(|row| row["sessionId"] == session)
                .map(|mut row| {
                    if kind == "operation" {
                        row["authority"] = json!("operator");
                    }
                    if kind == "turn" && row["observedAt"].is_null() {
                        row["observedAt"] = row["createdAt"].clone();
                    }
                    public(row)
                })
                .collect())
        };
        Ok(
            json!({"host":self.host(),"session":summary,"contextAuthority":"operator","turns":select("turn")?,"interactions":select("interaction")?,"interactionsError":null,"operations":select("operation")?}),
        )
    }
    pub(crate) fn emit(
        &self,
        session: &mut Value,
        kind: &str,
        payload: Value,
    ) -> anyhow::Result<()> {
        session["observedAt"] = json!(now());
        session["lastKnownState"] = session["runtimeState"].clone();
        session["lastKnownAt"] = session["observedAt"].clone();
        let event = json!({"eventId":id(),"sessionId":session["sessionId"],"turnId":session["activeTurnId"],"timestamp":now(),"type":kind,"payload":payload});
        let cursor = self
            .store
            .event(session["sessionId"].as_str().unwrap(), &event)?;
        session["latestCursor"] = json!(cursor);
        self.store
            .put("session", session["sessionId"].as_str().unwrap(), session)?;
        let _ = self.changed.send(());
        Ok(())
    }
    pub(crate) fn trim_live(&self) {
        let mut live = self.live.lock().unwrap();
        while live.len() > 256
            || live
                .values()
                .map(|row| row.to_string().len())
                .sum::<usize>()
                > 16 * 1024 * 1024
        {
            live.pop_first();
        }
    }
    pub async fn api(&self, name: &str, input: Value) -> anyhow::Result<Value> {
        validate(name, &input)?;
        match name {
            "listHosts" => Ok(json!({"hosts":[self.host()]})),
            "listSessions" => {
                if input
                    .get("hostId")
                    .is_some_and(|v| v.as_str() != Some(self.config.host_id.as_str()))
                {
                    anyhow::bail!(error("INVALID_INPUT", "Host is unavailable."));
                }
                let inventory = self.inventory().await;
                let managed = self.store.list("session")?;
                let mut sessions = Vec::new();
                for native in inventory["sessions"].as_array().unwrap() {
                    if let Some(row) = managed
                        .iter()
                        .find(|row| row["codexThreadId"] == native["id"])
                    {
                        let mut row = public(row.clone());
                        row["native"] = native.clone();
                        row["name"] = native["name"].clone();
                        sessions.push(row);
                    } else {
                        sessions.push(self.unmanaged(native));
                    }
                }
                for row in managed {
                    if !sessions.iter().any(|v| v["sessionId"] == row["sessionId"]) {
                        sessions.push(public(row));
                    }
                }
                let unavailable = inventory["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|s| s["state"] != "success");
                Ok(
                    json!({"sessions":sessions,"discovery":[{"hostId":self.config.host_id,"error":if unavailable {json!(error("UNAVAILABLE","Native discovery is unavailable."))}else{Value::Null},"sources":inventory["sources"]}]}),
                )
            }
            "getSession" => self.details(text(&input, "sessionId")?).await,
            "getOperation" => self
                .store
                .list("operation")?
                .into_iter()
                .find(|operation| operation["commandId"] == input["commandId"])
                .map(|mut operation| {
                    operation["authority"] = json!("operator");
                    public(operation)
                })
                .ok_or_else(|| {
                    error(
                        "NOT_FOUND",
                        "Operation receipt is unavailable or has been pruned.",
                    )
                    .into()
                }),
            "readSessionHistory" => self.history(text(&input, "sessionId")?, &input).await,
            "readSessionContent" => self.read_content(&input).await,
            "getSessionActivity" => {
                let session = text(&input, "sessionId")?;
                let item = text(&input, "itemId")?;
                let record = self.native_item(session, item).await?;
                self.project(session, &record)?
                    .1
                    .ok_or_else(|| error("NOT_FOUND", "Activity is unavailable.").into())
            }
            _ => self.operation(name, input).await,
        }
    }
    pub(crate) fn state_lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        self.locks
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
    async fn operation(&self, name: &str, input: Value) -> anyhow::Result<Value> {
        let request = text(&input, "requestId")?.to_string();
        let key = input["sessionId"].as_str().unwrap_or(&request).to_string();
        let lock = self.state_lock(&key);
        let _guard = lock.lock().await;
        // Request IDs belong to the daemon, including across different session gates.
        let request_guard = self.requests.lock().await;
        let fingerprint =
            dewbow_protocol::hex(&Sha256::digest(json!([name, input]).to_string().as_bytes()));
        if let Some(operation) = self.store.get("operation", &request)? {
            anyhow::ensure!(
                operation["fingerprint"] == fingerprint,
                error(
                    "REQUEST_CONFLICT",
                    "Request ID already has different input."
                )
            );
            let mut operation = operation;
            operation["authority"] = json!("operator");
            return Ok(public(operation));
        }
        let _admission = self.maintenance.admit(name)?;
        anyhow::ensure!(
            !self.stopped.load(std::sync::atomic::Ordering::Relaxed),
            error("UNAVAILABLE", "Daemon is shutting down.")
        );
        let session = input["sessionId"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(id);
        let mut operation = json!({"requestId":request,"commandId":id(),"operation":name,"authority":"operator","sessionId":session,"turnId":input.get("turnId").unwrap_or(&Value::Null),"status":"accepted","createdAt":now(),"error":null,"fingerprint":fingerprint});
        self.store.put("operation", &request, &operation)?;
        drop(request_guard);
        match self.execute(name, &input, &mut operation).await {
            Ok(()) => operation["status"] = json!("delivered"),
            Err(cause) => {
                let detail = cause
                    .downcast_ref::<dewbow_protocol::ManagementError>()
                    .cloned()
                    .unwrap_or_else(|| {
                        error(
                            "EXECUTION_FAILED",
                            "Operation failed; inspect local configuration.",
                        )
                    });
                operation["status"] = json!(if detail.code == "DELIVERY_UNCERTAIN" {
                    "unknown"
                } else {
                    "error"
                });
                operation["error"] = json!(detail);
                if matches!(name, "createSession" | "connectSession")
                    && let Some(mut session) = self.store.get("session", &session)?
                {
                    session["connectionState"] = json!("error");
                    self.store
                        .put("session", session["sessionId"].as_str().unwrap(), &session)?;
                }
            }
        }
        self.store.put("operation", &request, &operation)?;
        let _ = self.changed.send(());
        Ok(public(operation))
    }
    async fn resolve_config(&self, cwd: &str, options: &Value) -> anyhow::Result<Value> {
        let config = self
            .runtime
            .request("config/read", json!({"cwd":cwd,"includeLayers":false}))
            .await?["config"]
            .clone();
        let mut models = Vec::new();
        let mut cursor = Value::Null;
        for _ in 0..20 {
            let page = self
                .runtime
                .request("model/list", json!({"includeHidden":true,"cursor":cursor}))
                .await?;
            models.extend(page["data"].as_array().cloned().unwrap_or_default());
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        let model = options
            .get("model")
            .or_else(|| config.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                models
                    .iter()
                    .find(|m| m["isDefault"] == true)
                    .and_then(|m| m["model"].as_str())
                    .map(str::to_string)
            })
            .ok_or_else(|| error("INVALID_INPUT", "Native default model is unavailable."))?;
        let entry = models
            .iter()
            .find(|m| m["model"] == model)
            .ok_or_else(|| error("INVALID_INPUT", "Selected model is unavailable."))?;
        let effort = options
            .get("reasoningEffort")
            .or_else(|| config.get("model_reasoning_effort"))
            .or_else(|| entry.get("defaultReasoningEffort"))
            .cloned()
            .unwrap_or(Value::Null);
        if !effort.is_null() {
            anyhow::ensure!(
                entry["supportedReasoningEfforts"]
                    .as_array()
                    .is_some_and(|efforts| efforts.iter().any(|e| e["reasoningEffort"] == effort)),
                error("INVALID_INPUT", "Unsupported reasoning effort.")
            );
        }
        let instructions = [
            config["developer_instructions"].as_str().unwrap_or(""),
            options["instructionsAppend"].as_str().unwrap_or(""),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        let workspace = &config["sandbox_workspace_write"];
        Ok(
            json!({"model":model,"modelProvider":config["model_provider"].as_str().unwrap_or("openai"),"reasoningEffort":effort,"developerInstructions":instructions,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":workspace.get("writable_roots").unwrap_or(&json!([])),"networkAccess":workspace["network_access"].as_bool().unwrap_or(false),"excludeTmpdirEnvVar":workspace["exclude_tmpdir_env_var"].as_bool().unwrap_or(false),"excludeSlashTmp":workspace["exclude_slash_tmp"].as_bool().unwrap_or(false)}}),
        )
    }
    fn thread_options(&self, session: &Value) -> Value {
        let mut options = json!({"cwd":session["workDir"],"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"});
        if let Some(config) = session
            .pointer("/sessionConfig/resolved")
            .filter(|v| !v.is_null())
        {
            options["model"] = config["model"].clone();
            options["modelProvider"] = config["modelProvider"].clone();
            options["developerInstructions"] = config["developerInstructions"].clone();
            options["config"] = json!({"model_reasoning_effort":config["reasoningEffort"],"sandbox_workspace_write":{"writable_roots":config["sandbox"]["writableRoots"],"network_access":config["sandbox"]["networkAccess"],"exclude_tmpdir_env_var":config["sandbox"]["excludeTmpdirEnvVar"],"exclude_slash_tmp":config["sandbox"]["excludeSlashTmp"]}});
        }
        options
    }
    async fn execute(
        &self,
        name: &str,
        input: &Value,
        operation: &mut Value,
    ) -> anyhow::Result<()> {
        let sid = operation["sessionId"].as_str().unwrap().to_string();
        if name == "createSession" || name == "connectSession" {
            let mut session = if name == "createSession" {
                anyhow::ensure!(
                    input["hostId"] == self.config.host_id,
                    error("INVALID_INPUT", "Host is unavailable.")
                );
                let path = PathBuf::from(text(input, "workDir")?);
                anyhow::ensure!(
                    path.is_absolute() && path.is_dir(),
                    error("INVALID_WORKDIR", "Select an existing absolute directory.")
                );
                let work = std::fs::canonicalize(path)?;
                let options = input.get("sessionOptions").cloned().unwrap_or(json!({}));
                let resolved = self
                    .resolve_config(work.to_str().unwrap(), &options)
                    .await?;
                json!({"sessionId":sid,"hostId":self.config.host_id,"workDir":work,"codexThreadId":null,"sessionConfig":{"resolved":resolved},"connectionState":"connecting","createdAt":now(),"runtimeState":"unknown","lastKnownState":"unknown","lastKnownAt":now(),"observedAt":now(),"activeTurnId":null,"latestCursor":0,"managed":true,"name":"New conversation","native":null})
            } else {
                self.summary(&sid).await?
            };
            anyhow::ensure!(
                session["activeTurnId"].is_null(),
                error("SESSION_BUSY", "Conversation has an unresolved turn.")
            );
            if name == "connectSession"
                && session["connectionState"] == "connected"
                && session["runtimeState"] != "unknown"
            {
                return Ok(());
            }
            session["managed"] = json!(true);
            session["connectionState"] = json!("connecting");
            self.store.put("session", &sid, &session)?;
            let mut options = self.thread_options(&session);
            let method = if name == "createSession" {
                options["ephemeral"] = json!(false);
                "thread/start"
            } else {
                options["threadId"] = session["codexThreadId"].clone();
                options["excludeTurns"] = json!(true);
                "thread/resume"
            };
            let result = self.runtime.request(method, options).await?;
            if name == "connectSession" {
                anyhow::ensure!(
                    result["thread"]["id"] == session["codexThreadId"],
                    error("RECOVERY_REQUIRED", "Native conversation identity changed.")
                );
            }
            session["codexThreadId"] = result["thread"]["id"].clone();
            self.store.put("session", &sid, &session)?;
            confirm(&session, &result)?;
            anyhow::ensure!(
                result["thread"]["status"]["type"] == "idle",
                error("SESSION_BUSY", "Native conversation is not idle.")
            );
            session["workDir"] = result["cwd"].clone();
            session["nativeModel"] = result["model"].clone();
            session["nativeReasoningEffort"] = result["reasoningEffort"].clone();
            session["runtimeState"] = json!("idle");
            session["connectionState"] = json!("connected");
            session["connectionConfirmedAt"] = json!(now());
            self.emit(&mut session, "session_connected", json!({}))?;
            *self.inventory.lock().await = None;
            return Ok(());
        }
        let mut session = self.session(&sid)?;
        if name == "sendMessage" {
            anyhow::ensure!(
                session["activeTurnId"].is_null(),
                error(
                    "SESSION_BUSY",
                    "Conversation already has an active or unresolved turn."
                )
            );
            anyhow::ensure!(
                session["connectionState"] == "connected" && session["runtimeState"] != "unknown",
                error(
                    "RECOVERY_REQUIRED",
                    "Connect or recover the conversation first."
                )
            );
            let mode = input["mode"].as_str().unwrap_or("default");
            anyhow::ensure!(
                matches!(mode, "default" | "plan"),
                error("INVALID_INPUT", "Invalid turn mode.")
            );
            let turn_id = id();
            let mut turn = json!({"turnId":turn_id,"sessionId":sid,"requestId":operation["requestId"],"codexTurnId":null,"state":"accepted","createdAt":now(),"observedAt":now(),"error":null,"mode":mode});
            operation["turnId"] = json!(turn_id);
            self.store.put(
                "operation",
                operation["requestId"].as_str().unwrap(),
                operation,
            )?;
            self.store.put("turn", &turn_id, &turn)?;
            session["activeTurnId"] = json!(turn_id);
            session["runtimeState"] = json!("running");
            self.emit(&mut session, "turn_accepted", json!({}))?;
            let result=self.runtime.request("turn/start",json!({"threadId":session["codexThreadId"],"input":[{"type":"text","text":text(input,"message")?,"text_elements":[]}],"clientUserMessageId":operation["commandId"],"collaborationMode":{"mode":mode,"settings":{"model":session["nativeModel"],"reasoning_effort":session["nativeReasoningEffort"],"developer_instructions":null}}})).await;
            turn = self.store.get("turn", &turn_id)?.unwrap();
            session = self.session(&sid)?;
            match result {
                Ok(result) => {
                    turn["codexTurnId"] = result["turn"]["id"].clone();
                    if turn["state"] == "accepted" {
                        turn["state"] = json!("running");
                    }
                    self.store.put("turn", &turn_id, &turn)?;
                    self.emit(&mut session, "turn_started", json!({}))?;
                }
                Err(cause) => {
                    turn["state"] = json!(if cause.code == "DELIVERY_UNCERTAIN" {
                        "unknown"
                    } else {
                        "error"
                    });
                    turn["error"] = json!(cause);
                    session["runtimeState"] = turn["state"].clone();
                    if cause.code != "DELIVERY_UNCERTAIN" {
                        session["activeTurnId"] = Value::Null;
                    }
                    self.store.put("turn", &turn_id, &turn)?;
                    self.emit(&mut session, "turn_failed", json!({}))?;
                    return Err(cause.into());
                }
            }
            return Ok(());
        }
        let turn_id = text(input, "turnId")?;
        anyhow::ensure!(
            session["activeTurnId"] == turn_id,
            error("STALE_TURN", "Turn is no longer active.")
        );
        let turn = self
            .store
            .get("turn", turn_id)?
            .ok_or_else(|| error("STALE_TURN", "Turn is unavailable."))?;
        let native = text(&turn, "codexTurnId")?;
        match name {
            "interruptTurn" => {
                self.runtime
                    .request(
                        "turn/interrupt",
                        json!({"threadId":session["codexThreadId"],"turnId":native}),
                    )
                    .await?;
            }
            "steerTurn" => {
                let result=self.runtime.request("turn/steer",json!({"threadId":session["codexThreadId"],"expectedTurnId":native,"input":[{"type":"text","text":text(input,"message")?,"text_elements":[]}],"clientUserMessageId":operation["commandId"]})).await?;
                anyhow::ensure!(
                    result["turnId"] == native,
                    error("DELIVERY_UNCERTAIN", "Native steering target changed.")
                );
            }
            "answerQuestions" | "decideApproval" => {
                let interaction_id = text(input, "interactionId")?;
                let mut interaction = self
                    .store
                    .get("interaction", interaction_id)?
                    .ok_or_else(|| error("STALE_INTERACTION", "Interaction is unavailable."))?;
                anyhow::ensure!(
                    interaction["sessionId"] == sid
                        && interaction["turnId"] == turn_id
                        && interaction["status"] == "pending"
                        && interaction["runtimeId"] == self.instance,
                    error(
                        "STALE_INTERACTION",
                        "Exact interaction is no longer pending."
                    )
                );
                let mut details = interaction["details"].clone();
                let response = if name == "answerQuestions" {
                    anyhow::ensure!(
                        interaction["kind"] == "questions",
                        error("INVALID_INPUT", "Interaction does not accept answers.")
                    );
                    let answers = input["answers"]
                        .as_array()
                        .ok_or_else(|| error("INVALID_INPUT", "Answers must be an array."))?;
                    let questions = details["questions"].as_array().unwrap();
                    anyhow::ensure!(
                        answers.len() == questions.len(),
                        error("INVALID_INPUT", "Answer each question once.")
                    );
                    let mut result = serde_json::Map::new();
                    for answer in answers {
                        let key = text(answer, "questionId")?;
                        let question = questions
                            .iter()
                            .find(|q| q["questionId"] == key)
                            .ok_or_else(|| error("INVALID_INPUT", "Unknown question."))?;
                        let values = answer["answers"]
                            .as_array()
                            .ok_or_else(|| error("INVALID_INPUT", "Invalid answer list."))?;
                        anyhow::ensure!(
                            !result.contains_key(key)
                                && !values.is_empty()
                                && values
                                    .iter()
                                    .all(|v| v.as_str().is_some_and(|v| !v.is_empty()
                                        && v.len() <= 100000
                                        && (question["allowCustom"] == true
                                            || question["options"].as_array().is_some_and(
                                                |options| options.iter().any(|o| o["label"] == v)
                                            )))),
                            error("INVALID_INPUT", "Answers do not match this question.")
                        );
                        result.insert(key.into(), json!({"answers":values}));
                    }
                    details["answers"] = input["answers"].clone();
                    interaction["details"] = details.clone();
                    json!({"answers":result})
                } else {
                    anyhow::ensure!(
                        interaction["kind"] == "approval",
                        error(
                            "INVALID_INPUT",
                            "Interaction does not accept approval decisions."
                        )
                    );
                    let decision = text(input, "decision")?;
                    anyhow::ensure!(
                        matches!(decision, "allow" | "deny"),
                        error("INVALID_INPUT", "Invalid decision.")
                    );
                    interaction["decision"] = json!(decision);
                    if interaction["nativeMethod"] == "item/permissions/requestApproval" {
                        json!({"permissions":if decision=="allow"{details["action"]["permissions"].clone()}else{json!({})},"scope":"turn"})
                    } else {
                        let native_decision = if decision == "allow" {
                            "accept"
                        } else if details["action"]["availableDecisions"]
                            .as_array()
                            .is_some_and(|available| available.contains(&json!("cancel")))
                        {
                            "cancel"
                        } else {
                            "decline"
                        };
                        if let Some(available) = details["action"]["availableDecisions"].as_array()
                        {
                            anyhow::ensure!(
                                available.contains(&json!(native_decision)),
                                error(
                                    "INVALID_INPUT",
                                    "Native callback does not permit this decision."
                                )
                            );
                        }
                        json!({"decision":native_decision})
                    }
                };
                interaction["status"] = json!("requested");
                interaction["requestId"] = operation["requestId"].clone();
                self.store
                    .put("interaction", interaction_id, &interaction)?;
                self.runtime
                    .respond(interaction["nativeRequestId"].clone(), response)
                    .await?;
                interaction = self.store.get("interaction", interaction_id)?.unwrap();
                if interaction["status"] == "requested" {
                    interaction["status"] = json!("delivered");
                    self.store
                        .put("interaction", interaction_id, &interaction)?;
                }
                let _ = self.changed.send(());
            }
            _ => anyhow::bail!(error("INVALID_INPUT", "Unknown operation.")),
        }
        Ok(())
    }
    pub(crate) fn confirm_delivery(&self, turn: &Value) -> anyhow::Result<()> {
        let request = text(turn, "requestId")?;
        if let Some(mut operation) = self.store.get("operation", request)?
            && operation["operation"] == "sendMessage"
            && operation["sessionId"] == turn["sessionId"]
            && operation["turnId"] == turn["turnId"]
            && ["accepted", "unknown"]
                .iter()
                .any(|state| operation["status"] == *state)
        {
            operation["status"] = json!("delivered");
            operation["error"] = Value::Null;
            self.store.put("operation", request, &operation)?;
        }
        Ok(())
    }
    async fn recover(&self) -> anyhow::Result<()> {
        for mut operation in self.store.list("operation")? {
            if operation["status"] == "accepted" {
                operation["status"] = json!("unknown");
                self.store.put(
                    "operation",
                    operation["requestId"].as_str().unwrap(),
                    &operation,
                )?;
            }
        }
        for retained in self.store.list("session")? {
            let sid = text(&retained, "sessionId")?;
            let lock = self.state_lock(sid);
            let _guard = lock.lock().await;
            let mut session = self.session(sid)?;
            session["connectionState"] = json!("error");
            session["runtimeState"] = json!("unknown");
            if let Some(thread) = session["codexThreadId"].as_str() {
                let mut options = self.thread_options(&session);
                options["threadId"] = json!(thread);
                options["excludeTurns"] = json!(false);
                if let Ok(result) = self.runtime.request("thread/resume", options).await
                    && result["thread"]["id"] == thread
                    && result["thread"]["status"]["type"] == "idle"
                    && confirm(&session, &result).is_ok()
                {
                    let active = session["activeTurnId"].as_str().map(str::to_string);
                    let mut reconciled = active.is_none();
                    if let Some(active) = active
                        && let Some(mut turn) = self.store.get("turn", &active)?
                    {
                        let saved = turn["codexTurnId"].as_str().and_then(|id| {
                            result["thread"]["turns"]
                                .as_array()
                                .and_then(|turns| turns.iter().find(|t| t["id"] == id))
                        });
                        if saved.is_some() {
                            self.confirm_delivery(&turn)?;
                        }
                        if let Some(saved) = saved.filter(|t| {
                            ["completed", "interrupted", "failed"]
                                .iter()
                                .any(|s| t["status"] == *s)
                        }) {
                            turn["state"] = json!(if saved["status"] == "failed" {
                                "error"
                            } else {
                                saved["status"].as_str().unwrap()
                            });
                            turn["observedAt"] = json!(now());
                            reconciled = true;
                        } else {
                            turn["state"] = json!("unknown");
                        }
                        self.store.put("turn", &active, &turn)?;
                    }
                    if reconciled {
                        session["activeTurnId"] = Value::Null;
                        session["runtimeState"] = json!("idle");
                        session["connectionState"] = json!("connected");
                        session["nativeModel"] = result["model"].clone();
                        session["nativeReasoningEffort"] = result["reasoningEffort"].clone();
                    }
                }
            }
            self.store
                .put("session", session["sessionId"].as_str().unwrap(), &session)?;
        }
        Ok(())
    }
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.stopped
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = self.changed.send(());
        self.runtime.stop().await?;
        self.store.put("meta", "owner", &Value::Null)?;
        Ok(())
    }
}
fn confirm(session: &Value, result: &Value) -> anyhow::Result<()> {
    let expected = std::fs::canonicalize(text(session, "workDir")?)?;
    let actual = std::fs::canonicalize(text(result, "cwd")?)?;
    anyhow::ensure!(
        expected == actual,
        error(
            "RECOVERY_REQUIRED",
            "Codex changed the selected working directory."
        )
    );
    if let Some(saved) = session
        .pointer("/sessionConfig/resolved")
        .filter(|v| !v.is_null())
    {
        for key in [
            "model",
            "modelProvider",
            "reasoningEffort",
            "approvalPolicy",
            "approvalsReviewer",
            "sandbox",
        ] {
            anyhow::ensure!(
                saved[key] == result[key],
                error(
                    "RECOVERY_REQUIRED",
                    "Codex did not retain the saved execution configuration."
                )
            );
        }
    }
    Ok(())
}
fn validate(name: &str, input: &Value) -> anyhow::Result<()> {
    let (allowed, required): (&[&str], &[&str]) = match name {
        "listHosts" => (&[], &[]),
        "listSessions" => (&["hostId"], &[]),
        "getSession" => (&["sessionId"], &["sessionId"]),
        "getOperation" => (&["commandId"], &["commandId"]),
        "readSessionHistory" => (
            &[
                "sessionId",
                "cursor",
                "beforeCursor",
                "afterCursor",
                "updateCursor",
                "limit",
            ],
            &["sessionId"],
        ),
        "getSessionActivity" => (&["sessionId", "itemId"], &["sessionId", "itemId"]),
        "readSessionContent" => (
            &["sessionId", "contentId", "contentCursor", "limitBytes"],
            &["sessionId", "contentId"],
        ),
        "createSession" => (
            &["hostId", "workDir", "requestId", "sessionOptions"],
            &["hostId", "workDir", "requestId"],
        ),
        "connectSession" => (&["sessionId", "requestId"], &["sessionId", "requestId"]),
        "sendMessage" => (
            &["sessionId", "requestId", "message", "mode"],
            &["sessionId", "requestId", "message"],
        ),
        "steerTurn" => (
            &["sessionId", "turnId", "requestId", "message"],
            &["sessionId", "turnId", "requestId", "message"],
        ),
        "interruptTurn" => (
            &["sessionId", "turnId", "requestId"],
            &["sessionId", "turnId", "requestId"],
        ),
        "decideApproval" => (
            &[
                "sessionId",
                "turnId",
                "interactionId",
                "requestId",
                "decision",
            ],
            &[
                "sessionId",
                "turnId",
                "interactionId",
                "requestId",
                "decision",
            ],
        ),
        "answerQuestions" => (
            &[
                "sessionId",
                "turnId",
                "interactionId",
                "requestId",
                "answers",
            ],
            &[
                "sessionId",
                "turnId",
                "interactionId",
                "requestId",
                "answers",
            ],
        ),
        _ => anyhow::bail!(error("INVALID_INPUT", "Unknown Web operation.")),
    };
    let object = input
        .as_object()
        .ok_or_else(|| error("INVALID_INPUT", "Input must be an object."))?;
    anyhow::ensure!(
        object.keys().all(|key| allowed.contains(&key.as_str())),
        error("INVALID_INPUT", "Unknown input field.")
    );
    for key in required {
        if *key != "answers" {
            text(input, key)?;
        }
    }
    for key in [
        "hostId",
        "beforeCursor",
        "afterCursor",
        "updateCursor",
        "contentCursor",
        "mode",
    ] {
        if input.get(key).is_some() {
            text(input, key)?;
        }
    }
    if let Some(value) = input.get("cursor") {
        anyhow::ensure!(
            value.as_u64().is_some(),
            error(
                "INVALID_INPUT",
                "Event cursor must be a nonnegative integer."
            )
        );
    }
    for key in ["limit", "limitBytes"] {
        if let Some(value) = input.get(key) {
            anyhow::ensure!(
                value.as_u64().is_some_and(|n| n > 0),
                error("INVALID_INPUT", "Page limits must be positive integers.")
            );
        }
    }
    if let Some(options) = input.get("sessionOptions") {
        let options = options
            .as_object()
            .ok_or_else(|| error("INVALID_INPUT", "Invalid session options."))?;
        for (key, value) in options {
            anyhow::ensure!(
                ["model", "reasoningEffort", "instructionsAppend"].contains(&key.as_str())
                    && value
                        .as_str()
                        .is_some_and(|s| if key == "instructionsAppend" {
                            s.len() <= 100000
                        } else {
                            !s.is_empty() && s.len() <= 200
                        }),
                error("INVALID_INPUT", "Invalid session option.")
            );
        }
    }
    if name == "answerQuestions" {
        anyhow::ensure!(
            input["answers"].is_array(),
            error("INVALID_INPUT", "Invalid answers.")
        );
    }
    Ok(())
}
