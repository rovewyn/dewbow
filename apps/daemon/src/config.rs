use dewbow_protocol::id;
pub use dewbow_sdk::private::process_alive;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub contract_version: String,
    pub host_id: String,
    pub name: String,
    pub port: u16,
    pub codex_executable: PathBuf,
    pub codex_home: PathBuf,
    pub control_token: String,
}
pub fn user_home() -> anyhow::Result<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("User home is unavailable"))
}
pub fn default_state() -> anyhow::Result<PathBuf> {
    Ok(user_home()?.join(".dewbow"))
}
pub fn hidden(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}
pub fn secure_directory(path: &Path) -> anyhow::Result<()> {
    dewbow_sdk::private::no_links(path)?;
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = fs::metadata(path)?;
        let output = std::process::Command::new("id").arg("-u").output()?;
        anyhow::ensure!(
            meta.uid().to_string() == String::from_utf8(output.stdout)?.trim(),
            "State belongs to another account"
        );
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    dewbow_sdk::private::protect_directory(path)?;
    Ok(())
}
pub fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    use std::io::Write;
    dewbow_sdk::private::no_links(path)?;
    let temp = path.with_extension(format!("{}.tmp", id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    drop(file);
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temp, path)?;
    Ok(())
}
pub fn load(state: &Path) -> anyhow::Result<Config> {
    dewbow_sdk::private::no_links(state)?;
    let path = state.join("config.json");
    dewbow_sdk::private::regular(&path)?;
    let config: Config = serde_json::from_slice(&fs::read(path)?)?;
    anyhow::ensure!(
        config.contract_version == "v1" && config.port != 0,
        "Unsupported configuration"
    );
    Ok(config)
}
pub fn init(
    state: &Path,
    executable: Option<PathBuf>,
    home: Option<PathBuf>,
    port: Option<u16>,
) -> anyhow::Result<Config> {
    secure_directory(state)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state.join("init.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| anyhow::anyhow!("Another initialization is in progress"))?;
    if state.join("config.json").exists() {
        let config = load(state)?;
        anyhow::ensure!(
            executable
                .as_ref()
                .is_none_or(|v| v == &config.codex_executable)
                && home.as_ref().is_none_or(|v| v == &config.codex_home)
                && port.is_none_or(|v| v == config.port),
            "Existing configuration differs; edit it while stopped or select another state directory"
        );
        return Ok(config);
    }
    let config = Config {
        contract_version: "v1".into(),
        host_id: id(),
        name: "Local machine".into(),
        port: port.unwrap_or(3000),
        codex_executable: executable
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "codex.exe" } else { "codex" })),
        codex_home: home.unwrap_or(
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or(user_home()?.join(".codex")),
        ),
        control_token: format!("{}{}", id(), id()),
    };
    anyhow::ensure!(config.port != 0, "Port must not be zero");
    write_json(&state.join("config.json"), &config)?;
    Ok(config)
}
