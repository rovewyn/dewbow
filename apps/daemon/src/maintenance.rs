use crate::service::Service;
use dewbow_protocol::{error, text};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

/// Private recovery metadata. Native conversations and credentials are never snapshotted.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transaction {
    pub contract_version: String,
    pub token: String,
    pub executable: PathBuf,
    pub previous: PathBuf,
    pub previous_hash: String,
    pub candidate_hash: String,
    pub previous_version: String,
    pub version: String,
    pub was_running: bool,
    pub config_hash: String,
    pub database_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_schema: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_hashes: Option<std::collections::BTreeMap<String, String>>,
}
pub fn transaction(state: &Path) -> anyhow::Result<Option<Transaction>> {
    let directory = state.join("upgrade");
    dewbow_sdk::private::no_links(&directory)?;
    if !directory.exists() {
        return Ok(None);
    }
    let path = directory.join("transaction.json");
    dewbow_sdk::private::regular(&path)?;
    let value: Transaction = serde_json::from_slice(&fs::read(path)?)?;
    anyhow::ensure!(
        matches!(value.contract_version.as_str(), "v1" | "v2")
            && uuid::Uuid::parse_str(&value.token).is_ok()
            && value.executable.is_absolute()
            && value.previous.parent() == value.executable.parent()
            && value.previous != value.executable,
        "Invalid upgrade transaction; preserve its files for recovery"
    );
    anyhow::ensure!(
        if value.contract_version == "v1" {
            value.state_schema.is_none() && value.key_hashes.is_none()
        } else {
            matches!(value.state_schema, Some(0..=2))
                && value.key_hashes.as_ref().is_some_and(|keys| {
                    keys.iter().all(|(id, hash)| {
                        uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == *id)
                            && hash.len() == 64
                            && hash.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                })
        },
        "Invalid upgrade key inventory; preserve its files for recovery"
    );
    Ok(Some(value))
}
pub fn committed(state: &Path) -> anyhow::Result<bool> {
    let path = state.join("upgrade/committed");
    dewbow_sdk::private::no_links(&path)?;
    if !path.exists() {
        return Ok(false);
    }
    dewbow_sdk::private::regular(&path)?;
    anyhow::ensure!(fs::read(path)? == b"v1\n", "Invalid upgrade commit record");
    Ok(true)
}
pub fn commit(state: &Path) -> anyhow::Result<()> {
    if committed(state)? {
        return sync_directory(&state.join("upgrade"));
    }
    publish_marker(state, "committed")
}
pub fn rollback_started(state: &Path) -> anyhow::Result<bool> {
    let path = state.join("upgrade/rollback");
    dewbow_sdk::private::no_links(&path)?;
    if !path.exists() {
        return Ok(false);
    }
    dewbow_sdk::private::regular(&path)?;
    anyhow::ensure!(fs::read(path)? == b"v1\n", "Invalid rollback record");
    Ok(true)
}
pub fn begin_rollback(state: &Path) -> anyhow::Result<()> {
    if rollback_started(state)? {
        return sync_directory(&state.join("upgrade"));
    }
    publish_marker(state, "rollback")
}
fn publish_marker(state: &Path, name: &str) -> anyhow::Result<()> {
    let directory = state.join("upgrade");
    dewbow_sdk::private::no_links(&directory)?;
    let stage = directory.join(format!(".{name}-{}.stage", dewbow_protocol::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&stage)?;
    #[cfg(test)]
    marker_checkpoint("created");
    file.write_all(b"v1\n")?;
    file.sync_all()?;
    drop(file);
    #[cfg(test)]
    marker_checkpoint("flushed");
    // A process exit during staging leaves the authoritative name absent, not
    // an empty record that would make the commit boundary ambiguous.
    fs::hard_link(&stage, directory.join(name))?;
    #[cfg(test)]
    marker_checkpoint("published");
    // Cleanup cannot invalidate a published marker or strand a verified daemon
    // in maintenance; an extra private staging link can be reviewed later.
    let _ = fs::remove_file(stage);
    sync_directory(&directory)
}
#[cfg(test)]
fn marker_checkpoint(phase: &str) {
    if std::env::var("DEWBOW_MARKER_EXIT").is_ok_and(|value| value == phase) {
        std::process::exit(73);
    }
}
pub fn sync_directory(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[derive(Default)]
struct Admission {
    lease: Option<(String, Option<Instant>)>,
    in_flight: usize,
    verified: bool,
}
#[derive(Default)]
pub(crate) struct Maintenance(Mutex<Admission>);
pub(crate) struct Operation<'a>(&'a Maintenance);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.0.lock().unwrap().in_flight -= 1;
    }
}
impl Maintenance {
    pub fn open(state: &Path) -> anyhow::Result<Self> {
        let is_committed = committed(state)?;
        let lease = transaction(state)?
            .filter(|_| !is_committed)
            .map(|record| (record.token, None));
        // A pending transaction is sealed across restarts, without an expiring lease.
        Ok(Self(Mutex::new(Admission {
            lease,
            in_flight: 0,
            verified: false,
        })))
    }
    fn lock(&self) -> MutexGuard<'_, Admission> {
        let mut gate = self.0.lock().unwrap();
        if gate
            .lease
            .as_ref()
            .is_some_and(|(_, expiry)| expiry.is_some_and(|t| t <= Instant::now()))
        {
            gate.lease = None;
        }
        gate
    }
    pub fn admit(&self, name: &str) -> anyhow::Result<Operation<'_>> {
        let mut gate = self.lock();
        if let Some((_, expiry)) = &gate.lease {
            anyhow::ensure!(
                expiry.is_some()
                    && !matches!(name, "createSession" | "connectSession" | "sendMessage"),
                error(
                    "UNAVAILABLE",
                    "Upgrade maintenance is waiting for existing work or validating startup."
                )
            );
        }
        gate.in_flight += 1;
        Ok(Operation(self))
    }
    pub fn active(&self) -> bool {
        self.lock().lease.is_some()
    }
    pub fn admit_cleanup(&self) -> Option<Operation<'_>> {
        let mut gate = self.lock();
        if gate.lease.is_some() {
            return None;
        }
        gate.in_flight += 1;
        Some(Operation(self))
    }
}
impl Service {
    pub(crate) async fn upgrade_control(&self, name: &str, input: &Value) -> anyhow::Result<Value> {
        anyhow::ensure!(
            input["instanceId"] == self.instance,
            error("RECOVERY_REQUIRED", "Upgrade instance changed.")
        );
        let token = text(input, "token")?;
        anyhow::ensure!(
            uuid::Uuid::parse_str(token).is_ok(),
            error("INVALID_INPUT", "Invalid upgrade token.")
        );
        if name == "validateUpgrade" {
            {
                let mut gate = self.maintenance.lock();
                anyhow::ensure!(
                    gate.lease
                        .as_ref()
                        .is_some_and(|(owner, expiry)| owner == token && expiry.is_none()),
                    error("UNAVAILABLE", "Startup is not sealed for this upgrade.")
                );
                gate.verified = false;
            }
            let models = self
                .runtime
                .request("model/list", json!({"includeHidden":true}))
                .await?;
            let inventory = self
                .runtime
                .request(
                    "thread/list",
                    json!({"limit":1,"archived":false,"useStateDbOnly":true}),
                )
                .await?;
            anyhow::ensure!(
                models["data"].is_array() && inventory["data"].is_array(),
                error("UNAVAILABLE", "Native startup verification failed.")
            );
            let mut gate = self.maintenance.lock();
            anyhow::ensure!(
                gate.lease
                    .as_ref()
                    .is_some_and(|(owner, expiry)| owner == token && expiry.is_none())
                    && !self.stopped.load(std::sync::atomic::Ordering::Relaxed),
                error(
                    "UNAVAILABLE",
                    "Startup stopped or maintenance changed during verification."
                )
            );
            gate.verified = true;
            return Ok(
                json!({"instanceId":self.instance,"version":env!("CARGO_PKG_VERSION"),"verified":true}),
            );
        }
        let mut gate = self.maintenance.lock();
        if name == "beginUpgrade" {
            anyhow::ensure!(
                gate.lease.as_ref().is_none_or(|(owner, _)| owner == token),
                error("UNAVAILABLE", "Another upgrade owns maintenance.")
            );
            anyhow::ensure!(
                !self.stopped.load(std::sync::atomic::Ordering::Relaxed),
                error("UNAVAILABLE", "Daemon is stopping.")
            );
            if gate.lease.is_none() {
                gate.lease = Some((token.into(), Some(Instant::now())));
            }
        }
        anyhow::ensure!(
            gate.lease.as_ref().is_some_and(|(owner, _)| owner == token),
            error(
                "UNAVAILABLE",
                "Upgrade maintenance ownership expired or changed."
            )
        );
        if let Some((_, Some(expiry))) = &mut gate.lease {
            *expiry = Instant::now() + Duration::from_secs(30);
        }
        let active = self
            .store
            .list("session")?
            .iter()
            .filter(|s| !s["activeTurnId"].is_null())
            .count();
        match name {
            "beginUpgrade" | "pollUpgrade" => {}
            "cancelUpgrade" => {
                anyhow::ensure!(
                    gate.lease.as_ref().unwrap().1.is_some(),
                    error("UNAVAILABLE", "Pending startup requires recovery.")
                );
                gate.lease = None;
            }
            "stopUpgrade" => {
                anyhow::ensure!(
                    active == 0 && gate.in_flight == 0,
                    error(
                        "SESSION_BUSY",
                        "Existing or unresolved work is still active."
                    )
                );
                gate.lease = Some((token.into(), None));
                self.stopped
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                self.shutting_down.notify_one();
            }
            "abortUpgrade" => {
                anyhow::ensure!(
                    gate.lease.as_ref().unwrap().1.is_none(),
                    error("UNAVAILABLE", "Only sealed startup can be aborted.")
                );
                self.stopped
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                self.shutting_down.notify_one();
            }
            "commitUpgrade" => {
                anyhow::ensure!(
                    gate.lease.as_ref().unwrap().1.is_none()
                        && gate.verified
                        && !self.stopped.load(std::sync::atomic::Ordering::Relaxed),
                    error(
                        "UNAVAILABLE",
                        "Startup must be sealed, verified and running before commit."
                    )
                );
                commit(&self.state)?;
                gate.lease = None;
            }
            _ => anyhow::bail!(error("NOT_FOUND", "Unknown upgrade operation.")),
        }
        Ok(json!({"instanceId":self.instance,"activeTurns":active,"inFlight":gate.in_flight}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_marker_publication_never_exposes_a_partial_record() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dewbow-marker-test-{}", dewbow_protocol::id()));
        crate::config::secure_directory(&root).unwrap();
        for name in ["committed", "rollback"] {
            for phase in ["created", "flushed", "published"] {
                let state = root.join(format!("{name}-{phase}"));
                crate::config::secure_directory(&state.join("upgrade")).unwrap();
                fs::write(state.join("synthetic.fixture"), "synthetic").unwrap();
                let mut worker = std::process::Command::new(std::env::current_exe().unwrap());
                crate::config::hidden(&mut worker);
                let result = worker
                    .args(["--exact", "maintenance::tests::marker_worker"])
                    .env("DEWBOW_MARKER_STATE", &state)
                    .env("DEWBOW_MARKER_NAME", name)
                    .env("DEWBOW_MARKER_EXIT", phase)
                    .output()
                    .unwrap();
                assert_eq!(
                    result.status.code(),
                    Some(73),
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
                let visible = if name == "committed" {
                    committed(&state)
                } else {
                    rollback_started(&state)
                }
                .unwrap();
                assert_eq!(visible, phase == "published");
                if name == "committed" {
                    commit(&state).unwrap();
                } else {
                    begin_rollback(&state).unwrap();
                }
                assert_eq!(fs::read(state.join("upgrade").join(name)).unwrap(), b"v1\n");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn marker_worker() {
        let Some(state) = std::env::var_os("DEWBOW_MARKER_STATE") else {
            return;
        };
        let state = PathBuf::from(state);
        assert_eq!(
            fs::read(state.join("synthetic.fixture")).unwrap(),
            b"synthetic"
        );
        match std::env::var("DEWBOW_MARKER_NAME").unwrap().as_str() {
            "committed" => commit(&state).unwrap(),
            "rollback" => begin_rollback(&state).unwrap(),
            _ => panic!("Unknown synthetic marker"),
        }
    }

    #[test]
    fn draining_lease_expires_but_startup_seal_does_not() {
        let maintenance = Maintenance::default();
        let accepted = maintenance.admit("sendMessage").unwrap();
        let cleanup = maintenance.admit_cleanup().unwrap();
        maintenance.0.lock().unwrap().lease = Some((
            "synthetic".into(),
            Some(Instant::now() + Duration::from_secs(30)),
        ));
        assert!(maintenance.admit("sendMessage").is_err());
        assert!(maintenance.admit("connectSession").is_err());
        assert!(maintenance.admit_cleanup().is_none());
        let answer = maintenance.admit("answerQuestions").unwrap();
        assert_eq!(maintenance.lock().in_flight, 3);
        drop(answer);
        drop(accepted);
        drop(cleanup);
        assert_eq!(maintenance.lock().in_flight, 0);
        maintenance.0.lock().unwrap().lease = Some(("synthetic".into(), Some(Instant::now())));
        assert!(!maintenance.active());
        assert!(maintenance.admit("sendMessage").is_ok());
        assert!(maintenance.admit_cleanup().is_some());
        maintenance.0.lock().unwrap().lease = Some(("synthetic".into(), None));
        assert!(maintenance.admit("answerQuestions").is_err());
        assert!(maintenance.admit("interruptTurn").is_err());
        assert!(maintenance.admit_cleanup().is_none());
        assert!(maintenance.active());
    }
}
