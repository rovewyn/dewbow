use crate::{
    background::Background,
    replacement, transaction,
    upgrade::{self, Options},
};
use anyhow::{Context, ensure};
use dewbow_daemon::{
    config::{self, Config},
    maintenance,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::time::{Instant, sleep};

const ATTEMPTS: u32 = 3;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    contract_version: String,
    job_id: String,
    executable: PathBuf,
    state: PathBuf,
    runner_hash: String,
    options: Options,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Intent {
    pub token: String,
    pub was_running: bool,
    pub old_hash: String,
    pub old_version: String,
    pub config_hash: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Round {
    start: u32,
    recover: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attempt {
    index: u32,
    recover: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Outcome {
    status: String,
    message: String,
}
struct Lock {
    _file: File,
}
fn normalize(path: &Path) -> anyhow::Result<PathBuf> {
    dewbow_sdk::private::no_links(path)?;
    #[cfg(windows)]
    if path.is_file() {
        return normalize_file(path);
    }
    let mut parent = path;
    let mut remaining = Vec::new();
    while !parent.try_exists()? {
        remaining.push(
            parent
                .file_name()
                .context("Invalid upgrade path")?
                .to_os_string(),
        );
        parent = parent
            .parent()
            .context("Upgrade path has no existing parent")?;
    }
    let mut normalized = fs::canonicalize(parent)?;
    for component in remaining.into_iter().rev() {
        normalized.push(component);
    }
    Ok(normalized)
}

#[cfg(windows)]
fn normalize_file(path: &Path) -> anyhow::Result<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FindClose, FindFirstFileW, WIN32_FIND_DATAW,
        },
    };
    let parent = fs::canonicalize(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let query = parent.join(path.file_name().context("File has no name")?);
    let wide: Vec<u16> = query.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut found: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut found) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    unsafe {
        FindClose(handle);
    }
    ensure!(
        found.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "Reparse private paths are unsupported"
    );
    let length = found
        .cFileName
        .iter()
        .position(|&c| c == 0)
        .context("Invalid file name")?;
    // Resolve the selected directory entry, not an open inode whose launch name
    // may be replaced while GetFinalPathNameByHandle resolves another hard link.
    Ok(parent.join(std::ffi::OsString::from_wide(&found.cFileName[..length])))
}

fn lock(path: &Path) -> anyhow::Result<Option<Lock>> {
    dewbow_sdk::private::no_links(path)?;
    if path.exists() {
        dewbow_sdk::private::regular(path)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(Lock { _file: file })),
        Err(cause) if cause.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
            Ok(None)
        }
        Err(cause) => Err(cause.into()),
    }
}
pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    dewbow_sdk::private::no_links(path)?;
    dewbow_sdk::private::regular(path)?;
    ensure!(
        fs::metadata(path)?.len() <= 65536,
        "Upgrade record exceeds its size limit"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub(crate) fn write_new(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    use std::io::Write;
    dewbow_sdk::private::no_links(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let temp = path.with_extension(format!("{}.part", dewbow_protocol::id()));
    let mut file = options.open(&temp)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    drop(file);
    // Publish complete immutable records without an overwrite or a partial JSON window.
    fs::hard_link(&temp, path)?;
    let _ = fs::remove_file(temp);
    maintenance::sync_directory(path.parent().context("Record has no directory")?)
}
fn write_atomic(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    dewbow_sdk::private::no_links(path)?;
    if path.exists() {
        dewbow_sdk::private::regular(path)?;
    }
    let temp = path.with_extension(format!("{}.tmp", dewbow_protocol::id()));
    write_new(&temp, value)?;
    replacement::commit(path, &temp)
}
fn root(executable: &Path) -> anyhow::Result<PathBuf> {
    dewbow_sdk::private::no_links(executable)?;
    fs::metadata(executable)?;
    let parent = executable
        .parent()
        .context("Installation has no directory")?;
    Ok(fs::canonicalize(parent)?.join(".dewbow-updater"))
}
fn runner(job: &Path) -> PathBuf {
    job.join(if cfg!(windows) {
        "runner.exe"
    } else {
        "runner"
    })
}
fn request(job: &Path) -> anyhow::Result<Request> {
    let request: Request = read_json(&job.join("request.json"))?;
    ensure!(
        request.contract_version == "v1"
            && request.state.is_absolute()
            && request.executable.is_absolute()
            && job == root(&request.executable)?.join("active")
            && !request.options.check
            && !request.options.status
            && !request.options.detach
            && request.options.wait_seconds <= 86400
            && (1..=600).contains(&request.options.timeout_seconds)
            && request.job_id.len() == 36
            && request
                .job_id
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-'),
        "Invalid independent upgrade request"
    );
    Ok(request)
}
pub(crate) fn phase(job: Option<&Path>, name: &str) -> anyhow::Result<()> {
    if let Some(job) = job {
        write_atomic(&job.join("progress.json"), &json!({"phase":name}))?;
    }
    Ok(())
}
pub(crate) async fn record_intent(
    job: Option<&Path>,
    token: &str,
    was_running: bool,
    config: Option<&Config>,
) -> anyhow::Result<()> {
    let Some(job) = job else {
        return Ok(());
    };
    let request = request(job)?;
    let old_hash = upgrade::hash(&request.executable)?;
    ensure!(
        old_hash == request.runner_hash,
        "Installation changed before maintenance; upgrade refused"
    );
    let config_hash = config
        .map(|_| upgrade::hash(&request.state.join("config.json")))
        .transpose()?;
    write_new(
        &job.join("intent.json"),
        &Intent {
            token: token.into(),
            was_running,
            old_hash,
            old_version: env!("CARGO_PKG_VERSION").into(),
            config_hash,
        },
    )
}

fn spawn(job: &Path, worker: Option<u32>) -> anyhow::Result<Background> {
    let mut args = vec![
        "upgrade-internal".into(),
        "--job".into(),
        job.as_os_str().into(),
        "--job-id".into(),
        request(job)?.job_id.into(),
    ];
    if let Some(index) = worker {
        args.extend(["--worker".into(), index.to_string().into()]);
    }
    Background::spawn_args(&runner(job), &args, &job.join("runner.log"))
}
fn outcome_path(job: &Path, round: &Round) -> PathBuf {
    job.join(format!("result-{}.json", round.start))
}
fn accepted_path(job: &Path) -> anyhow::Result<PathBuf> {
    let round: Round = read_json(&job.join("round.json"))?;
    Ok(job.join(format!("accepted-{}.json", round.start)))
}
fn completed(job: &Path) -> anyhow::Result<Option<Outcome>> {
    let round: Round = read_json(&job.join("round.json"))?;
    let path = outcome_path(job, &round);
    if path.exists() {
        Ok(Some(read_json(&path)?))
    } else {
        Ok(None)
    }
}
fn status(job: &Path) -> anyhow::Result<Value> {
    let request = request(job)?;
    if let Some(outcome) = completed(job)? {
        return Ok(
            json!({"jobId":request.job_id,"status":outcome.status,"message":outcome.message}),
        );
    }
    let progress = if job.join("progress.json").exists() {
        read_json::<Value>(&job.join("progress.json"))?
    } else {
        json!({"phase":"starting"})
    };
    // Status never acquires a lock, creates files or restarts a process.
    Ok(json!({"jobId":request.job_id,"status":"pending","phase":progress["phase"]}))
}
fn rename_job(from: &Path, to: &Path) -> anyhow::Result<()> {
    #[cfg(not(windows))]
    fs::rename(from, to).context("Cannot rename the private upgrade job")?;
    #[cfg(windows)]
    {
        // Publication holds launch.lock and checks role fences first. A delayed
        // child may still have the runner image open while waiting for that lock;
        // its five-second acquisition deadline must expire before archival can
        // rename the directory. Never kill diagnostic PIDs or release publication.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match fs::rename(from, to) {
                Ok(()) => break,
                Err(cause)
                    if matches!(cause.raw_os_error(), Some(5 | 32))
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(cause) => return Err(cause).context("Cannot rename the private upgrade job"),
            }
        }
    }
    Ok(())
}
fn create_job(executable: &Path, state: &Path, options: &Options) -> anyhow::Result<PathBuf> {
    let root = root(executable)?;
    let job = root.join("active");
    if job.exists() {
        let previous = request(&job)?;
        ensure!(
            completed(&job)?.is_some_and(|v| v.status != "recoveryRequired"),
            "The preceding upgrade needs recovery; use upgrade --recover"
        );
        let guard = lock(&job.join("supervisor.lock"))?
            .context("The preceding updater is still exiting; retry shortly")?;
        let worker = lock(&job.join("worker.lock"))?
            .context("The preceding worker is still exiting; retry shortly")?;
        // The caller holds launch.lock, so no child can acquire a role between
        // this check and archival. Windows requires these directory-contained
        // lock handles to be closed before renaming the completed job.
        drop(worker);
        drop(guard);
        rename_job(&job, &root.join(format!("history-{}", previous.job_id)))?;
    }
    let id = dewbow_protocol::id();
    let stage = root.join(format!(".stage-{id}"));
    config::secure_directory(&stage)?;
    transaction::copy(executable, &runner(&stage))?;
    let mut options = options.clone();
    options.detach = false;
    options.archive = options.archive.map(std::path::absolute).transpose()?;
    write_new(
        &stage.join("request.json"),
        &Request {
            contract_version: "v1".into(),
            job_id: id,
            executable: executable.into(),
            state: state.into(),
            runner_hash: upgrade::hash(&runner(&stage))?,
            options,
        },
    )?;
    write_new(
        &stage.join("round.json"),
        &Round {
            start: 0,
            recover: options_recover(&stage)?,
        },
    )?;
    config::secure_directory(&stage.join("attempts"))?;
    rename_job(&stage, &job)?;
    maintenance::sync_directory(&root)?;
    Ok(job)
}
fn options_recover(stage: &Path) -> anyhow::Result<bool> {
    Ok(read_json::<Request>(&stage.join("request.json"))?
        .options
        .recover)
}

pub async fn submit(executable: &Path, state: &Path, options: &Options) -> anyhow::Result<()> {
    if options.check {
        return upgrade::run(executable, state, options, None).await;
    }
    let executable_path = normalize(executable)?;
    let state_path = normalize(state)?;
    let executable = executable_path.as_path();
    let state = state_path.as_path();
    let root = root(executable)?;
    let job = root.join("active");
    if options.status {
        println!(
            "{}",
            if job.exists() {
                status(&job)?
            } else {
                json!({"status":"idle"})
            }
        );
        return Ok(());
    }
    // Validate installation authority and filesystem support before publishing a job.
    if !root.exists() {
        drop(upgrade::installation_lock(executable)?);
    }
    config::secure_directory(&root)?;
    let launch = lock(&root.join("launch.lock"))?
        .context("Another upgrade handoff is being published; retry shortly")?;
    let selected = if job.exists() && completed(&job)?.is_none() {
        let prior = request(&job)?;
        ensure!(
            prior.executable == executable && prior.state == state,
            "Another state directory owns the active installation upgrade"
        );
        ensure!(
            (!options.recover
                || (lock(&job.join("supervisor.lock"))?.is_some()
                    && lock(&job.join("worker.lock"))?.is_some()))
                && options
                    .version
                    .as_ref()
                    .is_none_or(|v| Some(v) == prior.options.version.as_ref()),
            "An upgrade is active; inspect upgrade --status before requesting recovery or another version"
        );
        job
    } else if job.exists()
        && options.recover
        && completed(&job)?.is_some_and(|r| r.status == "recoveryRequired")
    {
        let prior = request(&job)?;
        ensure!(
            prior.executable == executable && prior.state == state,
            "Select the state directory that owns this recovery"
        );
        ensure!(
            lock(&job.join("supervisor.lock"))?.is_some()
                && lock(&job.join("worker.lock"))?.is_some(),
            "Recovery is still active"
        );
        let old: Round = read_json(&job.join("round.json"))?;
        write_atomic(
            &job.join("round.json"),
            &Round {
                start: old
                    .start
                    .checked_add(ATTEMPTS)
                    .context("Too many recovery rounds")?,
                recover: true,
            },
        )?;
        job
    } else {
        if options.recover {
            ensure!(
                maintenance::transaction(state)?.is_some() && !maintenance::committed(state)?,
                "No uncommitted upgrade needs recovery; inspect upgrade --status"
            );
        }
        drop(upgrade::installation_lock(executable)?);
        create_job(executable, state, options)?
    };
    let job_id = request(&selected)?.job_id;
    let mut supervisor = spawn(&selected, None)?;
    drop(launch);
    let accepted = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            ensure!(
                request(&selected)?.job_id == job_id,
                "Upgrade job changed during handoff"
            );
            if accepted_path(&selected)?.exists() || completed(&selected)?.is_some() {
                return Ok::<_, anyhow::Error>(());
            }
            ensure!(
                !supervisor.exited()? || lock(&selected.join("supervisor.lock"))?.is_none(),
                "Independent supervisor exited before accepting the job; retry upgrade to resume it"
            );
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context(
        "Upgrade handoff is unconfirmed; use upgrade --status or repeat upgrade to resume it",
    )?;
    accepted?;
    println!(
        "Independent upgrade accepted. Closing this terminal does not cancel it; inspect with upgrade --status."
    );
    if options.detach {
        println!("{}", status(&selected)?);
        return Ok(());
    }
    let outcome = observe(&selected, &job_id, true, vec![supervisor]).await?;
    ensure!(
        outcome.status == "succeeded" || (options.recover && outcome.status == "recovered"),
        "{}",
        outcome.message
    );
    Ok(())
}

fn reap(children: &mut Vec<Background>) -> anyhow::Result<()> {
    for index in (0..children.len()).rev() {
        if children[index].exited()? {
            children.swap_remove(index);
        }
    }
    Ok(())
}
async fn observe(
    job: &Path,
    job_id: &str,
    report: bool,
    mut children: Vec<Background>,
) -> anyhow::Result<Outcome> {
    let mut previous = Value::Null;
    let mut last_spawn = Instant::now();
    let mut replacements = 0;
    loop {
        reap(&mut children)?;
        ensure!(
            request(job)?.job_id == job_id,
            "The observed upgrade was archived; inspect upgrade --status"
        );
        if let Some(outcome) = completed(job)? {
            // Reap our own controllers before a startup command may exec the
            // restored installation; exec would discard its reaper threads.
            tokio::time::timeout(Duration::from_secs(5), async {
                while !children.is_empty() {
                    reap(&mut children)?;
                    sleep(Duration::from_millis(20)).await;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .context("Upgrade finished but controller exit is unconfirmed; retry the command")??;
            if report {
                println!("{}", serde_json::to_string(&outcome)?);
            }
            return Ok(outcome);
        }
        let progress = status(job)?;
        if progress != previous {
            if report {
                println!("{progress}");
            }
            previous = progress;
        }
        if last_spawn.elapsed() >= Duration::from_secs(1)
            && lock(&job.join("supervisor.lock"))?.is_some()
        {
            ensure!(
                replacements < ATTEMPTS,
                "Supervisor restart limit reached; inspect private runner diagnostics and repeat upgrade after resolving the failure"
            );
            children.push(spawn(job, None)?);
            replacements += 1;
            last_spawn = Instant::now();
        }
        sleep(Duration::from_millis(200)).await;
    }
}

pub async fn recover_before_start(executable: &Path, state: &Path) -> anyhow::Result<bool> {
    let job = root(executable)?.join("active");
    if !job.exists() {
        return Ok(false);
    }
    let launch = lock(&job.parent().unwrap().join("launch.lock"))?
        .context("An upgrade handoff is being published; retry startup shortly")?;
    let prior = request(&job)?;
    if normalize(&prior.executable)? != normalize(executable)?
        || normalize(&prior.state)? != normalize(state)?
    {
        return Ok(false);
    }
    if let Some(outcome) = completed(&job)? {
        ensure!(
            outcome.status != "recoveryRequired",
            "Upgrade recovery is blocked; inspect upgrade --status and retry upgrade --recover after resolving the condition"
        );
        return Ok(false);
    }
    let before = upgrade::hash(executable)?;
    let supervisor = spawn(&job, None)?;
    drop(launch);
    let outcome = observe(&job, &prior.job_id, false, vec![supervisor]).await?;
    ensure!(
        outcome.status != "recoveryRequired",
        "Automatic upgrade recovery requires inspection; use upgrade --status"
    );
    Ok(upgrade::hash(executable)? != before)
}

async fn publication(job: &Path) -> anyhow::Result<Lock> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(lock) = lock(
                &job.parent()
                    .context("Job has no directory")?
                    .join("launch.lock"),
            )? {
                return Ok::<_, anyhow::Error>(lock);
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .context("Upgrade publication lock timed out")?
}
pub async fn internal(job: &Path, job_id: &str, worker: Option<u32>) -> anyhow::Result<()> {
    // Serialize role acquisition with publication and archival. A delayed child
    // carries its immutable job identity and cannot execute a later active job.
    let publication = publication(job).await?;
    let request = request(job)?;
    ensure!(
        request.job_id == job_id,
        "A delayed updater cannot execute another job"
    );
    let role = lock(&job.join(if worker.is_some() {
        "worker.lock"
    } else {
        "supervisor.lock"
    }))?;
    drop(publication);
    let Some(role) = role else {
        return Ok(());
    };
    #[cfg(windows)]
    {
        use std::os::windows::io::IntoRawHandle;
        use windows_sys::Win32::System::Console::{
            STD_ERROR_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
        };
        let path = job.join("runner.log");
        dewbow_sdk::private::no_links(&path)?;
        let log = OpenOptions::new().create(true).append(true).open(path)?;
        let handle = log.into_raw_handle();
        // Detached children inherit no handles. This process owns a diagnostics
        // handle that the OS releases on exit, including abnormal termination.
        ensure!(
            unsafe {
                SetStdHandle(STD_OUTPUT_HANDLE, handle) != 0
                    && SetStdHandle(STD_ERROR_HANDLE, handle) != 0
            },
            "Cannot attach private upgrade diagnostics"
        );
    }
    ensure!(
        fs::canonicalize(std::env::current_exe()?)? == fs::canonicalize(runner(job))?
            && upgrade::hash(&runner(job))? == request.runner_hash,
        "The retained upgrade runner changed; execution refused"
    );
    if let Some(index) = worker {
        work(job, &request, index, role).await
    } else {
        supervise(job, &request, role).await
    }
}

fn attempt_dir(job: &Path, index: u32) -> PathBuf {
    job.join("attempts").join(index.to_string())
}
async fn supervise(job: &Path, request: &Request, _guard: Lock) -> anyhow::Result<()> {
    write_atomic(
        &job.join("supervisor.json"),
        &json!({"pid":std::process::id()}),
    )?;
    let round: Round = read_json(&job.join("round.json"))?;
    if completed(job)?.is_some() {
        return Ok(());
    }
    let mut recovering = round.recover || request.options.recover;
    for index in round.start
        ..round
            .start
            .checked_add(ATTEMPTS)
            .context("Invalid attempt range")?
    {
        let directory = attempt_dir(job, index);
        if !directory.exists() {
            let stage = job
                .join("attempts")
                .join(format!(".stage-{}", dewbow_protocol::id()));
            config::secure_directory(&stage)?;
            write_new(
                &stage.join("request.json"),
                &Attempt {
                    index,
                    recover: recovering,
                },
            )?;
            fs::rename(stage, &directory)?;
            maintenance::sync_directory(&job.join("attempts"))?;
        }
        let attempt: Attempt = read_json(&directory.join("request.json"))?;
        ensure!(attempt.index == index, "Upgrade attempt identity changed");
        let mut child = if !directory.join("started.json").exists()
            && lock(&job.join("worker.lock"))?.is_some()
        {
            Some(spawn(job, Some(index))?)
        } else {
            None
        };
        let deadline = Instant::now()
            + Duration::from_secs(
                request.options.wait_seconds + request.options.timeout_seconds * 12 + 600,
            );
        loop {
            let exited = if let Some(child) = &mut child {
                child.exited()? && lock(&job.join("worker.lock"))?.is_some()
            } else {
                lock(&job.join("worker.lock"))?.is_some()
            };
            if exited {
                break;
            }
            if Instant::now() >= deadline {
                if let Some(child) = &mut child
                    && !child.exited()?
                {
                    child.terminate()?;
                } else {
                    return finish(
                        job,
                        &round,
                        "recoveryRequired",
                        "An adopted worker still owns the job; no process was killed and no state was restored.",
                    ).await;
                }
            }
            sleep(Duration::from_millis(100)).await;
        }
        if !accepted_path(job)?.exists() {
            write_new(&accepted_path(job)?, &json!({"jobId":request.job_id}))?;
        }
        if directory.join("result.json").exists() {
            let outcome: Outcome = read_json(&directory.join("result.json"))?;
            if outcome.status != "retry" {
                return finish(job, &round, &outcome.status, &outcome.message).await;
            }
        }
        recovering = job.join("intent.json").exists() || request.options.recover;
        phase(
            Some(job),
            if recovering { "recovering" } else { "retrying" },
        )?;
        sleep(Duration::from_millis(300)).await;
    }
    finish(
        job,
        &round,
        "recoveryRequired",
        "Automatic attempts were exhausted. Private checkpoints are retained; inspect upgrade --status and use upgrade --recover after resolving ownership or file errors.",
    ).await
}
async fn finish(job: &Path, round: &Round, status: &str, message: &str) -> anyhow::Result<()> {
    let _publication = publication(job).await?;
    let worker = lock(&job.join("worker.lock"))?;
    let (status, message) = if worker.is_none() && status != "recoveryRequired" {
        (
            "recoveryRequired",
            "A late worker still owns this job; inspect its checkpoints before retrying recovery.",
        )
    } else {
        (status, message)
    };
    write_new(
        &outcome_path(job, round),
        &Outcome {
            status: status.into(),
            message: message.into(),
        },
    )
}

async fn work(job: &Path, request: &Request, index: u32, _worker: Lock) -> anyhow::Result<()> {
    if completed(job)?.is_some() {
        return Ok(());
    }
    let round: Round = read_json(&job.join("round.json"))?;
    ensure!(
        index >= round.start
            && index
                < round
                    .start
                    .checked_add(ATTEMPTS)
                    .context("Invalid attempt range")?,
        "A delayed worker belongs to a preceding recovery round"
    );
    let directory = attempt_dir(job, index);
    if directory.join("started.json").exists() {
        return Ok(());
    }
    let attempt: Attempt = read_json(&directory.join("request.json"))?;
    let _installation = upgrade::installation_lock(&request.executable)?;
    write_new(
        &directory.join("started.json"),
        &json!({"pid":std::process::id()}),
    )?;
    write_atomic(
        &job.join("worker.json"),
        &json!({"pid":std::process::id(),"attempt":index}),
    )?;
    if !accepted_path(job)?.exists() {
        write_new(&accepted_path(job)?, &json!({"jobId":request.job_id}))?;
    }
    let action = async {
        if attempt.recover {
            phase(Some(job), "recovering")?;
            if job.join("intent.json").exists() {
                let intent: Intent = read_json(&job.join("intent.json"))?;
                transaction::resume_interrupted(
                    &request.executable,
                    &request.state,
                    job,
                    &intent,
                    Duration::from_secs(request.options.timeout_seconds),
                )
                .await
            } else {
                transaction::recover(
                    &request.state,
                    &request.executable,
                    Duration::from_secs(request.options.timeout_seconds),
                )
                .await?;
                Ok("recovered")
            }
        } else {
            phase(Some(job), "preparing")?;
            upgrade::run(
                &request.executable,
                &request.state,
                &request.options,
                Some(job),
            )
            .await?;
            Ok("succeeded")
        }
    };
    tokio::pin!(action);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    let mut replacements = 0;
    let result = loop {
        tokio::select! {
            result = &mut action => break result,
            _ = heartbeat.tick() => {
                if replacements < ATTEMPTS && lock(&job.join("supervisor.lock"))?.is_some() {
                    spawn(job, None)?;
                    replacements += 1;
                }
            }
        }
    };
    let outcome = match result {
        Ok(status) => Outcome {
            status: status.into(),
            message: if status == "recovered" {
                "The interrupted upgrade was restored and verified.".into()
            } else {
                "Upgrade completed and verified.".into()
            },
        },
        Err(cause) => Outcome {
            status: if attempt.recover || job.join("intent.json").exists() {
                "retry"
            } else {
                "failed"
            }
            .into(),
            message: cause.to_string(),
        },
    };
    write_new(&directory.join("result.json"), &outcome)?;
    // Replenish a lost supervisor before releasing the worker fence.
    if lock(&job.join("supervisor.lock"))?.is_some() {
        spawn(job, None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transaction::tests::Environment;
    use std::process::{Command, Stdio};
    const LIMIT: Duration = Duration::from_secs(30);
    const VERSION: &str = env!("CARGO_PKG_VERSION");

    #[cfg(windows)]
    #[test]
    fn installation_paths_stay_stable_during_atomic_replacement() {
        use std::sync::{Arc, Barrier};
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let directory = parent.join(format!("dewbow-path-race-test-{}", dewbow_protocol::id()));
        fs::create_dir(&directory).unwrap();
        let executable = directory.join("dewbow.exe");
        fs::write(&executable, b"previous").unwrap();
        assert_eq!(
            normalize(&directory.join("DEWBOW.EXE")).unwrap(),
            executable
        );
        let expected = directory.join(".dewbow-updater");
        let barrier = Arc::new(Barrier::new(2));
        let writer_directory = directory.clone();
        let writer_barrier = barrier.clone();
        let writer = std::thread::spawn(move || {
            writer_barrier.wait();
            for index in 0..1000 {
                let candidate = writer_directory.join("candidate");
                fs::write(&candidate, b"next").unwrap();
                replacement::replace(
                    &writer_directory.join("dewbow.exe"),
                    &candidate,
                    &writer_directory.join(format!("previous-{index}")),
                )
                .unwrap();
            }
        });
        barrier.wait();
        let observed = (0..1000).try_for_each(|_| -> anyhow::Result<()> {
            ensure!(
                normalize(&executable)? == executable,
                "Installation name changed"
            );
            ensure!(root(&executable)? == expected, "Upgrade directory changed");
            Ok(())
        });
        writer.join().unwrap();
        fs::remove_dir_all(&directory).unwrap();
        observed.unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn job_directory_rename_waits_for_a_temporary_windows_handle() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = parent.join(format!("dewbow-job-rename-test-{}", dewbow_protocol::id()));
        fs::create_dir(&root).unwrap();
        let active = root.join("active");
        let history = root.join("history");
        fs::create_dir(&active).unwrap();
        fs::write(active.join("synthetic.fixture"), "synthetic").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(active.join("synthetic.fixture"))
            .unwrap();
        let blocked = fs::rename(&active, &history).unwrap_err();
        assert!(matches!(blocked.raw_os_error(), Some(5 | 32)));
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(held);
        });
        rename_job(&active, &history).unwrap();
        release.join().unwrap();
        assert!(!active.exists());
        assert_eq!(
            fs::read_to_string(history.join("synthetic.fixture")).unwrap(),
            "synthetic"
        );
        assert_eq!(
            fs::canonicalize(&root).unwrap().parent(),
            Some(parent.as_path())
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn prepared(env: &Environment) -> PathBuf {
        config::secure_directory(&root(&env.executable).unwrap()).unwrap();
        let job = create_job(
            &env.executable,
            &env.state,
            &Options {
                version: Some(VERSION.into()),
                timeout_seconds: 30,
                ..Options::default()
            },
        )
        .unwrap();
        // Publish an already-verified synthetic candidate through the same resume
        // checkpoint as release preflight. Public selection still rejects equal versions.
        transaction::copy(&env.candidate, &job.join("candidate")).unwrap();
        write_new(
            &job.join("prepared.json"),
            &upgrade::Prepared {
                version: VERSION.into(),
                binary_hash: upgrade::hash(&env.candidate).unwrap(),
            },
        )
        .unwrap();
        job
    }
    async fn until(mut condition: impl FnMut() -> bool) {
        until_with_limit(LIMIT, &mut condition).await;
    }
    async fn until_with_limit(limit: Duration, mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(limit, async {
            while !condition() {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn at_phase(job: &Path, phase: &str) {
        // Snapshot preparation copies and hashes debug executables before the
        // injected fault is reached. Its readiness budget must accommodate slow
        // runners independently of the bounded fault/recovery assertions.
        until_with_limit(Duration::from_secs(120), || {
            read_json::<Value>(&job.join("progress.json")).is_ok_and(|v| v["phase"] == phase)
        })
        .await;
    }
    async fn validating(env: &Environment, job: &Path) {
        at_phase(job, "validating").await;
        until(|| env.home.join("upgrade-models-blocked").exists()).await;
    }
    fn release(env: &Environment) {
        fs::remove_file(env.home.join("upgrade-models-blocked")).unwrap();
    }
    async fn done(job: &Path) -> Outcome {
        until(|| completed(job).is_ok_and(|v| v.is_some())).await;
        let outcome = completed(job).unwrap().unwrap();
        until(|| {
            lock(&job.join("supervisor.lock")).unwrap().is_some()
                && lock(&job.join("worker.lock")).unwrap().is_some()
        })
        .await;
        // Allow the detached process to close its diagnostics and mapped image.
        sleep(Duration::from_millis(100)).await;
        outcome
    }
    fn pid(job: &Path, role: &str) -> Option<u32> {
        read_json::<Value>(&job.join(format!("{role}.json"))).ok()?["pid"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
    }
    async fn observed_pid(job: &Path, role: &str) -> u32 {
        let mut observed = None;
        until(|| {
            observed = pid(job, role);
            observed.is_some()
        })
        .await;
        observed.unwrap()
    }
    fn kill_fixture(pid: u32) {
        // Test-only fault injection: these PIDs were just created for this private
        // synthetic job. Production recovery never terminates recorded PIDs.
        #[cfg(unix)]
        assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess},
            };
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            assert!(!handle.is_null());
            assert_ne!(TerminateProcess(handle, 73), 0);
            CloseHandle(handle);
        }
    }
    async fn fence_and_kill(job: &Path) -> Lock {
        // Simulate losing both controllers while fencing their replacement loop.
        let mut killed = std::collections::HashSet::new();
        tokio::time::timeout(LIMIT, async {
            loop {
                if let Some(fence) = lock(&job.join("supervisor.lock")).unwrap() {
                    if lock(&job.join("worker.lock")).unwrap().is_none() {
                        kill_fixture(observed_pid(job, "worker").await);
                    }
                    until(|| lock(&job.join("worker.lock")).unwrap().is_some()).await;
                    return fence;
                }
                // A killed supervisor can leave no diagnostic record, or its prior
                // PID while a replacement acquires the role and publishes a new one.
                if let Some(pid) = pid(job, "supervisor")
                    && killed.insert(pid)
                {
                    kill_fixture(pid);
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    #[cfg(windows)]
    fn job_front(
        env: &Environment,
        breakaway: u32,
    ) -> (
        std::os::windows::io::OwnedHandle,
        std::os::windows::io::OwnedHandle,
    ) {
        use std::{
            os::windows::{
                ffi::OsStrExt,
                io::{FromRawHandle, RawHandle},
            },
            ptr,
        };
        use windows_sys::Win32::System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{
                CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, PROCESS_INFORMATION,
                ResumeThread, STARTUPINFOW,
            },
        };
        // Assign only the suspended synthetic foreground client, never this test
        // process. Closing this handle models an SSH host disposing of its job.
        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            assert!(!job.is_null());
            let job_handle = std::os::windows::io::OwnedHandle::from_raw_handle(job as RawHandle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | breakaway;
            assert_ne!(
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32
                ),
                0
            );
            let executable = env
                .executable
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let mut args = format!(
                "\"{}\" --state-dir \"{}\" upgrade",
                env.executable.display(),
                env.state.display()
            )
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of_val(&startup) as u32;
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            assert_ne!(
                CreateProcessW(
                    executable.as_ptr(),
                    args.as_mut_ptr(),
                    ptr::null(),
                    ptr::null(),
                    0,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW,
                    ptr::null(),
                    ptr::null(),
                    &startup,
                    &mut process
                ),
                0
            );
            let front =
                std::os::windows::io::OwnedHandle::from_raw_handle(process.hProcess as RawHandle);
            let thread =
                std::os::windows::io::OwnedHandle::from_raw_handle(process.hThread as RawHandle);
            assert_ne!(AssignProcessToJobObject(job, process.hProcess), 0);
            assert_ne!(ResumeThread(process.hThread), u32::MAX);
            drop(thread);
            (job_handle, front)
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_host_job_close_survives_or_refuses_before_maintenance() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
        };
        for mode in [
            JOB_OBJECT_LIMIT_BREAKAWAY_OK,
            JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
            0,
        ] {
            let allowed = mode != 0;
            let env = Environment::new();
            let old = env.start().await;
            let job = prepared(&env);
            fs::write(env.home.join("upgrade-block-models-once"), "synthetic").unwrap();
            let (host_job, front) = job_front(&env, mode);
            if allowed {
                validating(&env, &job).await;
            } else {
                until(|| {
                    let mut code = 259;
                    assert_ne!(
                        unsafe {
                            windows_sys::Win32::System::Threading::GetExitCodeProcess(
                                front.as_raw_handle(),
                                &mut code,
                            )
                        },
                        0
                    );
                    code != 259
                })
                .await;
                assert!(!job.join("intent.json").exists());
                let current = crate::status(&env.state, &env.config).await.unwrap();
                assert_eq!(current["instanceId"], old["instanceId"]);
                assert_eq!(current["maintenance"], false);
            }
            drop(host_job);
            drop(front);
            if !allowed {
                spawn(&job, None).unwrap();
                validating(&env, &job).await;
            }
            release(&env);
            let outcome = done(&job).await;
            assert_eq!(outcome.status, "succeeded", "{}", outcome.message);
        }
    }

    #[tokio::test]
    async fn uninitialized_completion_checkpoint_decides_restore_or_commit() {
        for committed in [false, true] {
            let env = Environment::new();
            fs::remove_file(env.state.join("config.json")).unwrap();
            if !committed {
                // A distinct fixture image exercises actual executable restoration,
                // without constructing or publishing another product version.
                fs::copy(&env.config.codex_executable, &env.candidate).unwrap();
            }
            let job = prepared(&env);
            record_intent(Some(&job), &dewbow_protocol::id(), false, None)
                .await
                .unwrap();
            if committed {
                write_new(
                    &job.join("binaryCommitted.json"),
                    &json!({"contractVersion":"v1"}),
                )
                .unwrap();
            } else {
                replacement::commit(&env.executable, &job.join("candidate")).unwrap();
            }
            let directory = attempt_dir(&job, 0);
            config::secure_directory(&directory).unwrap();
            write_new(
                &directory.join("request.json"),
                &Attempt {
                    index: 0,
                    recover: false,
                },
            )
            .unwrap();
            write_new(&directory.join("started.json"), &json!({"pid":1})).unwrap();
            if !committed {
                assert!(
                    recover_before_start(&env.executable, &env.state)
                        .await
                        .unwrap()
                );
            } else {
                submit(
                    &env.executable,
                    &env.state,
                    &Options {
                        detach: true,
                        ..Options::default()
                    },
                )
                .await
                .unwrap();
            }
            let outcome = done(&job).await;
            assert_eq!(
                outcome.status,
                if committed { "succeeded" } else { "recovered" },
                "{}",
                outcome.message
            );
            assert!(!env.state.join("config.json").exists());
            assert_eq!(
                upgrade::hash(&env.executable).unwrap(),
                request(&job).unwrap().runner_hash
            );
        }
    }

    #[tokio::test]
    async fn terminal_disconnect_and_supervisor_exit_do_not_cancel_upgrade() {
        for replace_supervisor in [false, true] {
            let env = Environment::new();
            let old = env.start().await;
            let job = prepared(&env);
            fs::write(env.home.join("upgrade-block-models-once"), "synthetic").unwrap();
            let mut command = Command::new(&env.executable);
            config::hidden(&mut command);
            command
                .arg("--state-dir")
                .arg(&env.state)
                .arg("upgrade")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                unsafe {
                    command.pre_exec(|| {
                        if libc::setsid() < 0 {
                            Err(std::io::Error::last_os_error())
                        } else {
                            Ok(())
                        }
                    });
                }
            }
            let front = command.spawn().unwrap();
            validating(&env, &job).await;
            let original_supervisor = observed_pid(&job, "supervisor").await;
            #[cfg(unix)]
            assert_eq!(unsafe { libc::kill(-(front.id() as i32), libc::SIGHUP) }, 0);
            #[cfg(windows)]
            let front = {
                let mut front = front;
                front.kill().unwrap();
                front
            };
            let output = tokio::time::timeout(
                LIMIT,
                tokio::task::spawn_blocking(move || front.wait_with_output().unwrap()),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(!output.status.success());
            if replace_supervisor {
                kill_fixture(original_supervisor);
                until(|| pid(&job, "supervisor").is_some_and(|pid| pid != original_supervisor))
                    .await;
            }
            release(&env);
            let outcome = done(&job).await;
            assert_eq!(outcome.status, "succeeded", "{}", outcome.message);
            let current = crate::status(&env.state, &env.config).await.unwrap();
            assert_eq!(current["maintenance"], false);
            assert_ne!(current["instanceId"], old["instanceId"]);
        }
    }

    #[tokio::test]
    async fn killed_worker_recovers_both_sides_of_the_transaction_publication() {
        for (phase, fault) in [
            ("stopping", "upgrade-hang-exit-once"),
            ("validating", "upgrade-block-models-once"),
        ] {
            let env = Environment::new();
            env.start().await;
            let job = prepared(&env);
            fs::write(env.home.join(fault), "synthetic").unwrap();
            let _supervisor = spawn(&job, None).unwrap();
            at_phase(&job, phase).await;
            if phase == "stopping" {
                until(|| !env.home.join(fault).exists()).await;
                assert!(maintenance::transaction(&env.state).unwrap().is_none());
            } else {
                validating(&env, &job).await;
            }
            kill_fixture(observed_pid(&job, "worker").await);
            if phase == "validating" {
                release(&env);
            }
            let outcome = done(&job).await;
            assert_eq!(outcome.status, "recovered", "{}", outcome.message);
            let current = crate::status(&env.state, &env.config).await.unwrap();
            assert_eq!(current["status"], "ready");
            assert_eq!(current["maintenance"], false);
            assert_eq!(current["version"], VERSION);
        }
    }

    #[tokio::test]
    async fn next_start_resumes_a_job_after_both_controllers_exit() {
        let env = Environment::new();
        env.start().await;
        let job = prepared(&env);
        fs::write(env.home.join("upgrade-block-models-once"), "synthetic").unwrap();
        let _supervisor = spawn(&job, None).unwrap();
        validating(&env, &job).await;
        let fence = fence_and_kill(&job).await;
        release(&env);
        assert!(completed(&job).unwrap().is_none());
        let supervisor_record = fs::read(job.join("supervisor.json")).ok();
        submit(
            &env.executable,
            &env.state,
            &Options {
                status: true,
                ..Options::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(job.join("supervisor.json")).ok(),
            supervisor_record
        );
        assert!(lock(&job.join("worker.lock")).unwrap().is_some());
        drop(fence);
        let executable = env.executable.clone();
        let state = env.state.clone();
        let output = tokio::task::spawn_blocking(move || {
            let mut command = Command::new(executable);
            config::hidden(&mut command);
            command
                .arg("--state-dir")
                .arg(state)
                .args(["daemon", "start"])
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["status"], "ready");
        assert_eq!(value["maintenance"], false);
        assert_eq!(done(&job).await.status, "recovered");
    }

    #[tokio::test]
    async fn lost_completion_after_commit_keeps_new_request_receipts() {
        let env = Environment::new();
        env.start().await;
        let job = prepared(&env);
        transaction::apply(
            &env.executable,
            &job.join("candidate"),
            &env.state,
            VERSION,
            Duration::ZERO,
            LIMIT,
            Some(&job),
        )
        .await
        .unwrap();
        let cookie = env.operator().await;
        let input =
            json!({"hostId":env.config.host_id,"workDir":env.root,"requestId":"after-commit"});
        let created = env.api(&cookie, "createSession", input.clone()).await;
        let directory = attempt_dir(&job, 0);
        config::secure_directory(&directory).unwrap();
        write_new(
            &directory.join("request.json"),
            &Attempt {
                index: 0,
                recover: false,
            },
        )
        .unwrap();
        write_new(&directory.join("started.json"), &json!({"pid":1})).unwrap();
        let _supervisor = spawn(&job, None).unwrap();
        assert_eq!(done(&job).await.status, "succeeded");
        assert!(!maintenance::rollback_started(&env.state).unwrap());
        let late = attempt_dir(&job, 2);
        config::secure_directory(&late).unwrap();
        write_new(
            &late.join("request.json"),
            &Attempt {
                index: 2,
                recover: false,
            },
        )
        .unwrap();
        let mut delayed = spawn(&job, Some(2)).unwrap();
        until(|| delayed.exited().unwrap()).await;
        assert!(
            !late.join("started.json").exists(),
            "A terminal job cannot start a delayed worker"
        );
        assert!(
            submit(
                &env.executable,
                &env.state,
                &Options {
                    recover: true,
                    ..Options::default()
                }
            )
            .await
            .is_err()
        );
        assert_eq!(completed(&job).unwrap().unwrap().status, "succeeded");
        assert_eq!(
            env.api(&cookie, "createSession", input).await["commandId"],
            created["commandId"]
        );
    }

    #[tokio::test]
    async fn blocked_recovery_is_bounded_and_can_be_retried_after_backup_repair() {
        let env = Environment::new();
        env.start().await;
        let job = prepared(&env);
        fs::write(env.home.join("upgrade-block-models-once"), "synthetic").unwrap();
        let _supervisor = spawn(&job, None).unwrap();
        validating(&env, &job).await;
        let fence = fence_and_kill(&job).await;
        release(&env);
        let record = maintenance::transaction(&env.state).unwrap().unwrap();
        let saved = fs::read(&record.previous).unwrap();
        fs::write(&record.previous, "synthetic corrupt backup").unwrap();
        drop(fence);
        let _retry = spawn(&job, None).unwrap();
        assert_eq!(done(&job).await.status, "recoveryRequired");
        assert!(!maintenance::committed(&env.state).unwrap());
        fs::write(&record.previous, saved).unwrap();
        submit(
            &env.executable,
            &env.state,
            &Options {
                recover: true,
                ..Options::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(done(&job).await.status, "recovered");
        assert_eq!(
            crate::status(&env.state, &env.config).await.unwrap()["maintenance"],
            false
        );
    }
}
