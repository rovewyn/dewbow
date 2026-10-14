//! Opt-in, real native smoke runner. Supply an executable, native home and synthetic work directory.
use dewbow_sdk::Runtime;
use serde_json::json;
use std::{path::PathBuf, time::Duration};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    anyhow::ensure!(
        args.len() == 3,
        "Pass the standalone executable, native home and an existing synthetic work directory"
    );
    let (runtime, mut events) = Runtime::spawn(&args[0], &args[1]).await?;
    let result=async {
        runtime.initialize().await?;
        let created=runtime.request("thread/start",json!({"cwd":args[2],"sandbox":"workspace-write","approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":false})).await?;
        let thread=created["thread"]["id"].clone();
        runtime.request("turn/start",json!({"threadId":thread,"input":[{"type":"text","text":"Reply exactly DEWBOW_ADOPT_MARKER. Do not use tools or read or change files.","text_elements":[]}]})).await?;
        tokio::time::timeout(Duration::from_secs(90), async {
            while let Some(message) = events.recv().await {
                if message["method"] == "turn/completed" && message["params"]["threadId"] == thread {
                    anyhow::ensure!(message["params"]["turn"]["status"] == "completed", "Native smoke turn did not complete");
                    return Ok::<_, anyhow::Error>(());
                }
                if message.get("id").is_some() {
                    runtime.reject(message["id"].clone()).await?;
                }
            }
            anyhow::bail!("Native runtime exited")
        }).await??;
        println!("{}",json!({"nativeThreadId":thread,"status":"completed"}));Ok::<_,anyhow::Error>(())
    }.await;
    runtime.stop().await?;
    result
}
