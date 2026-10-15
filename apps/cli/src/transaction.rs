use crate::{background::Background, replacement, upgrade::hash};
use anyhow::{Context, ensure};
use dewbow_daemon::{
    config::{self, Config},
    lifecycle::DaemonLock,
    maintenance::{self, Transaction},
};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};
use tokio::time::{Instant, sleep, timeout};

async fn control(
    config: &Config,
    instance: &Value,
    token: &str,
    name: &str,
) -> anyhow::Result<Value> {
    control_timeout(config, instance, token, name, Duration::from_secs(3)).await
}
async fn control_timeout(
    config: &Config,
    instance: &Value,
    token: &str,
    name: &str,
    duration: Duration,
) -> anyhow::Result<Value> {
    let result = crate::control_timeout(
        config,
        name,
        &json!({"instanceId":instance["instanceId"],"token":token}),
        duration,
    )
    .await?;
    ensure!(
        result["instanceId"] == instance["instanceId"],
        "Upgrade control instance changed"
    );
    Ok(result)
}

async fn drain(
    state: &Path,
    config: &Config,
    token: &str,
    wait: Duration,
    job: Option<&Path>,
) -> anyhow::Result<bool> {
    let instance = match crate::status(state, config).await {
        Ok(value) if value["status"] == "ready" => value,
        _ => {
            DaemonLock::acquire(state)?.recover_instance()?;
            crate::updater::record_intent(job, token, false, Some(config)).await?;
            return Ok(false);
        }
    };
    ensure!(
        instance["upgradeProtocol"] == "v1" && instance["version"] == env!("CARGO_PKG_VERSION"),
        "The running daemon does not support this upgrade protocol; stop it explicitly first"
    );
    crate::updater::record_intent(job, token, true, Some(config)).await?;
    let waiting = async {
        let mut report = control(config, &instance, token, "beginUpgrade").await?;
        let deadline = Instant::now() + wait;
        while report["activeTurns"] != 0 || report["inFlight"] != 0 {
            ensure!(Instant::now() < deadline, "Existing or unresolved tasks did not finish before the upgrade deadline; no tasks were interrupted");
            sleep(Duration::from_millis(200)).await;
            report = control(config, &instance, token, "pollUpgrade").await?;
        }
        crate::updater::phase(job, "stopping")?;
        control(config, &instance, token, "stopUpgrade").await?;
        Ok::<_, anyhow::Error>(())
    }.await;
    if let Err(cause) = waiting {
        // Best effort: a disconnected updater's draining lease also expires automatically.
        let _ = control(config, &instance, token, "cancelUpgrade").await;
        return Err(cause);
    }
    Ok(true)
}

async fn stopped(state: &Path, duration: Duration) -> anyhow::Result<DaemonLock> {
    timeout(duration, async {
        loop {
            if let Ok(lock) = DaemonLock::acquire(state)
                && lock.recover_instance().is_ok()
                && let Ok(config) = config::load(state)
                && std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).is_ok()
            {
                return Ok(lock);
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("Owned processes or listener did not exit; state and executable were not restored")?
}

pub(crate) fn copy(source: &Path, destination: &Path) -> anyhow::Result<()> {
    dewbow_sdk::private::regular(source)?;
    dewbow_sdk::private::no_links(destination)?;
    // New files only: never follow or overwrite an unexpected destination.
    let mut from = fs::File::open(source)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut to = options.open(destination)?;
    std::io::copy(&mut from, &mut to)?;
    to.sync_all()?;
    fs::set_permissions(destination, fs::metadata(source)?.permissions())?;
    Ok(())
}

fn prepare(
    state: &Path,
    executable: &Path,
    candidate: &Path,
    version: &str,
    was_running: bool,
    token: &str,
) -> anyhow::Result<Transaction> {
    if maintenance::transaction(state)?.is_some() {
        ensure!(
            maintenance::committed(state)?,
            "An interrupted upgrade requires upgrade --recover first"
        );
        fs::rename(
            state.join("upgrade"),
            state.join(format!("upgrade-history-{}", dewbow_protocol::id())),
        )?;
    }
    dewbow_daemon::checkpoint_for_upgrade(state)?;
    let directory = state.join(format!(".upgrade-stage-{}", dewbow_protocol::id()));
    config::secure_directory(&directory)?;
    let result = (|| {
        copy(&state.join("config.json"), &directory.join("config.json"))?;
        let database_hash = if state.join("daemon.sqlite").exists() {
            copy(
                &state.join("daemon.sqlite"),
                &directory.join("daemon.sqlite"),
            )?;
            Some(hash(&directory.join("daemon.sqlite"))?)
        } else {
            None
        };
        let previous = executable.with_file_name(format!(
            "{}.previous-{}-{}",
            executable.file_name().unwrap().to_string_lossy(),
            env!("CARGO_PKG_VERSION"),
            dewbow_protocol::id()
        ));
        replacement::retain(executable, candidate, &previous)?;
        let transaction = Transaction {
            contract_version: "v1".into(),
            token: token.into(),
            executable: executable.into(),
            previous,
            previous_hash: hash(executable)?,
            candidate_hash: hash(candidate)?,
            previous_version: env!("CARGO_PKG_VERSION").into(),
            version: version.into(),
            was_running,
            config_hash: hash(&directory.join("config.json"))?,
            database_hash,
        };
        config::write_json(&directory.join("transaction.json"), &transaction)?;
        maintenance::sync_directory(&directory)?;
        fs::rename(&directory, state.join("upgrade"))?;
        maintenance::sync_directory(state)?;
        Ok(transaction)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    result
}

async fn ready(
    child: &mut Background,
    state: &Path,
    config: &Config,
    version: &str,
    sealed: bool,
    duration: Duration,
) -> anyhow::Result<Value> {
    timeout(duration, async {
        loop {
            ensure!(!child.exited()?, "Launched daemon exited during startup");
            if let Ok(value) = crate::status(state, config).await
                && value["status"] == "ready"
            {
                ensure!(value["pid"].as_u64() == Some(child.pid() as u64), "Startup returned a different process");
                if sealed && value["maintenance"] != true {
                    config::write_json(&state.join("upgrade/unsafe.json"), &json!({"reason":"Startup was not sealed; accepted work cannot be excluded."}))?;
                    anyhow::bail!("Candidate was not sealed; automatic rollback is unsafe");
                }
                ensure!(value["version"] == version && value["upgradeProtocol"] == "v1", "Startup version or protocol differs from the selected release");
                return Ok(value);
            }
            sleep(Duration::from_millis(100)).await;
        }
    }).await.context("Daemon startup verification timed out")?
}

async fn stop_child(
    child: &mut Background,
    state: &Path,
    config: &Config,
    token: &str,
    duration: Duration,
) -> anyhow::Result<DaemonLock> {
    if !child.exited()? {
        if let Ok(instance) = crate::status(state, config).await
            && instance["pid"].as_u64() == Some(child.pid() as u64)
        {
            let _ = control(config, &instance, token, "abortUpgrade").await;
        }
        if timeout(duration, async {
            while !child.exited()? {
                sleep(Duration::from_millis(100)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .is_err()
        {
            child.terminate()?;
        }
    }
    timeout(duration, async {
        while !child.exited()? {
            sleep(Duration::from_millis(100)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("The launched candidate did not exit; rollback refused")??;
    // Killing an owned launch handle is not proof that its native child exited.
    stopped(state, duration).await
}

async fn launch(
    state: &Path,
    config: &Config,
    record: &Transaction,
    version: &str,
    duration: Duration,
) -> anyhow::Result<()> {
    let mut child = Background::spawn_executable(&record.executable, state)?;
    let result = async {
        let instance = ready(&mut child, state, config, version, true, duration).await?;
        ensure!(
            instance["maintenance"] == true,
            "Candidate accepted work before startup verification"
        );
        let validation = timeout(
            duration,
            control_timeout(
                config,
                &instance,
                &record.token,
                "validateUpgrade",
                duration,
            ),
        )
        .await
        .context("Native startup verification timed out")??;
        ensure!(
            validation["verified"] == true && validation["version"] == version,
            "Native startup verification failed"
        );
        if record.was_running {
            // The daemon flushes the commit marker before it admits any new work.
            control(config, &instance, &record.token, "commitUpgrade").await?;
        } else {
            control(config, &instance, &record.token, "abortUpgrade").await?;
            let _lock = stop_child(&mut child, state, config, &record.token, duration).await?;
            maintenance::commit(state)?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() && !maintenance::committed(state)? {
        stop_child(&mut child, state, config, &record.token, duration).await?;
    }
    result
}

fn restore(state: &Path, record: &Transaction) -> anyhow::Result<()> {
    ensure!(
        !maintenance::committed(state)?,
        "Committed upgrades cannot be automatically rolled back after accepting work"
    );
    ensure!(
        !state.join("upgrade/unsafe.json").exists(),
        "Startup may have accepted work; automatic rollback refused"
    );
    for path in [
        &record.previous,
        &record.executable,
        &state.join("config.json"),
        &state.join("upgrade/config.json"),
    ] {
        dewbow_sdk::private::regular(path)?;
    }
    ensure!(
        hash(&record.previous)? == record.previous_hash,
        "Previous executable backup is corrupt; rollback refused"
    );
    let current_hash = hash(&record.executable)?;
    ensure!(
        current_hash == record.candidate_hash || current_hash == record.previous_hash,
        "Installed executable changed outside this transaction; rollback refused"
    );
    ensure!(
        hash(&state.join("config.json"))? == record.config_hash
            && hash(&state.join("upgrade/config.json"))? == record.config_hash,
        "Configuration changed or its snapshot is corrupt; rollback refused"
    );
    if let Some(expected) = &record.database_hash {
        let database = state.join("upgrade/daemon.sqlite");
        dewbow_sdk::private::regular(&database)?;
        ensure!(
            &hash(&database)? == expected,
            "Management snapshot is corrupt; rollback refused"
        );
    }
    for name in ["daemon.sqlite", "daemon.sqlite-wal", "daemon.sqlite-shm"] {
        let path = state.join(name);
        dewbow_sdk::private::no_links(&path)?;
        if path.exists() {
            dewbow_sdk::private::regular(&path)?;
        }
    }
    maintenance::begin_rollback(state)?;
    let failed = state.join(format!("upgrade-failed-state-{}", dewbow_protocol::id()));
    config::secure_directory(&failed)?;
    // Retain the failed management files before touching them. Restoring can be retried.
    for name in ["daemon.sqlite", "daemon.sqlite-wal", "daemon.sqlite-shm"] {
        let path = state.join(name);
        if path.exists() {
            copy(&path, &failed.join(name))?;
        }
    }
    for name in ["daemon.sqlite-wal", "daemon.sqlite-shm", "daemon.sqlite"] {
        let path = state.join(name);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    if record.database_hash.is_some() {
        copy(
            &state.join("upgrade/daemon.sqlite"),
            &state.join("daemon.sqlite"),
        )?;
    }
    let candidate = record
        .executable
        .with_file_name(format!(".dewbow-restore-{}", dewbow_protocol::id()));
    copy(&record.previous, &candidate)?;
    let failed_binary = record.executable.with_file_name(format!(
        "{}.failed-{}",
        record.executable.file_name().unwrap().to_string_lossy(),
        dewbow_protocol::id()
    ));
    replacement::replace(&record.executable, &candidate, &failed_binary)?;
    maintenance::sync_directory(state)?;
    Ok(())
}

pub async fn recover(state: &Path, executable: &Path, duration: Duration) -> anyhow::Result<()> {
    let record = maintenance::transaction(state)?.context("No interrupted upgrade to recover")?;
    ensure!(
        !maintenance::committed(state)?,
        "This upgrade is committed; automatic rollback is no longer safe"
    );
    ensure!(
        record.executable == executable,
        "Run recovery from the installation recorded in this transaction"
    );
    let config = config::load(state)?;
    ensure!(
        hash(&state.join("config.json"))? == record.config_hash,
        "Configuration changed; inspect it before recovery"
    );
    ensure!(
        !state.join("upgrade/unsafe.json").exists(),
        "Startup may have accepted work; automatic rollback refused"
    );
    let lock = tokio::time::timeout(duration, async {
        loop {
            if let Ok(instance) = crate::status(state, &config).await
                && instance["status"] != "stopped"
            {
                ensure!(
                    instance["maintenance"] == true,
                    "Daemon is accepting work; rollback refused"
                );
                let _ = control(&config, &instance, &record.token, "abortUpgrade").await;
            }
            if let Ok(lock) = stopped(state, Duration::from_millis(100)).await {
                return Ok::<_, anyhow::Error>(lock);
            }
        }
    })
    .await
    .context("Pending startup or native ownership did not exit; recovery refused")??;
    restore(state, &record)?;
    drop(lock);
    launch(state, &config, &record, &record.previous_version, duration).await?;
    println!("Restored and verified the previous executable and management snapshot.");
    Ok(())
}

/// Resume a durable job without repeating a switch or rolling back accepted work.
pub(crate) async fn resume_interrupted(
    executable: &Path,
    state: &Path,
    job: &Path,
    intent: &crate::updater::Intent,
    duration: Duration,
) -> anyhow::Result<&'static str> {
    if let Some(record) = maintenance::transaction(state)? {
        if record.token == intent.token {
            if !maintenance::committed(state)? {
                recover(state, executable, duration).await?;
                return Ok("recovered");
            }
            let rolled_back = maintenance::rollback_started(state)?;
            if intent.was_running {
                let config = config::load(state)?;
                let expected = if rolled_back {
                    &record.previous_version
                } else {
                    &record.version
                };
                match crate::status(state, &config).await {
                    Ok(value) if value["status"] == "ready" => {
                        ensure!(
                            value["version"] == *expected && value["maintenance"] == false,
                            "Committed service identity or maintenance differs; preserve its state"
                        );
                    }
                    _ => {
                        let lock = stopped(state, duration).await?;
                        drop(lock);
                        let mut child = Background::spawn_executable(executable, state)?;
                        ready(&mut child, state, &config, expected, false, duration).await?;
                    }
                }
            }
            return Ok(if rolled_back {
                "recovered"
            } else {
                "succeeded"
            });
        }
        ensure!(
            maintenance::committed(state)?,
            "A different transaction owns this state; recovery refused"
        );
    }
    if let Some(expected) = &intent.config_hash {
        ensure!(
            hash(&state.join("config.json"))? == *expected,
            "Configuration changed during interrupted maintenance; recovery refused"
        );
        ensure!(
            hash(executable)? == intent.old_hash,
            "Installation changed without its state transaction; recovery refused"
        );
        let config = config::load(state)?;
        if let Ok(instance) = crate::status(state, &config).await
            && instance["status"] == "ready"
        {
            ensure!(
                instance["version"] == intent.old_version,
                "A different version is serving this state"
            );
            if instance["maintenance"] == true {
                control(&config, &instance, &intent.token, "cancelUpgrade").await?;
            }
            return Ok("recovered");
        }
        let lock = stopped(state, duration).await?;
        drop(lock);
        if intent.was_running {
            let mut child = Background::spawn_executable(executable, state)?;
            ready(
                &mut child,
                state,
                &config,
                &intent.old_version,
                false,
                duration,
            )
            .await?;
        }
        return Ok("recovered");
    }
    let prepared: crate::upgrade::Prepared = crate::updater::read_json(&job.join("prepared.json"))?;
    let current = hash(executable)?;
    ensure!(
        current == intent.old_hash || current == prepared.binary_hash,
        "Uninitialized installation changed outside this job"
    );
    if job.join("binaryCommitted.json").exists() {
        let marker: Value = crate::updater::read_json(&job.join("binaryCommitted.json"))?;
        ensure!(
            marker["contractVersion"] == "v1" && current == prepared.binary_hash,
            "Invalid binary commit checkpoint"
        );
        return Ok("succeeded");
    }
    ensure!(
        !state.join("config.json").exists() && !state.join("instance.json").exists(),
        "State was initialized during an uncommitted upgrade; restoration refused"
    );
    let retained = job.join(if cfg!(windows) {
        "runner.exe"
    } else {
        "runner"
    });
    ensure!(
        hash(&retained)? == intent.old_hash,
        "Retained previous executable changed"
    );
    if current != intent.old_hash {
        let candidate =
            executable.with_file_name(format!(".dewbow-restore-{}", dewbow_protocol::id()));
        copy(&retained, &candidate)?;
        replacement::replace(
            executable,
            &candidate,
            &executable.with_file_name(format!("dewbow.failed-{}", dewbow_protocol::id())),
        )?;
    }
    crate::upgrade::verify_binary(executable, &intent.old_version).await?;
    Ok("recovered")
}

pub async fn apply(
    executable: &Path,
    candidate: &Path,
    state: &Path,
    version: &str,
    wait: Duration,
    duration: Duration,
    job: Option<&Path>,
) -> anyhow::Result<()> {
    if maintenance::transaction(state)?.is_some() {
        ensure!(
            maintenance::committed(state)?,
            "An interrupted upgrade requires upgrade --recover first"
        );
    }
    if !state.join("config.json").exists() {
        ensure!(
            !state.join("instance.json").exists(),
            "State has an instance without configuration; recovery is required"
        );
        crate::updater::record_intent(job, &dewbow_protocol::id(), false, None).await?;
        let backup = executable.with_file_name(format!(
            "{}.previous-{}-{}",
            executable.file_name().unwrap().to_string_lossy(),
            env!("CARGO_PKG_VERSION"),
            dewbow_protocol::id()
        ));
        replacement::replace(executable, candidate, &backup)?;
        if let Some(job) = job {
            crate::updater::write_new(
                &job.join("binaryCommitted.json"),
                &json!({"contractVersion":"v1"}),
            )?;
        }
        println!(
            "Installed {version}; no initialized state was available for daemon startup verification."
        );
        return Ok(());
    }
    let config = config::load(state)?;
    let token = dewbow_protocol::id();
    println!("Release verified. Waiting for existing tasks before stopping the selected daemon.");
    crate::updater::phase(job, "draining")?;
    let was_running = drain(state, &config, &token, wait, job).await?;
    let lock = stopped(state, duration).await?;
    crate::updater::phase(job, "snapshotting")?;
    let record = match prepare(state, executable, candidate, version, was_running, &token) {
        Ok(record) => record,
        Err(cause) => {
            drop(lock);
            if maintenance::transaction(state)?.is_some() && !maintenance::committed(state)? {
                recover(state, executable, duration)
                    .await
                    .context("Snapshot preparation was interrupted; recovery is required")?;
            } else if was_running {
                let mut old = Background::spawn_executable(executable, state)?;
                ready(
                    &mut old,
                    state,
                    &config,
                    env!("CARGO_PKG_VERSION"),
                    false,
                    duration,
                )
                .await
                .context(
                    "Snapshot preparation failed and previous daemon restart is unconfirmed",
                )?;
            }
            return Err(cause);
        }
    };
    crate::updater::phase(job, "switching")?;
    let switched = replacement::commit(executable, candidate);
    drop(lock);
    crate::updater::phase(job, "validating")?;
    let result = match switched {
        Ok(()) => launch(state, &config, &record, version, duration).await,
        Err(cause) => Err(cause),
    };
    if let Err(cause) = result {
        // A lost commit response may follow a successful durable commit. Never undo it.
        if maintenance::committed(state)? {
            anyhow::bail!(
                "Upgrade committed, but completion response was lost; inspect daemon status before retrying: {cause}"
            );
        }
        println!("Startup verification failed; attempting guarded recovery.");
        recover(state, executable, duration).await.context("Automatic recovery could not be confirmed; preserve upgrade snapshots and use upgrade --recover after resolving ownership or startup failures")?;
        anyhow::bail!("Upgrade failed; the previous version was restored and verified: {cause}");
    }
    println!(
        "Upgraded to {version}; startup verified. Previous executable and management snapshot retained."
    );
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard};

    const VERSION: &str = env!("CARGO_PKG_VERSION");
    const DEADLINE: Duration = Duration::from_secs(15);
    static FIXTURE: Mutex<()> = Mutex::new(());
    pub(crate) struct Environment {
        pub root: PathBuf,
        pub state: PathBuf,
        pub executable: PathBuf,
        pub candidate: PathBuf,
        pub home: PathBuf,
        pub config: Config,
        _fixture: MutexGuard<'static, ()>,
    }
    impl Environment {
        pub(crate) fn new() -> Self {
            // Each fixture copies executables and starts several native processes.
            // Keep independent scenarios from starving each other's fault windows
            // on small CI machines; no shared application state is protected here.
            let fixture_guard = FIXTURE.lock().unwrap_or_else(|cause| cause.into_inner());
            let current = std::env::current_exe().unwrap();
            let debug = current.parent().unwrap().parent().unwrap();
            let name = if cfg!(windows) {
                "dewbow.exe"
            } else {
                "dewbow"
            };
            let fixture = debug.join("examples").join(if cfg!(windows) {
                "fixture.exe"
            } else {
                "fixture"
            });
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("dewbow-transaction-{}", dewbow_protocol::id()));
            config::secure_directory(&root).unwrap();
            let state = root.join("state");
            let home = root.join("native");
            config::secure_directory(&home).unwrap();
            fs::write(home.join("synthetic.fixture"), "synthetic").unwrap();
            let executable = root.join(name);
            copy(&debug.join(name), &executable).unwrap();
            let candidate = root.join(format!("candidate-{name}"));
            copy(&executable, &candidate).unwrap();
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let config =
                config::init(&state, Some(fixture), Some(home.clone()), Some(port)).unwrap();
            Self {
                root,
                state,
                executable,
                candidate,
                home,
                config,
                _fixture: fixture_guard,
            }
        }
        pub(crate) async fn start(&self) -> Value {
            let mut child = Background::spawn_executable(&self.executable, &self.state).unwrap();
            ready(
                &mut child,
                &self.state,
                &self.config,
                VERSION,
                false,
                DEADLINE,
            )
            .await
            .unwrap()
        }
        pub(crate) async fn operator(&self) -> String {
            let ticket = crate::control(&self.config, "ticket").await.unwrap();
            crate::client(Duration::from_secs(3))
                .unwrap()
                .post(format!("http://127.0.0.1:{}/auth/login", self.config.port))
                .header("Origin", format!("http://127.0.0.1:{}", self.config.port))
                .json(&ticket)
                .send()
                .await
                .unwrap()
                .headers()["set-cookie"]
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .into()
        }
        pub(crate) async fn api(&self, cookie: &str, name: &str, mut input: Value) -> Value {
            let client = crate::client(Duration::from_secs(3)).unwrap();
            let base = format!("http://127.0.0.1:{}/api/v1/sessions", self.config.port);
            let request = match name {
                "createSession" => client.post(base).json(&input),
                "getSession" => {
                    client.get(format!("{base}/{}", input["sessionId"].as_str().unwrap()))
                }
                "sendMessage" => {
                    let session = input.as_object_mut().unwrap().remove("sessionId").unwrap();
                    client
                        .post(format!("{base}/{}/turns", session.as_str().unwrap()))
                        .json(&input)
                }
                _ => panic!("Unsupported synthetic resource operation: {name}"),
            };
            let value: Value = request
                .header("Origin", format!("http://127.0.0.1:{}", self.config.port))
                .header("Cookie", cookie)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(value.get("result").is_some(), "{value}");
            value["result"].clone()
        }
    }
    impl Drop for Environment {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!(
                    "Synthetic failure state retained for inspection: {}",
                    self.root.display()
                );
                let job = self.root.join(".dewbow-updater/active");
                if fs::read(self.home.join("synthetic.fixture")).is_ok_and(|v| v == b"synthetic") {
                    if let Ok(entries) = fs::read_dir(&job) {
                        eprintln!(
                            "Synthetic job files: {:?}",
                            entries
                                .filter_map(Result::ok)
                                .map(|v| v.file_name())
                                .collect::<Vec<_>>()
                        );
                    }
                    for name in [
                        "supervisor.json",
                        "worker.json",
                        "progress.json",
                        "runner.log",
                    ] {
                        if let Ok(bytes) = fs::read(job.join(name)) {
                            eprintln!(
                                "Synthetic {name}: {}",
                                String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(8192)..])
                            );
                        }
                    }
                }
                return;
            }
            let mut command = std::process::Command::new(&self.executable);
            config::hidden(&mut command);
            let _ = command
                .arg("--state-dir")
                .arg(&self.state)
                .args(["daemon", "stop"])
                .output();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn validates_before_admission_and_preserves_running_or_stopped_state() {
        for running in [true, false] {
            let env = Environment::new();
            let previous = if running {
                Some(env.start().await)
            } else {
                None
            };
            let config_before = hash(&env.state.join("config.json")).unwrap();
            if running {
                fs::write(env.home.join("upgrade-slow-models-once"), "synthetic").unwrap();
            }
            apply(
                &env.executable,
                &env.candidate,
                &env.state,
                VERSION,
                Duration::ZERO,
                DEADLINE,
                None,
            )
            .await
            .unwrap();
            assert!(maintenance::committed(&env.state).unwrap());
            assert_eq!(hash(&env.state.join("config.json")).unwrap(), config_before);
            let status = crate::status(&env.state, &env.config).await.unwrap();
            if let Some(previous) = previous {
                assert_ne!(previous["instanceId"], status["instanceId"]);
                assert_eq!(status["maintenance"], false);
                assert_eq!(status["version"], VERSION);
            } else {
                assert_eq!(status["status"], "stopped");
            }
            assert!(
                recover(&env.state, &env.executable, DEADLINE)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn failed_native_verification_restores_old_service_without_native_reset() {
        for (fault, selected) in [
            (Some("upgrade-fail-models-once"), VERSION),
            (Some("upgrade-fail-initialize-once"), VERSION),
            (None, "99.0.0"),
        ] {
            let env = Environment::new();
            let previous = env.start().await;
            let cookie = env.operator().await;
            let input = json!({"hostId":env.config.host_id,"workDir":env.root,"requestId":"retained-create"});
            let created = env.api(&cookie, "createSession", input.clone()).await;
            assert_eq!(created["status"], "delivered");
            fs::write(env.home.join("native-canary"), "preserve native data").unwrap();
            if let Some(fault) = fault {
                fs::write(env.home.join(fault), "synthetic").unwrap();
            }
            let error = apply(
                &env.executable,
                &env.candidate,
                &env.state,
                selected,
                Duration::ZERO,
                DEADLINE,
                None,
            )
            .await
            .unwrap_err();
            assert!(
                error.to_string().contains("previous version was restored"),
                "{error:#}"
            );
            let status = crate::status(&env.state, &env.config).await.unwrap();
            assert_eq!(status["maintenance"], false);
            assert_ne!(status["instanceId"], previous["instanceId"]);
            assert!(maintenance::committed(&env.state).unwrap());
            let cookie = env.operator().await;
            let retained = env.api(&cookie, "createSession", input).await;
            assert_eq!(
                retained["commandId"], created["commandId"],
                "Rollback retains request deduplication"
            );
            assert_eq!(
                env.api(
                    &cookie,
                    "getSession",
                    json!({"sessionId":created["sessionId"]})
                )
                .await["session"]["connectionState"],
                "connected"
            );
            assert_eq!(
                fs::read_to_string(env.home.join("native-canary")).unwrap(),
                "preserve native data"
            );
            assert!(fs::read_dir(&env.state).unwrap().any(|p| {
                p.unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("upgrade-failed-state-")
            }));
        }
    }

    #[tokio::test]
    async fn busy_deadline_restores_admission_without_interrupting_the_turn() {
        let env = Environment::new();
        let previous = env.start().await;
        let cookie = env.operator().await;
        let created = env
            .api(
                &cookie,
                "createSession",
                json!({"hostId":env.config.host_id,"workDir":env.root,"requestId":"create"}),
            )
            .await;
        let sid = &created["sessionId"];
        assert_eq!(created["status"], "delivered");
        let turn = env
            .api(
                &cookie,
                "sendMessage",
                json!({"sessionId":sid,"message":"WAIT","requestId":"wait"}),
            )
            .await;
        assert_eq!(turn["status"], "delivered");
        let error = apply(
            &env.executable,
            &env.candidate,
            &env.state,
            VERSION,
            Duration::ZERO,
            DEADLINE,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("no tasks were interrupted"));
        let current = crate::status(&env.state, &env.config).await.unwrap();
        assert_eq!(current["instanceId"], previous["instanceId"]);
        assert_eq!(current["maintenance"], false);
        assert_eq!(
            env.api(&cookie, "getSession", json!({"sessionId":sid}))
                .await["session"]["activeTurnId"],
            turn["turnId"]
        );
        assert!(maintenance::transaction(&env.state).unwrap().is_none());
        assert!(env.candidate.exists());
    }

    #[tokio::test]
    async fn startup_timeout_refuses_live_native_rollback_and_recovers_after_exit() {
        let env = Environment::new();
        fs::write(env.home.join("upgrade-hang-initialize-once"), "synthetic").unwrap();
        assert!(
            apply(
                &env.executable,
                &env.candidate,
                &env.state,
                VERSION,
                Duration::ZERO,
                Duration::from_secs(1),
                None,
            )
            .await
            .is_err()
        );
        assert!(!maintenance::committed(&env.state).unwrap());
        let record = maintenance::transaction(&env.state).unwrap().unwrap();
        assert_eq!(hash(&record.previous).unwrap(), record.previous_hash);
        timeout(DEADLINE, async {
            while dewbow_daemon::verify_runtime_stopped(&env.state).is_err() {
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap();
        recover(&env.state, &env.executable, DEADLINE)
            .await
            .unwrap();
        assert!(maintenance::committed(&env.state).unwrap());
        assert_eq!(
            crate::status(&env.state, &env.config).await.unwrap()["status"],
            "stopped"
        );
    }

    #[tokio::test]
    async fn interrupted_switch_is_sealed_and_corrupt_backups_block_recovery() {
        let env = Environment::new();
        let lock = DaemonLock::acquire(&env.state).unwrap();
        let record = prepare(
            &env.state,
            &env.executable,
            &env.candidate,
            VERSION,
            true,
            &dewbow_protocol::id(),
        )
        .unwrap();
        replacement::commit(&env.executable, &env.candidate).unwrap();
        drop(lock);
        let status = env.start().await;
        assert_eq!(status["maintenance"], true);
        assert!(
            control(&env.config, &status, &record.token, "commitUpgrade")
                .await
                .is_err()
        );
        assert!(!maintenance::committed(&env.state).unwrap());
        let snapshot = env.state.join("upgrade/config.json");
        let saved = fs::read(&snapshot).unwrap();
        fs::write(&snapshot, "corrupt synthetic snapshot").unwrap();
        assert!(
            recover(&env.state, &env.executable, DEADLINE)
                .await
                .is_err()
        );
        assert!(!maintenance::committed(&env.state).unwrap());
        assert_eq!(hash(&record.previous).unwrap(), record.previous_hash);
        fs::write(&snapshot, saved).unwrap();
        let previous_bytes = fs::read(&record.previous).unwrap();
        fs::write(&record.previous, b"corrupt executable backup").unwrap();
        assert!(
            recover(&env.state, &env.executable, DEADLINE)
                .await
                .is_err()
        );
        assert!(!maintenance::committed(&env.state).unwrap());
        fs::write(&record.previous, previous_bytes).unwrap();
        recover(&env.state, &env.executable, DEADLINE)
            .await
            .unwrap();
        assert_eq!(
            crate::status(&env.state, &env.config).await.unwrap()["maintenance"],
            false
        );
    }
}
