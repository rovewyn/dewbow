use anyhow::Context;
use std::{fs, fs::OpenOptions, path::Path};

fn retain(executable: &Path, candidate: &Path, backup: &Path) -> anyhow::Result<()> {
    for path in [executable, candidate] {
        dewbow_sdk::private::no_links(path)?;
        dewbow_sdk::private::regular(path)?;
    }
    dewbow_sdk::private::no_links(backup)?;
    OpenOptions::new().write(true).open(candidate)?.sync_all()?;
    // A hard link preserves the old inode without ever removing the launch path.
    // It also refuses existing backups and filesystems without hard-link support.
    fs::hard_link(executable, backup)
        .context("Cannot retain the old executable; the installation was not replaced")?;
    sync_directory(executable.parent().context("Executable has no directory")?)
}

#[cfg(unix)]
fn atomic_replace(candidate: &Path, executable: &Path) -> std::io::Result<()> {
    fs::rename(candidate, executable)
}

#[cfg(windows)]
fn atomic_replace(candidate: &Path, executable: &Path) -> std::io::Result<()> {
    use std::{
        mem::{offset_of, size_of},
        os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_RENAME_INFO, FileRenameInfoEx, SetFileInformationByHandle,
    };

    let name: Vec<u16> = std::path::absolute(executable)?
        .as_os_str()
        .encode_wide()
        .collect();
    let length = offset_of!(FILE_RENAME_INFO, FileName) + size_of_val(name.as_slice());
    let mut buffer = vec![0usize; length.div_ceil(size_of::<usize>())];
    let file = OpenOptions::new().access_mode(DELETE).open(candidate)?;
    // FileRenameInfoEx with POSIX semantics can replace a mapped executable.
    // Unsupported OS/filesystem combinations fail with the old path intact;
    // deliberately do not fall back to moving the running executable aside.
    unsafe {
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        (*info).Anonymous.Flags = 0x1 | 0x2; // REPLACE_IF_EXISTS | POSIX_SEMANTICS
        (*info).FileNameLength =
            u32::try_from(size_of_val(name.as_slice())).map_err(std::io::Error::other)?;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            buffer.as_ptr().cast(),
            u32::try_from(length).map_err(std::io::Error::other)?,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

fn sync_directory(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path; // Windows does not expose POSIX directory fsync through std.
    Ok(())
}

fn commit(executable: &Path, candidate: &Path) -> anyhow::Result<()> {
    atomic_replace(candidate, executable).context(
        "Atomic replacement failed; the original executable and its backup were retained",
    )?;
    sync_directory(executable.parent().context("Executable has no directory")?).context(
        "Replacement completed, but directory synchronization failed; retain the executable backup",
    )
}

pub fn replace(executable: &Path, candidate: &Path, backup: &Path) -> anyhow::Result<()> {
    retain(executable, candidate, backup)?;
    commit(executable, candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn interrupted_replacement_keeps_a_launchable_path_and_immutable_backup() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dewbow-replace-test-{}", dewbow_protocol::id()));
        fs::create_dir(&root).unwrap();
        for phase in ["beforeBackup", "afterBackup", "afterCommit"] {
            let directory = root.join(phase);
            fs::create_dir(&directory).unwrap();
            let executable = directory.join(if cfg!(windows) {
                "dewbow.exe"
            } else {
                "dewbow"
            });
            fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
            let mut child = Command::new(&executable);
            dewbow_daemon::config::hidden(&mut child);
            let outcome = child
                .args(["--exact", "replacement::tests::replacement_worker"])
                .env("DEWBOW_REPLACEMENT_TEST", phase)
                .output()
                .unwrap();
            assert_eq!(
                outcome.status.code(),
                Some(73),
                "{}",
                String::from_utf8_lossy(&outcome.stderr)
            );
            assert!(executable.is_file(), "Launch path missing after {phase}");
            let mut probe = Command::new(&executable);
            dewbow_daemon::config::hidden(&mut probe);
            assert!(probe.arg("--list").output().unwrap().status.success());
            let backup = directory.join("previous");
            assert_eq!(backup.exists(), phase != "beforeBackup");
            if backup.exists() {
                let before = fs::read(&backup).unwrap();
                assert!(replace(&executable, &directory.join("candidate"), &backup).is_err());
                assert_eq!(fs::read(&backup).unwrap(), before);
            }
        }
        // Ordinary failures must retain the original path too.
        let executable = root.join("original");
        let candidate = root.join("candidate");
        let backup = root.join("previous");
        fs::write(&executable, b"previous").unwrap();
        fs::write(&candidate, b"next").unwrap();
        retain(&executable, &candidate, &backup).unwrap();
        assert!(commit(&executable, &root.join("missing")).is_err());
        assert_eq!(fs::read(&executable).unwrap(), b"previous");
        commit(&executable, &candidate).unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"next");
        assert_eq!(fs::read(&backup).unwrap(), b"previous");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_worker() {
        let Ok(phase) = std::env::var("DEWBOW_REPLACEMENT_TEST") else {
            return;
        };
        let executable = std::env::current_exe().unwrap();
        let directory = executable.parent().unwrap();
        let candidate = directory.join("candidate");
        fs::copy(&executable, &candidate).unwrap();
        if phase == "beforeBackup" {
            std::process::exit(73)
        }
        retain(&executable, &candidate, &directory.join("previous")).unwrap();
        if phase == "afterBackup" {
            std::process::exit(73)
        }
        commit(&executable, &candidate).unwrap();
        std::process::exit(73)
    }
}
