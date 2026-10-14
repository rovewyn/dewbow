use dewbow_protocol::{ManagementError, error};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc, oneshot},
    time::{Duration, timeout},
};

type Reply = oneshot::Sender<Result<Value, ManagementError>>;
pub struct Runtime {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, Reply>>,
    next_id: AtomicU64,
    pub pid: u32,
}
impl Runtime {
    pub async fn spawn(
        executable: &Path,
        home: &Path,
    ) -> anyhow::Result<(Arc<Self>, mpsc::Receiver<Value>)> {
        let mut command = Command::new(executable);
        // Prefer the documented native Windows implementation; requirements and fallback remain native-owned.
        #[cfg(windows)]
        command.args(["-c", "features.prefer_mxc=true"]);
        command
            .args(["app-server", "--listen", "stdio://"])
            .env("CODEX_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("DEWBOW_") {
                command.env_remove(key);
            }
        }
        // A standalone runtime must not use its parent's desktop conversation executor.
        for key in [
            "CODEX_APP_TOOLS_PIPE_PATH",
            "CODEX_THREAD_ID",
            "CODEX_SESSION_ID",
            "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY",
            "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
            "CODEX_CLI_PATH",
        ] {
            command.env_remove(key);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| anyhow::anyhow!("Missing native PID"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let runtime = Arc::new(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            pid,
        });
        let (tx, rx) = mpsc::channel(128);
        let weak = Arc::downgrade(&runtime);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let read = (&mut reader)
                    .take(8 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                    .await;
                if !matches!(read, Ok(n) if n > 0 && n <= 8 * 1024 * 1024) {
                    break;
                }
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                let Some(runtime) = weak.upgrade() else {
                    break;
                };
                if message.get("method").is_none() {
                    if let Some(id) = message["id"].as_u64()
                        && let Some(reply) = runtime.pending.lock().await.remove(&id)
                    {
                        let result = if message.get("error").is_some() {
                            let diagnostic = message["error"]["message"].as_str().unwrap_or("");
                            Err(error(
                                if diagnostic.to_lowercase().contains("lock")
                                    || diagnostic.to_lowercase().contains("in use")
                                {
                                    "SESSION_IN_USE"
                                } else {
                                    "EXECUTION_FAILED"
                                },
                                "Codex rejected the operation.",
                            ))
                        } else {
                            Ok(message["result"].clone())
                        };
                        let _ = reply.send(result);
                    }
                } else if tx.send(message).await.is_err() {
                    break;
                }
            }
            if let Some(runtime) = weak.upgrade() {
                for (_, reply) in runtime.pending.lock().await.drain() {
                    let _ = reply.send(Err(error(
                        "DELIVERY_UNCERTAIN",
                        "Codex exited before confirming the operation.",
                    )));
                }
            }
            let _ = tx.send(json!({"method":"runtime/exited"})).await;
        });
        Ok((runtime, rx))
    }
    pub async fn initialize(&self) -> Result<Value, ManagementError> {
        let result = self.request("initialize", json!({"clientInfo":{"name":"dewbow","title":"Dewbow","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        self.write(json!({"method":"initialized"})).await?;
        Ok(result)
    }
    async fn write(&self, message: Value) -> Result<(), ManagementError> {
        let mut stdin = self.stdin.lock().await;
        let stream = stdin
            .as_mut()
            .ok_or_else(|| error("DELIVERY_UNCERTAIN", "Native runtime is closed."))?;
        let mut bytes = serde_json::to_vec(&message).unwrap();
        bytes.push(b'\n');
        timeout(Duration::from_secs(15), stream.write_all(&bytes))
            .await
            .map_err(|_| error("DELIVERY_UNCERTAIN", "Native write timed out."))?
            .map_err(|_| error("DELIVERY_UNCERTAIN", "Native write failed."))
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, ManagementError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(cause) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(cause);
        }
        match timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            _ => {
                self.pending.lock().await.remove(&id);
                Err(error(
                    "DELIVERY_UNCERTAIN",
                    "Native reply is uncertain; reconcile before retrying.",
                ))
            }
        }
    }
    pub async fn respond(&self, id: Value, result: Value) -> Result<(), ManagementError> {
        self.write(json!({"id":id,"result":result})).await
    }
    pub async fn reject(&self, id: Value) -> Result<(), ManagementError> {
        self.write(json!({"id":id,"error":{"code":-32601,"message":"Unsupported interaction"}}))
            .await
    }
    pub async fn stop(&self) -> anyhow::Result<()> {
        self.stdin.lock().await.take();
        let mut child = self.child.lock().await;
        if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
            child.start_kill()?;
            timeout(Duration::from_secs(3), child.wait()).await??;
        }
        Ok(())
    }
}
