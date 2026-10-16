use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::io::{self, BufRead, IsTerminal, Read, Write};

#[derive(Args)]
pub struct Options {
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}
#[derive(Args)]
struct Request {
    #[arg(long, allow_hyphen_values = true)]
    request_id: Option<String>,
}
#[derive(Args)]
struct Endpoints {
    #[arg(long)]
    listen_endpoint: Option<String>,
    #[arg(long)]
    advertised_endpoint: Vec<String>,
}
#[derive(Subcommand)]
enum Command {
    Create {
        name: String,
        #[command(flatten)]
        request: Request,
        #[command(flatten)]
        endpoints: Endpoints,
    },
    Invite {
        #[command(flatten)]
        request: Request,
    },
    Join {
        #[arg(long)]
        invitation_stdin: bool,
        #[command(flatten)]
        request: Request,
        #[command(flatten)]
        endpoints: Endpoints,
    },
    Pending,
    Confirm {
        #[arg(allow_hyphen_values = true)]
        attempt_id: String,
        #[arg(long, allow_hyphen_values = true)]
        public_key: String,
        #[command(flatten)]
        request: Request,
    },
    Deny {
        #[arg(allow_hyphen_values = true)]
        attempt_id: String,
        #[command(flatten)]
        request: Request,
    },
    Status,
    Members,
    Remove {
        #[arg(allow_hyphen_values = true)]
        membership_id: String,
        #[command(flatten)]
        request: Request,
    },
    Leave {
        #[command(flatten)]
        request: Request,
    },
    SetPeerAddress {
        #[arg(allow_hyphen_values = true)]
        membership_id: String,
        endpoint: String,
        #[command(flatten)]
        request: Request,
    },
}
fn request(input: &mut Value, options: Request) {
    let id = options.request_id.unwrap_or_else(dewbow_protocol::id);
    eprintln!("requestId: {id}");
    input["requestId"] = json!(id);
}
fn endpoints(input: &mut Value, options: Endpoints) {
    input["listenEndpoint"] = json!(options.listen_endpoint);
    input["advertisedEndpoints"] = json!(options.advertised_endpoint);
}
fn invitation(stdin: bool) -> anyhow::Result<String> {
    anyhow::ensure!(
        stdin || io::stdin().is_terminal(),
        "Use --invitation-stdin for piped invitations"
    );
    if !stdin {
        eprint!("Invitation: ");
        io::stderr().flush()?;
    }
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(32770)
        .read_until(b'\n', &mut bytes)?;
    anyhow::ensure!(bytes.len() <= 32769, "Invitation too large");
    Ok(String::from_utf8(bytes)?.trim().to_string())
}
pub async fn run(config: &dewbow_daemon::config::Config, options: Options) -> anyhow::Result<()> {
    let mut input = json!({});
    let operation = match options.command {
        Command::Create {
            name,
            request: r,
            endpoints: e,
        } => {
            input["networkName"] = json!(name);
            request(&mut input, r);
            endpoints(&mut input, e);
            "createNetwork"
        }
        Command::Invite { request: r } => {
            request(&mut input, r);
            "createInvitation"
        }
        Command::Join {
            invitation_stdin,
            request: r,
            endpoints: e,
        } => {
            input["invitation"] = json!(invitation(invitation_stdin)?);
            request(&mut input, r);
            endpoints(&mut input, e);
            "joinNetwork"
        }
        Command::Pending => "listNetworkJoins",
        Command::Confirm {
            attempt_id,
            public_key,
            request: r,
        } => {
            input = json!({"joinAttemptId":attempt_id,"publicKey":public_key,"decision":"allow"});
            request(&mut input, r);
            "confirmNetworkJoin"
        }
        Command::Deny {
            attempt_id,
            request: r,
        } => {
            let details = super::control_input(
                config,
                "getNetworkJoin",
                &json!({"joinAttemptId":attempt_id}),
            )
            .await?;
            let key = details["publicKey"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Join attempt unavailable"))?;
            input = json!({"joinAttemptId":attempt_id,"publicKey":key,"decision":"deny"});
            request(&mut input, r);
            "confirmNetworkJoin"
        }
        Command::Status => "getNetwork",
        Command::Members => "listNetworkMembers",
        Command::Remove {
            membership_id,
            request: r,
        } => {
            input["membershipId"] = json!(membership_id);
            request(&mut input, r);
            "removeNetworkMember"
        }
        Command::Leave { request: r } => {
            request(&mut input, r);
            "leaveNetwork"
        }
        Command::SetPeerAddress {
            membership_id,
            endpoint,
            request: r,
        } => {
            input = json!({"membershipId":membership_id,"endpoint":endpoint});
            request(&mut input, r);
            "setNetworkPeerAddress"
        }
    };
    let result=super::control_timeout(config,operation,&input,std::time::Duration::from_secs(30)).await.map_err(|e|if e.downcast_ref::<reqwest::Error>().is_some_and(|error|error.is_connect()) {anyhow::anyhow!("{e}. Start the selected daemon with dewbow daemon start; retain the original request ID.")} else {anyhow::anyhow!("{e}. Retain the original request ID when recovering a lost response.")})?;
    if options.json {
        println!("{}", serde_json::to_string(&result)?);
    } else {
        println!("{}", serde_json::to_string_pretty(&result)?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    #[test]
    fn opaque_ids_and_keys_starting_with_hyphens_remain_values() {
        let id = "-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        for args in [
            vec![
                "network",
                "confirm",
                id,
                "--public-key",
                id,
                "--request-id",
                "-retry",
            ],
            vec!["network", "deny", id],
            vec!["network", "remove", id],
            vec!["network", "set-peer-address", id, "https://192.0.2.1:7443"],
        ] {
            assert!(
                super::super::Cli::try_parse_from(std::iter::once("dewbow").chain(args)).is_ok()
            );
        }
    }
}
