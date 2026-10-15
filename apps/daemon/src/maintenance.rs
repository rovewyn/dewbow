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
        value.contract_version == "v1"
            && uuid::Uuid::parse_str(&value.token).is_ok()
            && value.executable.is_absolute()
            && value.previous.parent() == value.executable.parent()
            && value.previous != value.executable,
        "Invalid upgrade transaction; preserve its files for recovery"
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
        return Ok(());
    }
    let path = state.join("upgrade/committed");
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(b"v1\n")?;
    file.sync_all()?;
    sync_directory(&state.join("upgrade"))
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
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(state.join("upgrade/rollback"))?;
    file.write_all(b"v1\n")?;
    file.sync_all()?;
    sync_directory(&state.join("upgrade"))
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
    fn draining_lease_expires_but_startup_seal_does_not() {
        let maintenance = Maintenance::default();
        let accepted = maintenance.admit("sendMessage").unwrap();
        maintenance.0.lock().unwrap().lease = Some((
            "synthetic".into(),
            Some(Instant::now() + Duration::from_secs(30)),
        ));
        assert!(maintenance.admit("sendMessage").is_err());
        assert!(maintenance.admit("connectSession").is_err());
        let answer = maintenance.admit("answerQuestions").unwrap();
        assert_eq!(maintenance.lock().in_flight, 2);
        drop(answer);
        drop(accepted);
        assert_eq!(maintenance.lock().in_flight, 0);
        maintenance.0.lock().unwrap().lease = Some(("synthetic".into(), Some(Instant::now())));
        assert!(!maintenance.active());
        assert!(maintenance.admit("sendMessage").is_ok());
        maintenance.0.lock().unwrap().lease = Some(("synthetic".into(), None));
        assert!(maintenance.admit("answerQuestions").is_err());
        assert!(maintenance.admit("interruptTurn").is_err());
        assert!(maintenance.active());
    }
}
