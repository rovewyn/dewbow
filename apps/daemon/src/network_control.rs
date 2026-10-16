//! Shared lifecycle service. Callers establish local CLI or operator authority.
use crate::{
    network::{lifecycle, peer::PeerRuntime},
    service::Service,
};
use serde_json::Value;
use std::sync::atomic::Ordering;

impl Service {
    pub(crate) async fn network_control(
        self: &std::sync::Arc<Self>,
        name: &str,
        input: &Value,
    ) -> anyhow::Result<Value> {
        self.network_lifecycle(name, input, None).await
    }

    pub(crate) async fn network_lifecycle(
        self: &std::sync::Arc<Self>,
        name: &str,
        input: &Value,
        network: Option<&str>,
    ) -> anyhow::Result<Value> {
        anyhow::ensure!(
            !self.stopped.load(Ordering::Acquire),
            "UNAVAILABLE: daemon stopping"
        );
        let _admission = if matches!(
            name,
            "getNetwork" | "listNetworkMembers" | "listNetworkJoins" | "getNetworkJoin"
        ) {
            None
        } else {
            Some(
                self.maintenance
                    .admit_cleanup()
                    .ok_or_else(|| anyhow::anyhow!("UNAVAILABLE: maintenance active"))?,
            )
        };
        let mut peer = self.peer.lock().await;
        let repo = &self.store.network;
        // Local selection changes share the Peer runtime gate. Reconciliation can
        // change history inside this gate, but cannot select a different Network.
        if let Some(network) = network {
            let network = dewbow_protocol::network::NetworkId::parse(network)
                .map_err(|_| dewbow_protocol::error("INVALID_INPUT", "Invalid Network."))?;
            anyhow::ensure!(
                repo.current_selection()?
                    .is_some_and(|s| s.history().network_id() == network),
                dewbow_protocol::error("FORBIDDEN", "The selected Network changed.")
            );
        }
        if matches!(name, "createNetwork" | "joinNetwork") {
            // Detect changed retries before applying even configuration-only effects.
            repo.request_result(&lifecycle::intent(name, input)?)?;
            lifecycle::validate_setup(name, input)?;
            let settings = repo.lifecycle_settings(input)?;
            let old = repo.peer_settings()?;
            if serde_json::to_value(&settings)? != serde_json::to_value(old)? || peer.is_none() {
                if let Some(previous) = peer.take() {
                    previous.shutdown().await;
                }
                repo.configure_peer(&settings)?;
                *peer = PeerRuntime::start_in_service(
                    repo.clone(),
                    self.maintenance.clone(),
                    self.weak.clone(),
                )
                .await?;
            }
        }
        let mut result = if name == "getNetworkJoin" {
            repo.join_details(input)?
        } else if name == "joinNetwork" {
            repo.start_network_join(input)?
        } else {
            repo.local_network_operation(name, input)?
        };
        if name == "getNetwork" {
            result["peerSettings"] = serde_json::to_value(repo.peer_settings()?)?;
            result["peerListenerStatus"] = serde_json::json!(if peer.is_some() {
                "listening"
            } else {
                "stopped"
            });
        }
        if name == "setNetworkPeerAddress"
            && let Some(selected) = repo.current_selection()?
            && let Some(runtime) = peer.as_ref()
        {
            runtime.reconnect(
                selected.history().network_id(),
                dewbow_protocol::network::MembershipId::parse(
                    input["membershipId"].as_str().unwrap_or(""),
                )?,
            )?;
        }
        Ok(result)
    }
}
