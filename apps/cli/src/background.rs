#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
#[cfg(unix)]
use std::process::{Command, Stdio};

pub struct Background {
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
    #[cfg(unix)]
    child: std::process::Child,
}
impl Background {
    pub fn spawn(state: &Path) -> anyhow::Result<Self> {
        #[cfg(windows)]
        {
            use std::{
                os::windows::{
                    ffi::OsStrExt,
                    io::{FromRawHandle, RawHandle},
                },
                ptr,
            };
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::Threading::{
                    CREATE_NEW_PROCESS_GROUP, CreateProcessW, DETACHED_PROCESS,
                    PROCESS_INFORMATION, STARTUPINFOW,
                },
            };
            let executable = std::env::current_exe()?;
            let exe = executable
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let quote = |path: &Path| {
                let text = path.as_os_str().to_string_lossy();
                let trailing = text.chars().rev().take_while(|c| *c == '\\').count();
                format!("\"{}{}\"", text, "\\".repeat(trailing))
            };
            let mut line = format!(
                "{} --state-dir {} daemon run --background",
                quote(&executable),
                quote(state)
            )
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
                    DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                    ptr::null(),
                    ptr::null(),
                    &startup,
                    &mut process,
                )
            };
            anyhow::ensure!(
                success != 0,
                "Background startup failed: {}",
                std::io::Error::last_os_error()
            );
            unsafe {
                CloseHandle(process.hThread);
            }
            Ok(Self {
                handle: unsafe {
                    std::os::windows::io::OwnedHandle::from_raw_handle(
                        process.hProcess as RawHandle,
                    )
                },
            })
        }
        #[cfg(unix)]
        {
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(state.join("daemon.log"))?;
            let child = Command::new(std::env::current_exe()?)
                .arg("--state-dir")
                .arg(state)
                .args(["daemon", "run", "--background"])
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log))
                .process_group(0)
                .spawn()?;
            Ok(Self { child })
        }
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
        Ok(self.child.try_wait()?.is_some())
    }
}
