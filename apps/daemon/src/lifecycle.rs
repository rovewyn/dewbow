use crate::{config, store::verify_runtime_stopped};
use anyhow::{Context, ensure};
use serde::Deserialize;
use std::{
    fs::{self, File, OpenOptions},
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
};

/// Retains exclusive ownership while inspecting or changing process records.
pub struct DaemonLock {
    _file: File,
    state: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Instance {
    instance_id: String,
    pid: u32,
    port: u16,
}

impl DaemonLock {
    pub fn acquire(state: &Path) -> anyhow::Result<Self> {
        let path = state.join("daemon.lock");
        dewbow_sdk::private::no_links(&path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        fs2::FileExt::try_lock_exclusive(&file).context("RECOVERY_REQUIRED: the selected daemon still owns its state directory; stop it before recovery or upgrade")?;
        Ok(Self {
            _file: file,
            state: state.to_path_buf(),
        })
    }

    /// Clear only demonstrably stale records. Never signal a recorded PID.
    pub fn recover_instance(&self) -> anyhow::Result<()> {
        verify_runtime_stopped(&self.state)?;
        let path = self.state.join("instance.json");
        dewbow_sdk::private::no_links(&path)?;
        if !path.try_exists()? {
            return Ok(());
        }
        dewbow_sdk::private::regular(&path)?;
        let record: Instance = serde_json::from_slice(&fs::read(&path)?)
            .context("Invalid daemon ownership record; manual recovery is required")?;
        ensure!(
            !record.instance_id.is_empty() && record.pid != 0 && record.port != 0,
            "Invalid daemon ownership record; manual recovery is required"
        );
        ensure!(
            !config::process_alive(record.pid)?,
            "The recorded daemon process is still alive; verify its ownership before recovery"
        );
        let config = config::load(&self.state)?;
        ensure!(
            record.port == config.port,
            "Daemon ownership and configuration ports differ; manual recovery is required"
        );
        // Binding reserves the port throughout removal and fails closed for any
        // other listener, including one that rejects our control credentials.
        let _listener = TcpListener::bind((Ipv4Addr::LOCALHOST, record.port)).context(
            "The recorded daemon port is occupied; recovery will not remove its ownership record",
        )?;
        fs::remove_file(path)?;
        Ok(())
    }
}
