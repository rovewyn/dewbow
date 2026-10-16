use std::{fs, path::Path};

/// Publish a unique private file without replacing an existing identity.
pub fn publish_new(source: &Path, target: &Path) -> anyhow::Result<()> {
    no_links(source)?;
    no_links(target)?;
    #[cfg(unix)]
    {
        if target.exists() {
            use std::os::unix::fs::MetadataExt;
            let a = fs::metadata(source)?;
            let b = fs::metadata(target)?;
            anyhow::ensure!(
                a.dev() == b.dev() && a.ino() == b.ino(),
                "Private publication target already exists"
            );
        } else {
            fs::hard_link(source, target)?;
        }
        fs::File::open(target.parent().unwrap())?.sync_all()?;
        fs::remove_file(source)?;
        fs::File::open(target.parent().unwrap())?.sync_all()?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        anyhow::ensure!(
            unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0,
            "Private file publication failed: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok(())
}

/// Verify privacy on read instead of silently repairing a leaked key file.
pub fn private_file(path: &Path) -> anyhow::Result<()> {
    no_links(path)?;
    regular(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        anyhow::ensure!(
            fs::metadata(path)?.permissions().mode() & 0o077 == 0,
            "Private file permissions are too broad"
        );
    }
    #[cfg(windows)]
    unsafe {
        use std::{os::windows::ffi::OsStrExt, ptr};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, LocalFree},
            Security::{
                ACCESS_ALLOWED_ACE, ACL,
                Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
                DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetTokenInformation, IsWellKnownSid,
                TOKEN_QUERY, TOKEN_USER, TokenUser, WinLocalSystemSid,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut descriptor = ptr::null_mut();
        let mut acl: *mut ACL = ptr::null_mut();
        anyhow::ensure!(
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut acl,
                ptr::null_mut(),
                &mut descriptor
            ) == 0,
            "Cannot inspect private file ACL"
        );
        let result = (|| -> anyhow::Result<()> {
            anyhow::ensure!(!acl.is_null(), "Private file has an unrestricted ACL");
            let mut token = ptr::null_mut();
            anyhow::ensure!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
                "Cannot inspect local account"
            );
            let checked = (|| -> anyhow::Result<()> {
                let mut size = 0;
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
                let mut buffer =
                    vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
                anyhow::ensure!(
                    GetTokenInformation(
                        token,
                        TokenUser,
                        buffer.as_mut_ptr().cast(),
                        size,
                        &mut size
                    ) != 0,
                    "Cannot inspect local account SID"
                );
                let user = (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid;
                let mut allowed_user = false;
                for index in 0..(*acl).AceCount {
                    let mut raw = ptr::null_mut();
                    anyhow::ensure!(
                        GetAce(acl, u32::from(index), &mut raw) != 0,
                        "Cannot inspect private ACE"
                    );
                    let ace = raw.cast::<ACCESS_ALLOWED_ACE>();
                    // Reject unfamiliar grant types rather than interpreting them loosely.
                    if (*ace).Header.AceType == 1 {
                        continue;
                    }
                    anyhow::ensure!((*ace).Header.AceType == 0, "Unsupported private ACL grant");
                    let sid = ptr::addr_of!((*ace).SidStart).cast_mut().cast();
                    let same_user = EqualSid(sid, user) != 0;
                    anyhow::ensure!(
                        same_user || IsWellKnownSid(sid, WinLocalSystemSid) != 0,
                        "Private file ACL grants another account"
                    );
                    allowed_user |= same_user;
                }
                anyhow::ensure!(allowed_user, "Private file ACL has no local-account grant");
                Ok(())
            })();
            CloseHandle(token);
            checked
        })();
        LocalFree(descriptor);
        result?;
    }
    Ok(())
}

pub fn regular(path: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Expected a regular private file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(
            metadata.uid() == unsafe { libc::geteuid() },
            "File belongs to another account"
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        anyhow::ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "Reparse files are unsupported"
        );
        anyhow::ensure!(owned(path)?, "File belongs to another account");
    }
    Ok(())
}

#[cfg(windows)]
pub fn owned(path: &Path) -> anyhow::Result<bool> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
            EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, TOKEN_OWNER, TOKEN_QUERY,
            TOKEN_USER, TokenOwner, TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe {
        let mut sid = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        anyhow::ensure!(
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut sid,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut descriptor
            ) == 0,
            "Cannot read file ownership"
        );
        let result = (|| -> anyhow::Result<bool> {
            let mut token = ptr::null_mut();
            anyhow::ensure!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
                "Cannot read account token"
            );
            let query = (|| -> anyhow::Result<bool> {
                for class in [TokenUser, TokenOwner] {
                    let mut size = 0;
                    GetTokenInformation(token, class, ptr::null_mut(), 0, &mut size);
                    let mut buffer =
                        vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
                    anyhow::ensure!(
                        GetTokenInformation(
                            token,
                            class,
                            buffer.as_mut_ptr().cast(),
                            size,
                            &mut size
                        ) != 0,
                        "Cannot read account SID"
                    );
                    let current = if class == TokenUser {
                        (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid
                    } else {
                        (*(buffer.as_ptr().cast::<TOKEN_OWNER>())).Owner
                    };
                    if EqualSid(sid, current) != 0 {
                        return Ok(true);
                    }
                }
                Ok(false)
            })();
            CloseHandle(token);
            query
        })();
        LocalFree(descriptor);
        result
    }
}
pub fn no_links(path: &Path) -> anyhow::Result<()> {
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "Linked private paths are unsupported"
            );
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                anyhow::ensure!(
                    metadata.file_attributes() & 0x400 == 0,
                    "Reparse private paths are unsupported"
                );
            }
        }
    }
    Ok(())
}

pub fn process_alive(pid: u32) -> anyhow::Result<bool> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            anyhow::ensure!(
                GetLastError() == 87,
                "Cannot establish previous process state"
            );
            return Ok(false);
        }
        let mut code = 0;
        let success = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        anyhow::ensure!(success != 0, "Cannot establish previous process state");
        Ok(code == 259)
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(pid as i32, 0) == 0 {
            return Ok(true);
        }
        let code = std::io::Error::last_os_error().raw_os_error();
        if code == Some(libc::ESRCH) {
            Ok(false)
        } else if code == Some(libc::EPERM) {
            Ok(true)
        } else {
            anyhow::bail!("Cannot establish previous process state")
        }
    }
}

#[cfg(windows)]
pub fn protect_directory(path: &Path) -> anyhow::Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
            },
            DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetTokenInformation,
            PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    no_links(path)?;
    anyhow::ensure!(owned(path)?, "State belongs to another account");
    unsafe {
        let mut token = ptr::null_mut();
        anyhow::ensure!(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
            "Cannot read current account"
        );
        let result = (|| -> anyhow::Result<()> {
            let mut size = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
            let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            anyhow::ensure!(
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    size,
                    &mut size
                ) != 0,
                "Cannot read account SID"
            );
            let sid = (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid;
            let mut sid_string = ptr::null_mut();
            anyhow::ensure!(
                ConvertSidToStringSidW(sid, &mut sid_string) != 0,
                "Cannot format account SID"
            );
            let mut length = 0;
            while *sid_string.add(length) != 0 {
                length += 1;
            }
            let sid_text = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, length));
            LocalFree(sid_string.cast());
            let sddl = format!("D:P(A;OICI;FA;;;{sid_text})(A;OICI;FA;;;SY)")
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let mut descriptor = ptr::null_mut();
            anyhow::ensure!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    ptr::null_mut()
                ) != 0,
                "Cannot construct private ACL"
            );
            let protected = (|| -> anyhow::Result<()> {
                let mut present = 0;
                let mut defaulted = 0;
                let mut acl = ptr::null_mut();
                anyhow::ensure!(
                    GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
                        != 0
                        && present != 0,
                    "Cannot read private ACL"
                );
                let wide = path
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>();
                let status = SetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    acl,
                    ptr::null_mut(),
                );
                anyhow::ensure!(
                    status == 0,
                    "Cannot protect private state directory (Windows error {status})"
                );
                Ok(())
            })();
            LocalFree(descriptor);
            protected
        })();
        CloseHandle(token);
        result
    }
}
