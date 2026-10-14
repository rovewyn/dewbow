use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, process::Stdio};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{Duration, timeout},
};

pub async fn inspect(exe: &Path, args: &[&str], home: &Path) -> anyhow::Result<String> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .env("CODEX_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().unwrap().take(8 * 1024 * 1024 + 1);
    let mut bytes = Vec::new();
    let result = timeout(Duration::from_secs(10), async {
        stdout.read_to_end(&mut bytes).await?;
        let status = child.wait().await?;
        anyhow::ensure!(
            status.success() && bytes.len() <= 8 * 1024 * 1024,
            "Inspection failed or exceeded capacity"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    if result.is_err() {
        child.kill().await?;
        anyhow::bail!("Inspection timed out");
    }
    result??;
    Ok(String::from_utf8(bytes)?)
}
pub async fn augment(
    sessions: &mut BTreeMap<String, Value>,
    sources: &mut Vec<Value>,
    exe: &Path,
    home: &Path,
) {
    match inspect(exe,&["migrate-rollouts","--json"],home).await.and_then(|raw|serde_json::from_str::<Value>(&raw).map_err(Into::into)){
        Ok(report) if report["outcomes"].is_array()=>{for row in report["outcomes"].as_array().unwrap().iter().take(10000){if let Some(id)=row["thread_id"].as_str().filter(|s|uuid::Uuid::parse_str(s).is_ok()){sessions.entry(id.into()).or_insert_with(||crate::discovery::native(&json!({"id":id}),home));}}sources.push(json!({"source":"cli","state":"success","error":null}));},
        _=>sources.push(json!({"source":"cli","state":"unavailable","error":"Read-only Codex inspection unavailable."})),
    }
    #[cfg(unix)]
    {
        let result = unix::processes(sessions, home).await;
        sources.push(json!({"source":"processes","state":if result.is_ok(){"success"}else{"unavailable"},"error":if result.is_ok(){Value::Null}else{json!("Process/socket observations unavailable.")}}));
    }
    #[cfg(windows)] sources.push(json!({"source":"processes","state":"unavailable","error":"Process/socket discovery supports macOS and Linux."}));
    #[cfg(target_os = "macos")]
    {
        let directory = home.join("thread-writer-locks");
        let mut partial = false;
        if crate::private::no_links(&directory).is_ok() && directory.is_dir() {
            for session in sessions.values_mut() {
                let path = directory.join(format!("{}.lock", session["id"].as_str().unwrap()));
                let result = (|| -> anyhow::Result<bool> {
                    use std::os::unix::fs::OpenOptionsExt;
                    use std::os::unix::io::AsRawFd;
                    if !path.exists() {
                        return Ok(false);
                    }
                    crate::private::regular(&path)?;
                    let file = std::fs::OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                        .open(path)?;
                    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
                    lock.l_type = libc::F_WRLCK;
                    lock.l_whence = libc::SEEK_SET as i16;
                    anyhow::ensure!(
                        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) } == 0,
                        "Writer observation unavailable"
                    );
                    Ok(lock.l_type != libc::F_UNLCK)
                })();
                match result {
                    Ok(held) => session["hasActiveWriter"] = json!(held),
                    Err(_) => partial = true,
                }
            }
            sources.push(json!({"source":"writers","state":if partial{"partial"}else{"success"},"error":null}));
        } else {
            sources.push(json!({"source":"writers","state":"unavailable","error":"Native writer namespace unavailable."}));
        }
    }
    #[cfg(not(target_os="macos"))] sources.push(json!({"source":"writers","state":"unavailable","error":"Writer lock observation requires macOS."}));
}
#[cfg(unix)]
mod unix {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        WebSocketStream,
        tungstenite::{Message, protocol::WebSocketConfig},
    };
    type Socket = WebSocketStream<tokio::net::UnixStream>;
    async fn request(
        socket: &mut Socket,
        id: u64,
        method: &str,
        params: Value,
    ) -> anyhow::Result<Value> {
        anyhow::ensure!(
            matches!(
                method,
                "initialize" | "thread/list" | "thread/loaded/list" | "thread/read"
            ),
            "Discovery only"
        );
        socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await?;
        timeout(Duration::from_secs(3), async {
            while let Some(message) = socket.next().await {
                let message = message?;
                if let Message::Text(raw) = message {
                    let value: Value = serde_json::from_str(&raw)?;
                    if value.get("method").is_some() {
                        anyhow::ensure!(
                            value.get("id").is_none(),
                            "Unexpected callback during discovery"
                        );
                        continue;
                    }
                    anyhow::ensure!(
                        value["id"] == id && value.get("error").is_none(),
                        "Discovery RPC failed"
                    );
                    return Ok(value["result"].clone());
                }
            }
            anyhow::bail!("Discovery socket closed")
        })
        .await?
    }
    async fn snapshot(path: &Path, home: &Path) -> anyhow::Result<Vec<Value>> {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let meta = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(
            meta.file_type().is_socket() && meta.uid() == unsafe { libc::geteuid() },
            "Untrusted native socket"
        );
        crate::private::no_links(path)?;
        let stream = tokio::net::UnixStream::connect(path).await?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(8 * 1024 * 1024))
            .max_frame_size(Some(8 * 1024 * 1024));
        let (mut socket, _) =
            tokio_tungstenite::client_async_with_config("ws://localhost/", stream, Some(config))
                .await?;
        request(&mut socket,1,"initialize",json!({"clientInfo":{"name":"dewbow-discovery","version":"0.1.0"},"capabilities":{"experimentalApi":false}})).await?;
        socket
            .send(Message::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .await?;
        let loaded = request(&mut socket, 2, "thread/loaded/list", json!({})).await?;
        let mut result = Vec::new();
        let mut id = 2;
        if let Some(ids) = loaded["data"].as_array() {
            for thread in ids.iter().take(10000) {
                id += 1;
                let row = request(
                    &mut socket,
                    id,
                    "thread/read",
                    json!({"threadId":thread,"includeTurns":false}),
                )
                .await?;
                result.push(crate::discovery::native(&row["thread"], home));
            }
        }
        let _ = socket.close(None).await;
        Ok(result)
    }
    pub async fn processes(
        sessions: &mut BTreeMap<String, Value>,
        home: &Path,
    ) -> anyhow::Result<()> {
        let uid = unsafe { libc::geteuid() }.to_string();
        let ps = inspect(Path::new("ps"), &["-u", &uid, "-o", "pid=,comm="], home).await?;
        let mut pids = Vec::new();
        for line in ps.lines() {
            let mut parts = line.split_whitespace();
            let Some(pid) = parts.next() else {
                continue;
            };
            let Some(command) = parts.next() else {
                continue;
            };
            if Path::new(command)
                .file_name()
                .is_some_and(|name| name == "codex")
            {
                pids.push(pid);
            }
        }
        if pids.is_empty() {
            return Ok(());
        }
        let pids = pids.join(",");
        let files = inspect(
            Path::new("lsof"),
            &["-nP", "-a", "-p", &pids, "-Fpftn"],
            home,
        )
        .await?;
        let mut kind = "";
        let mut sockets = std::collections::BTreeSet::new();
        for line in files.lines() {
            if let Some(value) = line.strip_prefix('t') {
                kind = value;
            } else if let Some(path) = line.strip_prefix('n') {
                if kind == "unix" && path.starts_with('/') {
                    sockets.insert(path);
                }
            } else if line.starts_with('f') {
                kind = "";
            }
        }
        let mut failed = false;
        for path in sockets.into_iter().take(32) {
            match timeout(Duration::from_secs(20), snapshot(Path::new(path), home)).await {
                Ok(Ok(rows)) => {
                    for row in rows {
                        let key = row["id"].as_str().unwrap_or("").to_string();
                        if let Some(saved) = sessions.get_mut(&key) {
                            saved["runtimeStatus"] = row["runtimeStatus"].clone();
                        } else {
                            sessions.insert(key, row);
                        }
                    }
                }
                _ => failed = true,
            }
        }
        anyhow::ensure!(!failed, "Some native endpoints were unavailable");
        Ok(())
    }
}
