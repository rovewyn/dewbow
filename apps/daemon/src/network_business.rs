//! Operator-to-peer routing and the narrow target-owned native business adapter.
use crate::{
    network::{
        ReceiptScope, RecoveryRefs,
        business::BusinessIdentity,
        peer::{PeerClient, PeerConnector},
    },
    service::{Service, public, validate},
};
use dewbow_protocol::{
    error,
    network::{peer::*, *},
    text,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::{Duration, Instant};

fn peer_error(cause: anyhow::Error) -> PeerError {
    cause
        .downcast_ref::<dewbow_protocol::ManagementError>()
        .map(|e| PeerError::new(&e.code))
        .unwrap_or_else(|| PeerError::new("UNAVAILABLE"))
}
fn input_error(_: impl std::fmt::Display) -> dewbow_protocol::ManagementError {
    error("INVALID_INPUT", "Invalid Network request.")
}
pub(crate) fn semantic_fingerprint(
    name: &str,
    input: &Value,
    target: HostId,
) -> anyhow::Result<[u8; 32]> {
    let mut semantic = input.clone();
    let object = semantic
        .as_object_mut()
        .ok_or_else(|| input_error("object"))?;
    object.remove("requestId");
    object.remove("hostId");
    if name == "sendMessage" {
        object.entry("mode").or_insert(json!("default"));
    }
    Ok(Sha256::digest(serde_jcs::to_vec(&json!([target, name, semantic]))?).into())
}
fn receipt_result(scope: &ReceiptScope, receipt: Option<Value>) -> anyhow::Result<Value> {
    let receipt = receipt
        .map(|mut value| {
            value["authority"] = json!("operator");
            serde_json::from_value::<OperationReceipt>(public(value))
        })
        .transpose()?;
    Ok(json!(RequestReceiptResult {
        receipt_scope: RemoteReceiptScope {
            network_id: scope.network_id,
            source_host_id: scope.source_host_id,
            request_id: scope.request_id.clone()
        },
        receipt,
        receipt_retention_seconds: 86400,
    }))
}
fn request_input(context: &BusinessContext, fields: Value) -> Value {
    let mut value = serde_json::to_value(context).expect("serializable context");
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    value
}

impl Service {
    pub(crate) fn all_operations(&self) -> anyhow::Result<Vec<Value>> {
        let mut operations = self.store.list("operation")?;
        operations.extend(
            self.store
                .network
                .business_receipts()?
                .into_iter()
                .map(|(_, v)| v),
        );
        Ok(operations)
    }
    pub(crate) fn save_operation(&self, operation: &Value) -> anyhow::Result<()> {
        if let Some(scope) = self
            .store
            .network
            .receipt_scope_for_command(text(operation, "commandId")?)?
        {
            let recovery = if matches!(operation["status"].as_str(), Some("accepted" | "unknown")) {
                let turn = operation["turnId"]
                    .as_str()
                    .map(|id| self.store.get("turn", id))
                    .transpose()?
                    .flatten();
                Some(RecoveryRefs {
                    session_id: text(operation, "sessionId")?.into(),
                    turn_id: operation["turnId"].as_str().map(str::to_owned),
                    codex_turn_id: turn.and_then(|t| t["codexTurnId"].as_str().map(str::to_owned)),
                })
            } else {
                None
            };
            let mut durable = operation.clone();
            durable.as_object_mut().unwrap().remove("authority");
            self.store
                .network
                .settle_receipt(&scope, &durable, recovery.as_ref())
        } else {
            self.store
                .put("operation", text(operation, "requestId")?, operation)
        }
    }
    pub(crate) async fn peer_business(
        &self,
        name: &str,
        input: Value,
        identity: BusinessIdentity,
    ) -> std::result::Result<Value, PeerError> {
        if name == "getRequestReceipt" {
            let request: GetRequestReceipt =
                serde_json::from_value(input).map_err(|_| PeerError::new("INVALID_INPUT"))?;
            check_request_id(&request.request_id).map_err(peer_error)?;
            let scope = ReceiptScope {
                network_id: request.network_id,
                source_host_id: request.receipt_source_host_id,
                request_id: request.request_id.clone(),
            };
            let receipt = self
                .store
                .network
                .read_business_receipt(&request.context(), identity, &scope)
                .map_err(peer_error)?;
            return receipt_result(&scope, receipt).map_err(peer_error);
        }
        let request: ExecuteOperation =
            serde_json::from_value(input).map_err(|_| PeerError::new("INVALID_INPUT"))?;
        check_request_id(&request.request_id).map_err(peer_error)?;
        let mut local = request.input.clone();
        let fields = local
            .as_object_mut()
            .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
        if fields.contains_key("requestId") || fields.contains_key("hostId") {
            return Err(PeerError::new("INVALID_INPUT"));
        }
        fields.insert("requestId".into(), json!(request.request_id));
        if matches!(request.operation, Mutation::CreateSession) {
            fields.insert("hostId".into(), json!(request.target_host_id));
        }
        validate(request.operation.name(), &local).map_err(peer_error)?;
        self.operation_scoped(
            request.operation.name(),
            local,
            Some((request.context(), identity)),
        )
        .await
        .map_err(peer_error)
    }

    async fn peer_connector(&self) -> anyhow::Result<PeerConnector> {
        self.peer
            .lock()
            .await
            .as_ref()
            .map(|p| p.connector())
            .ok_or_else(|| error("NOT_READY", "Peer listener is not running.").into())
    }
    async fn target_client(
        &self,
        connector: &PeerConnector,
        target: HostId,
        reconcile: bool,
    ) -> anyhow::Result<(PeerClient, BusinessContext)> {
        let repo = &self.store.network;
        let selected = repo
            .current_selection()?
            .ok_or_else(|| error("FORBIDDEN", "No active Network."))?;
        anyhow::ensure!(
            selected.status() == SelectionStatus::Active,
            error("FORBIDDEN", "Local membership is inactive.")
        );
        let member = selected
            .history()
            .active_members()
            .find(|m| m.host_id == target)
            .ok_or_else(|| error("FORBIDDEN", "Target is not an active member."))?;
        let contacts = repo.peer_contacts(selected.history().network_id())?;
        let mut last = PeerError::new("NOT_READY");
        for contact in contacts
            .into_iter()
            .filter(|c| c.membership_id == member.membership_id)
        {
            let connected = if reconcile {
                connector
                    .connect(
                        &contact.endpoint,
                        contact.membership_id,
                        contact.explicit_seed,
                    )
                    .await
            } else {
                connector
                    .query(
                        &contact.endpoint,
                        contact.membership_id,
                        contact.explicit_seed,
                    )
                    .await
            };
            match connected {
                Ok(mut peer) => {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    if reconcile {
                        peer.synchronize_for_business(repo, deadline).await?;
                    }
                    let current = repo
                        .current_selection()?
                        .ok_or_else(|| error("FORBIDDEN", "No active Network."))?;
                    let target_member = peer
                        .hello()
                        .membership_id
                        .ok_or_else(|| error("FORBIDDEN", "Missing peer identity."))?;
                    anyhow::ensure!(
                        current
                            .history()
                            .member(target_member)
                            .is_some_and(|m| m.host_id == target),
                        error("FORBIDDEN", "Target host changed.")
                    );
                    return Ok((
                        peer,
                        BusinessContext {
                            protocol_version: 1,
                            network_id: current.history().network_id(),
                            caller_membership_id: current.local_member(),
                            target_membership_id: target_member,
                            history_id: current.history().snapshot().history_id,
                            source_host_id: HostId::parse(&self.config.host_id)?,
                            target_host_id: target,
                        },
                    ));
                }
                Err(cause) => {
                    if matches!(cause.code.as_str(), "FORBIDDEN" | "HISTORY_CONFLICT") {
                        return Err(cause.into());
                    }
                    last = cause;
                }
            }
        }
        Err(last.into())
    }

    pub(crate) async fn remote_operation(&self, name: &str, input: Value) -> anyhow::Result<Value> {
        self.remote_operation_in(name, input, None).await
    }

    pub(crate) async fn remote_operation_in(
        &self,
        name: &str,
        input: Value,
        network: Option<NetworkId>,
    ) -> anyhow::Result<Value> {
        validate(name, &input)?;
        let _admission = self.maintenance.admit(name)?;
        let target = HostId::parse(text(&input, "hostId")?).map_err(input_error)?;
        let request = text(&input, "requestId")?.to_owned();
        check_request_id(&request)?;
        let repo = &self.store.network;
        let selected = repo
            .current_selection()?
            .ok_or_else(|| error("NOT_READY", "No Network selected."))?;
        anyhow::ensure!(
            network.is_none_or(|n| n == selected.history().network_id()),
            error("FORBIDDEN", "The original Network is no longer selected.")
        );
        anyhow::ensure!(
            target.to_string() != self.config.host_id,
            error("INVALID_INPUT", "Use local resources for this host.")
        );
        let scope = ReceiptScope {
            network_id: selected.history().network_id(),
            source_host_id: HostId::parse(&self.config.host_id)?,
            request_id: request.clone(),
        };
        let lock = self.outbound_lock(&scope);
        let _guard = lock.lock().await;
        let binding_guard = self.requests.lock().await;
        repo.bind_outbound(
            &scope,
            target,
            name,
            semantic_fingerprint(name, &input, target)?,
        )
        .map_err(|cause| {
            if cause.to_string().contains("REQUEST_CONFLICT") {
                anyhow::Error::from(error(
                    "REQUEST_CONFLICT",
                    "Original target or input changed.",
                ))
            } else {
                cause
            }
        })?;
        drop(binding_guard);
        let prior_dispatch = repo.outbound_uncertain(&scope)?;
        let connector = self.peer_connector().await?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut semantic = input;
        semantic.as_object_mut().unwrap().remove("hostId");
        semantic.as_object_mut().unwrap().remove("requestId");
        loop {
            let ready =
                tokio::time::timeout_at(deadline, self.target_client(&connector, target, true))
                    .await;
            let (mut peer, context) = match ready {
                Ok(Ok(value)) => value,
                Ok(Err(cause)) => return Err(routing_failure(cause, prior_dispatch)),
                Err(_) => {
                    return Err(error(
                        if prior_dispatch {
                            "DELIVERY_UNCERTAIN"
                        } else {
                            "NOT_READY"
                        },
                        "Original execution target is not ready.",
                    )
                    .into());
                }
            };
            anyhow::ensure!(
                context.network_id == scope.network_id,
                error(
                    "FORBIDDEN",
                    "Original request belongs to a different Network selection."
                )
            );
            if prior_dispatch {
                let receipt: RequestReceiptResult = peer
                    .request(
                        "getRequestReceipt",
                        &request_input(
                            &context,
                            json!({"receiptSourceHostId":scope.source_host_id,"requestId":request}),
                        ),
                    )
                    .await
                    .map_err(|cause| routing_failure(cause.into(), true))?;
                let value = receipt.receipt.ok_or_else(|| {
                    error(
                        "DELIVERY_UNCERTAIN",
                        "No authoritative receipt; preserve the original attempt.",
                    )
                })?;
                anyhow::ensure!(
                    receipt.receipt_scope.network_id == scope.network_id
                        && receipt.receipt_scope.source_host_id == scope.source_host_id
                        && receipt.receipt_scope.request_id == scope.request_id
                        && receipt.receipt_retention_seconds >= 86400,
                    error("DELIVERY_UNCERTAIN", "Receipt scope is invalid.")
                );
                anyhow::ensure!(
                    value.request_id == scope.request_id && value.operation.name() == name,
                    error("DELIVERY_UNCERTAIN", "Receipt identity is invalid.")
                );
                let value = json!(value);
                repo.settle_outbound(&scope, &value)?;
                return Ok(value);
            }
            repo.begin_dispatch(&scope)?;
            let result: std::result::Result<OperationReceipt, PeerError> = peer
                .request(
                    "executeOperation",
                    &request_input(
                        &context,
                        json!({"operation":name,"input":semantic,"requestId":request}),
                    ),
                )
                .await;
            match result {
                Ok(receipt) => {
                    anyhow::ensure!(
                        receipt.request_id == scope.request_id && receipt.operation.name() == name,
                        error("DELIVERY_UNCERTAIN", "Receipt identity is invalid.")
                    );
                    let receipt = json!(receipt);
                    repo.settle_outbound(&scope, &receipt)?;
                    return Ok(receipt);
                }
                Err(cause) if cause.code == "SYNC_REQUIRED" => {
                    repo.reset_unadmitted(&scope)?;
                    if Instant::now() >= deadline {
                        return Err(error(
                            "NOT_READY",
                            "Membership did not synchronize before admission.",
                        )
                        .into());
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(cause)
                    if matches!(
                        cause.code.as_str(),
                        "FORBIDDEN"
                            | "HISTORY_CONFLICT"
                            | "INVALID_INPUT"
                            | "NOT_READY"
                            | "PROTOCOL_UNSUPPORTED"
                    ) =>
                {
                    repo.reset_unadmitted(&scope)?;
                    return Err(cause.into());
                }
                Err(_) => {
                    return Err(error(
                        "DELIVERY_UNCERTAIN",
                        "Query the original target using the same request identity.",
                    )
                    .into());
                }
            }
        }
    }

    pub(crate) async fn operator_receipt(&self, input: Value) -> anyhow::Result<Value> {
        let object = input.as_object().ok_or_else(|| input_error("object"))?;
        anyhow::ensure!(
            object.len() == 4
                && object
                    .keys()
                    .all(|k| ["hostId", "requestId", "networkId", "sourceHostId"]
                        .contains(&k.as_str())),
            input_error("fields")
        );
        let target = HostId::parse(text(&input, "hostId")?).map_err(input_error)?;
        let network = NetworkId::parse(text(&input, "networkId")?).map_err(input_error)?;
        let source = HostId::parse(text(&input, "sourceHostId")?).map_err(input_error)?;
        let request = text(&input, "requestId")?;
        check_request_id(request)?;
        if target.to_string() == self.config.host_id {
            let selected = self
                .store
                .network
                .current_selection()?
                .ok_or_else(|| error("FORBIDDEN", "No active Network."))?;
            let member = selected.local_member();
            let key = selected
                .history()
                .member(member)
                .ok_or_else(|| error("FORBIDDEN", "Missing membership."))?
                .public_key;
            let context = BusinessContext {
                protocol_version: 1,
                network_id: network,
                caller_membership_id: member,
                target_membership_id: member,
                history_id: selected.history().snapshot().history_id,
                source_host_id: target,
                target_host_id: target,
            };
            let scope = ReceiptScope {
                network_id: network,
                source_host_id: source,
                request_id: request.into(),
            };
            let receipt = self.store.network.read_business_receipt(
                &context,
                BusinessIdentity {
                    caller: member,
                    target: member,
                    caller_key: key,
                    target_key: key,
                },
                &scope,
            )?;
            return receipt_result(&scope, receipt);
        }
        let connector = self.peer_connector().await?;
        let (mut peer, context) = tokio::time::timeout(
            Duration::from_secs(10),
            self.target_client(&connector, target, false),
        )
        .await
        .map_err(|_| error("NOT_READY", "Execution target is unavailable."))??;
        anyhow::ensure!(
            context.network_id == network,
            error("FORBIDDEN", "Receipt belongs to another Network.")
        );
        let result: RequestReceiptResult = peer
            .request(
                "getRequestReceipt",
                &request_input(
                    &context,
                    json!({"receiptSourceHostId":source,"requestId":request}),
                ),
            )
            .await?;
        anyhow::ensure!(
            result.receipt_scope.network_id == network
                && result.receipt_scope.source_host_id == source
                && result.receipt_scope.request_id == request
                && result.receipt_retention_seconds >= 86400,
            input_error("receipt scope")
        );
        Ok(json!(result))
    }
}
fn routing_failure(cause: anyhow::Error, dispatched: bool) -> anyhow::Error {
    if let Some(detail) = cause.downcast_ref::<dewbow_protocol::ManagementError>()
        && matches!(detail.code.as_str(), "FORBIDDEN" | "HISTORY_CONFLICT")
    {
        return detail.clone().into();
    }
    if let Some(peer) = cause.downcast_ref::<PeerError>()
        && matches!(peer.code.as_str(), "FORBIDDEN" | "HISTORY_CONFLICT")
    {
        return error(&peer.code, "Current Network authority denies access.").into();
    }
    error(
        if dispatched {
            "DELIVERY_UNCERTAIN"
        } else {
            "NOT_READY"
        },
        "Original execution target is unavailable.",
    )
    .into()
}
fn check_request_id(request: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !request.trim().is_empty() && request.len() <= 200,
        input_error("requestId")
    );
    Ok(())
}
