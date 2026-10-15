use anyhow::{Context, bail, ensure};
use dewbow_daemon::config;
use semver::Version;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const REPOSITORY: &str = "https://github.com/rovewyn/dewbow";
const RELEASE_API: &str = "https://api.github.com/repos/rovewyn/dewbow/releases";

fn version(value: &str) -> anyhow::Result<Version> {
    let parsed = Version::parse(value).context("Expected an unprefixed SemVer release version")?;
    ensure!(
        parsed.build.is_empty() && parsed.to_string() == value,
        "Use an exact release version without a v prefix or build metadata"
    );
    Ok(parsed)
}

fn target() -> anyhow::Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("linux", "x86_64") if cfg!(target_env = "gnu") => Ok("x86_64-unknown-linux-gnu"),
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        _ => bail!("No Dewbow release binary supports this operating system and architecture"),
    }
}

fn hash(path: &Path) -> anyhow::Result<String> {
    let mut source = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let length = source.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    Ok(dewbow_protocol::hex(&digest.finalize()))
}

fn verify_checksum(checksum: &str, archive: &Path, name: &str) -> anyhow::Result<()> {
    ensure!(
        checksum.trim() == format!("{}  {name}", hash(archive)?),
        "Release archive checksum does not match"
    );
    Ok(())
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    limit: usize,
) -> anyhow::Result<()> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut length = 0;
    while let Some(chunk) = response.chunk().await? {
        length += chunk.len();
        ensure!(length <= limit, "Release download exceeds the size limit");
        output.write_all(&chunk)?;
    }
    output.sync_all()?;
    Ok(())
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tar(args: &[&std::ffi::OsStr]) -> anyhow::Result<String> {
    // Git for Windows' tar cannot safely handle native drive-qualified paths.
    let executable = if cfg!(windows) {
        PathBuf::from(std::env::var_os("SystemRoot").context("SystemRoot is unavailable")?)
            .join("System32/tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let mut command = Command::new(executable);
    config::hidden(&mut command);
    let output = command
        .args(args)
        .output()
        .context("A system tar executable is required")?;
    ensure!(output.status.success(), "Release archive operation failed");
    Ok(String::from_utf8(output.stdout)?)
}

fn unpack(archive: &Path, stage: &Path, name: &str, executable: &str) -> anyhow::Result<PathBuf> {
    let listing = tar(&["-tf".as_ref(), archive.as_os_str()])?;
    let allowed = [executable, "CLI.md", "release.json"].map(|file| format!("{name}/{file}"));
    let entries: Vec<_> = listing.lines().collect();
    ensure!(
        entries
            .iter()
            .all(|entry| *entry == format!("{name}/") || allowed.iter().any(|file| file == entry))
            && allowed
                .iter()
                .all(|file| entries.iter().filter(|entry| *entry == file).count() == 1),
        "Unexpected or missing release archive entries"
    );
    let details = tar(&["-tvf".as_ref(), archive.as_os_str()])?;
    ensure!(
        details
            .lines()
            .all(|line| line.starts_with('-') || line.starts_with('d')),
        "Links and special files are unsupported in release archives"
    );
    tar(&[
        "-xf".as_ref(),
        archive.as_os_str(),
        "-C".as_ref(),
        stage.as_os_str(),
    ])?;
    let directory = stage.join(name);
    for file in &allowed {
        dewbow_sdk::private::regular(&stage.join(file))?;
    }
    Ok(directory)
}

fn verify_binary(binary: &Path, expected: &str) -> anyhow::Result<()> {
    let mut command = Command::new(binary);
    config::hidden(&mut command);
    let output = command
        .arg("--version")
        .output()
        .context("Could not run the downloaded executable")?;
    ensure!(
        output.status.success()
            && String::from_utf8(output.stdout)?.trim() == format!("dewbow {expected}"),
        "Downloaded executable reports the wrong version"
    );
    Ok(())
}

fn replace(executable: &Path, candidate: &Path, backup: &Path) -> anyhow::Result<()> {
    ensure!(
        !backup.exists(),
        "A previous executable backup already exists; retain it elsewhere before upgrading"
    );
    fs::rename(executable, backup).context(
        "Cannot retain the old executable; check permissions and stop all Dewbow daemons",
    )?;
    if let Err(cause) = fs::rename(candidate, executable) {
        fs::rename(backup, executable).with_context(|| {
            format!(
                "Replacement and rollback failed; restore {} manually",
                backup.display()
            )
        })?;
        return Err(cause).context("Replacement failed; the original executable was restored");
    }
    Ok(())
}

fn lock_state(state: &Path) -> anyhow::Result<Option<File>> {
    if !state.exists() {
        return Ok(None);
    }
    dewbow_sdk::private::no_links(state)?;
    let lock_path = state.join("daemon.lock");
    dewbow_sdk::private::no_links(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .context("Stop the selected daemon with dewbow daemon stop before upgrading")?;
    ensure!(
        !state.join("instance.json").exists(),
        "A daemon ownership record remains; stop or recover the selected daemon before upgrading"
    );
    dewbow_daemon::verify_runtime_stopped(state)?;
    Ok(Some(lock))
}

pub async fn run(state: Option<&Path>, check: bool, requested: Option<&str>) -> anyhow::Result<()> {
    let target = target()?;
    if let Some(requested) = requested {
        version(requested)?;
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("dewbow/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()?;
    let url = requested.map_or_else(
        || format!("{RELEASE_API}/latest"),
        |value| format!("{RELEASE_API}/tags/{value}"),
    );
    let release: Value = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let selected = release["tag_name"]
        .as_str()
        .context("Release has no version tag")?;
    let selected_version = version(selected)?;
    ensure!(
        release["draft"] == false
            && (requested.is_some()
                || (release["prerelease"] == false && selected_version.pre.is_empty())),
        "Expected a published stable release"
    );
    ensure!(
        requested.is_none_or(|value| value == selected),
        "Release tag differs from the requested version"
    );
    let current = version(env!("CARGO_PKG_VERSION"))?;
    println!(
        "Installed: {current}; selected release: {selected} ({REPOSITORY}/releases/tag/{selected})"
    );
    if selected_version <= current {
        ensure!(
            requested.is_none() || selected_version == current,
            "Downgrades are not supported; follow the release's rollback instructions"
        );
        println!("No newer release to install.");
        return Ok(());
    }
    if check {
        return Ok(());
    }

    let executable = std::env::current_exe()?;
    dewbow_sdk::private::no_links(&executable)?;
    let parent = executable
        .parent()
        .context("Executable has no installation directory")?;
    ensure!(
        !parent.ends_with("target/debug") && !parent.ends_with("target/release"),
        "Use an installed release executable to upgrade; rebuild development executables from source"
    );
    let lock_path = parent.join(".dewbow-upgrade.lock");
    dewbow_sdk::private::no_links(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    fs2::FileExt::try_lock_exclusive(&lock).context("Another Dewbow upgrade is in progress")?;
    let state = std::path::absolute(match state {
        Some(state) => state.to_path_buf(),
        None => config::default_state()?,
    })?;
    let _state_lock = lock_state(&state)?;
    let stage = Stage(parent.join(format!(".dewbow-upgrade-{}", dewbow_protocol::id())));
    fs::create_dir(&stage.0)?;
    let name = format!("dewbow-{selected}-{target}");
    let binary_name = if cfg!(windows) {
        "dewbow.exe"
    } else {
        "dewbow"
    };
    let archive_name = format!("{name}.{}", if cfg!(windows) { "zip" } else { "tar.gz" });
    let archive = stage.0.join(&archive_name);
    let checksum = stage.0.join("checksum");
    let base = format!("{REPOSITORY}/releases/download/{selected}/{archive_name}");
    download(&client, &base, &archive, 128 * 1024 * 1024).await?;
    download(&client, &format!("{base}.sha256"), &checksum, 512).await?;
    verify_checksum(&fs::read_to_string(checksum)?, &archive, &archive_name)?;
    let directory = unpack(&archive, &stage.0, &name, binary_name)?;
    let candidate = directory.join(binary_name);
    let manifest: Value = serde_json::from_slice(&fs::read(directory.join("release.json"))?)?;
    ensure!(
        manifest["version"] == selected
            && manifest["target"] == target
            && manifest["executable"] == binary_name
            && manifest["binarySha256"] == hash(&candidate)?,
        "Release manifest does not match the executable, version or target"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755))?;
    }
    verify_binary(&candidate, selected)?;
    let backup = parent.join(format!(
        "{binary_name}.previous-{current}-{}",
        dewbow_protocol::id()
    ));
    replace(&executable, &candidate, &backup)?;
    println!(
        "Upgraded to {selected}. Previous executable retained as {}. Review release notes before restarting the daemon.",
        backup.file_name().unwrap().to_string_lossy()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_rolls_back_and_preserves_existing_backups() {
        let root =
            std::env::temp_dir().join(format!("dewbow-upgrade-test-{}", dewbow_protocol::id()));
        fs::create_dir(&root).unwrap();
        let stage = Stage(root);
        let binary = stage.0.join("dewbow");
        let candidate = stage.0.join("candidate");
        let backup = stage.0.join("dewbow.previous");
        fs::write(&binary, b"previous").unwrap();
        assert!(replace(&binary, &candidate, &backup).is_err());
        assert_eq!(fs::read(&binary).unwrap(), b"previous");
        fs::write(&candidate, b"next").unwrap();
        replace(&binary, &candidate, &backup).unwrap();
        assert_eq!(fs::read(&binary).unwrap(), b"next");
        assert_eq!(fs::read(&backup).unwrap(), b"previous");
        assert!(replace(&binary, &candidate, &backup).is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"previous");
    }

    #[test]
    fn rejects_corruption_and_a_running_or_stale_daemon() {
        let stage = Stage(
            std::env::temp_dir().join(format!("dewbow-upgrade-test-{}", dewbow_protocol::id())),
        );
        fs::create_dir(&stage.0).unwrap();
        let archive = stage.0.join("archive");
        fs::write(&archive, b"synthetic archive").unwrap();
        let checksum = format!("{}  archive\n", hash(&archive).unwrap());
        verify_checksum(&checksum, &archive, "archive").unwrap();
        fs::write(&archive, b"corrupt").unwrap();
        assert!(verify_checksum(&checksum, &archive, "archive").is_err());
        let lock = lock_state(&stage.0).unwrap();
        assert!(lock_state(&stage.0).is_err());
        drop(lock);
        fs::write(stage.0.join("instance.json"), b"{}").unwrap();
        assert!(lock_state(&stage.0).is_err());
    }
}
