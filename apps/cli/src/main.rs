mod background;
mod replacement;
mod upgrade;
use clap::{Parser, Subcommand};
use dewbow_daemon::config::{self, Config};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command, time::Duration};

#[derive(Parser)]
#[command(
    name = "dewbow",
    version,
    about = "Manage local Codex conversations with Dewbow"
)]
struct Cli {
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    Init {
        #[arg(long)]
        codex_executable: Option<PathBuf>,
        #[arg(long)]
        codex_home: Option<PathBuf>,
        #[arg(long)]
        port: Option<u16>,
    },
    Doctor,
    Daemon {
        #[command(subcommand)]
        command: Daemon,
    },
    Web,
    /// Install a newer GitHub release in place (stop all Dewbow daemons first).
    Upgrade {
        /// Check for a release without changing the installation.
        #[arg(long)]
        check: bool,
        /// Select an exact release, including a release candidate.
        #[arg(long)]
        version: Option<String>,
    },
}
#[derive(Subcommand)]
enum Daemon {
    Run {
        #[arg(long, hide = true)]
        background: bool,
    },
    Start,
    Status,
    Stop,
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}
async fn control(config: &Config, name: &str) -> anyhow::Result<Value> {
    let response = client()
        .post(format!("http://127.0.0.1:{}/internal/{name}", config.port))
        .bearer_auth(&config.control_token)
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Local control authentication failed; verify the selected daemon instance"
    );
    let value: Value = response.json().await?;
    Ok(value["result"].clone())
}
async fn status(state: &std::path::Path, config: &Config) -> anyhow::Result<Value> {
    let path = state.join("instance.json");
    if !path.exists() {
        return Ok(json!({"status":"stopped"}));
    }
    dewbow_daemon::config::load(state)?;
    let record: Value = serde_json::from_slice(&fs::read(path)?)?;
    let value = control(config, "status").await?;
    anyhow::ensure!(
        value["instanceId"] == record["instanceId"] && value["pid"] == record["pid"],
        "Instance identity mismatch; recovery is required"
    );
    Ok(value)
}
async fn start(state: &std::path::Path, config: &Config) -> anyhow::Result<Value> {
    if state.join("instance.json").exists()
        && let Ok(current) = status(state, config).await
    {
        anyhow::ensure!(
            current["status"] == "ready",
            "The selected daemon is stopping"
        );
        return Ok(current);
    }
    // Recovery and the child both take the daemon lock; neither can clear a live owner.
    dewbow_daemon::lifecycle::DaemonLock::acquire(state)?.recover_instance()?;
    let mut child = background::Background::spawn(state)?;
    for _ in 0..240 {
        if child.exited()? {
            anyhow::bail!("Daemon failed to start; inspect the private daemon.log");
        }
        if let Ok(value) = status(state, config).await
            && value["status"] == "ready"
        {
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    anyhow::bail!("Daemon startup is unconfirmed; inspect the owned process before retrying")
}
fn open_browser(url: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let mut command = Command::new("rundll32.exe");
        config::hidden(&mut command);
        command
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(url).spawn()?;
    }
    Ok(())
}
#[tokio::main]
async fn main() {
    if let Err(cause) = execute().await {
        eprintln!("{cause}");
        std::process::exit(1);
    }
}
async fn execute() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if let Commands::Upgrade { check, version } = &cli.command {
        return upgrade::run(cli.state_dir.as_deref(), *check, version.as_deref()).await;
    }
    let state = std::path::absolute(cli.state_dir.unwrap_or(config::default_state()?))?;
    if let Commands::Init {
        codex_executable,
        codex_home,
        port,
    } = cli.command
    {
        config::init(&state, codex_executable, codex_home, port)?;
        println!("Initialized private Dewbow configuration.");
        return Ok(());
    }
    let config = config::load(&state)?;
    match cli.command {
        Commands::Doctor => {
            println!("{}", dewbow_daemon::doctor(&config).await?);
        }
        Commands::Daemon {
            command: Daemon::Run { background },
        } => {
            if let Err(cause) = dewbow_daemon::run(&state).await {
                if background {
                    use std::io::Write;
                    let mut log = fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(state.join("daemon.log"))?;
                    writeln!(log, "{cause}")?;
                }
                return Err(cause);
            }
        }
        Commands::Daemon {
            command: Daemon::Start,
        } => println!("{}", start(&state, &config).await?),
        Commands::Daemon {
            command: Daemon::Status,
        } => println!("{}", status(&state, &config).await?),
        Commands::Daemon {
            command: Daemon::Stop,
        } => {
            let current = match status(&state, &config).await {
                Ok(current) if current["status"] != "stopped" => current,
                _ => {
                    dewbow_daemon::lifecycle::DaemonLock::acquire(&state)?.recover_instance()?;
                    println!("Stopped.");
                    return Ok(());
                }
            };
            let response = control(&config, "stop").await?;
            anyhow::ensure!(
                response["instanceId"] == current["instanceId"],
                "Stop targeted a different instance"
            );
            for _ in 0..80 {
                if !state.join("instance.json").exists()
                    && tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, config.port))
                        .await
                        .is_err()
                    && !config::process_alive(current["pid"].as_u64().unwrap() as u32)?
                {
                    println!("Stopped; listener released.");
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            anyhow::bail!("Shutdown is unconfirmed; inspect the exact owned instance");
        }
        Commands::Web => {
            start(&state, &config).await?;
            let ticket = control(&config, "ticket").await?;
            let url = format!("http://127.0.0.1:{}", config.port);
            open_browser(&format!(
                "{url}/#login={}",
                ticket["ticket"].as_str().unwrap()
            ))?;
            println!("{url}");
        }
        Commands::Init { .. } | Commands::Upgrade { .. } => unreachable!(),
    }
    Ok(())
}
