//! Operator entry adapters. Targets remain explicit and connections are direct.
use crate::{
    network::peer::{RemoteStream, connect_target},
    service::{Service, validate},
};
use dewbow_protocol::{
    error,
    network::{
        HostId, NetworkId,
        peer::{PeerError, ReadName, ReadOperation},
    },
};
use serde_json::Value;
use std::time::Duration;
use tokio::time::Instant;

fn failure(error: PeerError) -> anyhow::Error {
    dewbow_protocol::ManagementError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
    }
    .into()
}
fn target(input: &mut Value) -> anyhow::Result<(NetworkId, HostId)> {
    let fields = input
        .as_object_mut()
        .ok_or_else(|| error("INVALID_INPUT", "Invalid target."))?;
    let network = fields
        .remove("networkId")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| error("INVALID_INPUT", "Missing Network."))?;
    let host = fields
        .remove("hostId")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| error("INVALID_INPUT", "Missing host."))?;
    Ok((
        NetworkId::parse(&network).map_err(|_| error("INVALID_INPUT", "Invalid Network."))?,
        HostId::parse(&host).map_err(|_| error("INVALID_INPUT", "Invalid host."))?,
    ))
}
pub(crate) async fn read(service: &Service, name: &str, mut input: Value) -> anyhow::Result<Value> {
    let (network, host) = target(&mut input)?;
    let operation: ReadName = serde_json::from_value(Value::String(name.into()))?;
    validate(name, &input)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (mut client, context) = connect_target(service, network, host, deadline)
            .await
            .map_err(failure)?;
        match client
            .read_operation(&ReadOperation {
                context,
                operation,
                input: input.clone(),
            })
            .await
        {
            Err(cause) if cause.code == "SYNC_REQUIRED" && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            Err(cause) if cause.code == "SYNC_REQUIRED" => {
                return Err(failure(PeerError::new("NOT_READY")));
            }
            result => return result.map_err(failure),
        }
    }
}
pub(crate) async fn subscribe(service: &Service, mut input: Value) -> anyhow::Result<RemoteStream> {
    let (network, host) = target(&mut input)?;
    validate("getSession", &input)?;
    let session = input["sessionId"].as_str().unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (client, context) = connect_target(service, network, host, deadline)
            .await
            .map_err(failure)?;
        match client.subscribe(context, session.clone()).await {
            Err(cause) if cause.code == "SYNC_REQUIRED" && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            Err(cause) if cause.code == "SYNC_REQUIRED" => {
                return Err(failure(PeerError::new("NOT_READY")));
            }
            result => return result.map_err(failure),
        }
    }
}
