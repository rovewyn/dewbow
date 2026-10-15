#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::process::{Command, Stdio};
use std::{ffi::OsString, path::Path};

pub struct Background {
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
    #[cfg(unix)]
    child: Option<std::process::Child>,
}
impl Background {
    pub fn spawn(state: &Path) -> anyhow::Result<Self> {
        Self::spawn_executable(&std::env::current_exe()?, state)
    }
    pub fn spawn_executable(executable: &Path, state: &Path) -> anyhow::Result<Self> {
        Self::spawn_with(
            executable,
            &[
                "--state-dir".into(),
                state.as_os_str().into(),
                "daemon".into(),
                "run".into(),
                "--background".into(),
            ],
            &state.join("daemon.log"),
            false,
        )
    }
    pub fn spawn_args(executable: &Path, args: &[OsString], log: &Path) -> anyhow::Result<Self> {
        Self::spawn_with(executable, args, log, true)
    }
    fn spawn_with(
        executable: &Path,
        args: &[OsString],
        log: &Path,
        independent: bool,
    ) -> anyhow::Result<Self> {
        #[cfg(windows)]
        {
            use std::{
                os::windows::{
                    ffi::OsStrExt,
                    io::{FromRawHandle, RawHandle},
                },
                ptr,
            };
            use windows_sys::Win32::System::{
                JobObjects::IsProcessInJob,
                Threading::{
                    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED,
                    CreateProcessW, DETACHED_PROCESS, PROCESS_INFORMATION, ResumeThread,
                    STARTUPINFOW, TerminateProcess,
                },
            };
            let exe = executable
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let quote = |value: &std::ffi::OsStr| {
                let mut result = String::from("\"");
                let mut slashes = 0;
                for character in value.to_string_lossy().chars() {
                    if character == '\\' {
                        slashes += 1;
                        continue;
                    }
                    result.push_str(&"\\".repeat(if character == '"' {
                        slashes * 2 + 1
                    } else {
                        slashes
                    }));
                    result.push(character);
                    slashes = 0;
                }
                result.push_str(&"\\".repeat(slashes * 2));
                result.push('"');
                result
            };
            let _ = log; // Detached children write durable progress/results themselves on Windows.
            let mut parts = vec![quote(executable.as_os_str())];
            parts.extend(args.iter().map(|arg| quote(arg)));
            let mut line = parts
                .join(" ")
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
            // No launcher pipes, console, or arbitrary parent handles are inherited.
            let success = unsafe {
                CreateProcessW(
                    exe.as_ptr(),
                    line.as_mut_ptr(),
                    ptr::null(),
                    ptr::null(),
                    0,
                    DETACHED_PROCESS
                        | CREATE_NEW_PROCESS_GROUP
                        | CREATE_SUSPENDED
                        | if independent {
                            CREATE_BREAKAWAY_FROM_JOB
                        } else {
                            0
                        },
                    ptr::null(),
                    ptr::null(),
                    &startup,
                    &mut process,
                )
            };
            anyhow::ensure!(
                success != 0,
                "Background startup failed (independent upgrades require host job breakaway): {}",
                std::io::Error::last_os_error()
            );
            let thread = unsafe {
                std::os::windows::io::OwnedHandle::from_raw_handle(process.hThread as RawHandle)
            };
            let handle = unsafe {
                std::os::windows::io::OwnedHandle::from_raw_handle(process.hProcess as RawHandle)
            };
            let mut in_job = 0;
            // Console detachment alone does not escape an SSH host's kill-on-close
            // job. Check before any child code executes; refuse unsafe handoff.
            let detached = !independent
                || (unsafe { IsProcessInJob(process.hProcess, ptr::null_mut(), &mut in_job) } != 0
                    && in_job == 0);
            if !detached || unsafe { ResumeThread(process.hThread) } == u32::MAX {
                unsafe { TerminateProcess(process.hProcess, 1) };
                anyhow::bail!(
                    "Cannot detach the upgrade runner from the host job; no upgrade was started"
                );
            }
            drop(thread);
            Ok(Self { handle })
        }
        #[cfg(unix)]
        {
            let _ = independent;
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)?;
            let mut command = Command::new(executable);
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log));
            // A new session has no controlling terminal and is outside the SSH
            // terminal's process group. Only async-signal-safe work runs after fork.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let child = command.spawn()?;
            Ok(Self { child: Some(child) })
        }
    }
    pub fn pid(&self) -> u32 {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            unsafe {
                windows_sys::Win32::System::Threading::GetProcessId(self.handle.as_raw_handle())
            }
        }
        #[cfg(unix)]
        {
            self.child.as_ref().unwrap().id()
        }
    }
    /// Terminate only the process represented by our launch handle, never a recorded PID.
    pub fn terminate(&mut self) -> anyhow::Result<()> {
        if self.exited()? {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            anyhow::ensure!(
                unsafe {
                    windows_sys::Win32::System::Threading::TerminateProcess(
                        self.handle.as_raw_handle(),
                        1,
                    )
                } != 0,
                "Cannot terminate the launched candidate"
            );
        }
        #[cfg(unix)]
        self.child.as_mut().unwrap().kill()?;
        Ok(())
    }
    pub fn exited(&mut self) -> anyhow::Result<bool> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut code = 0;
            anyhow::ensure!(
                unsafe {
                    windows_sys::Win32::System::Threading::GetExitCodeProcess(
                        self.handle.as_raw_handle(),
                        &mut code,
                    )
                } != 0,
                "Cannot inspect the launched process"
            );
            Ok(code != 259)
        }
        #[cfg(unix)]
        Ok(self.child.as_mut().unwrap().try_wait()?.is_some())
    }
}

#[cfg(unix)]
impl Drop for Background {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take()
            && !matches!(child.try_wait(), Ok(Some(_)))
        {
            // Long-lived launchers must reap exited children. Do not tie this wait
            // to the Tokio runtime: its shutdown would wait for a running daemon.
            let _ = std::thread::Builder::new()
                .name("dewbow-reaper".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}
