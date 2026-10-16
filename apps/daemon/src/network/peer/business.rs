//! Direct read adapters. Native content and transfer state remain volatile.
use super::{
    PeerClient, Result, framing,
    session::{Session, Shared},
    unavailable,
};
use crate::{
    network::{Repository, repository::current},
    service::Service,
};
use axum::{
    body::Body,
    http::{Request, Response},
};
use dewbow_protocol::network::{peer::*, *};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::OwnedSemaphorePermit, time::Instant};

fn native_error(error: anyhow::Error) -> PeerError {
    if let Some(error) = error.downcast_ref::<dewbow_protocol::ManagementError>() {
        PeerError {
            code: error.code.clone(),
            message: error.message.clone(),
            retryable: error.retryable,
        }
    } else {
        PeerError::new("UNAVAILABLE")
    }
}

// This lock is the same serialization boundary used by every membership commit.
// It is released before reading native state or waiting on the network.
fn check(
    repo: &Repository,
    context: &BusinessContext,
    caller: PublicKey,
    target: PublicKey,
) -> Result<()> {
    let db = repo.db.lock().unwrap();
    let selected = current(&db, repo.limits)
        .map_err(unavailable)?
        .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
    let history = selected.history();
    if context.protocol_version != 1 {
        return Err(PeerError::new("PROTOCOL_UNSUPPORTED"));
    }
    if selected.status() != SelectionStatus::Active
        || history.network_id() != context.network_id
        || !history.is_active(context.caller_membership_id)
        || !history.is_active(context.target_membership_id)
        || history
            .member(context.caller_membership_id)
            .is_none_or(|m| m.host_id != context.source_host_id || m.public_key != caller)
        || history
            .member(context.target_membership_id)
            .is_none_or(|m| m.host_id != context.target_host_id || m.public_key != target)
    {
        return Err(PeerError::new("FORBIDDEN"));
    }
    if history.snapshot().history_id != context.history_id {
        return Err(PeerError::new("SYNC_REQUIRED"));
    }
    Ok(())
}
impl Session {
    fn business(&self, context: &BusinessContext) -> Result<()> {
        let _admission = self.shared.admission()?;
        let selected = self.authorize()?;
        if context.target_membership_id != selected.local_member() {
            return Err(PeerError::new("FORBIDDEN"));
        }
        check(&self.repo, context, self.peer_key, self.local_key)
    }
}
fn authorized(session: &Mutex<Session>, context: &BusinessContext) -> Result<()> {
    session.lock().unwrap().business(context)
}
fn response(body: Body, content_type: &str) -> Response<Body> {
    Response::builder()
        .status(200)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(body)
        .unwrap()
}
fn reserve(shared: &Shared, bytes: usize) -> Result<OwnedSemaphorePermit> {
    let amount = u32::try_from(bytes).map_err(|_| PeerError::new("RESOURCE_LIMIT"))?;
    shared
        .memory
        .clone()
        .try_acquire_many_owned(amount)
        .map_err(|_| PeerError::new("RESOURCE_LIMIT"))
}
fn receive_budget(shared: &Shared) -> Result<(usize, OwnedSemaphorePermit)> {
    // Leave working capacity for the connection's server half and other readers.
    let budget = (shared.memory.available_permits() / 2).min(framing::DEFAULT_TRANSFER_BYTES);
    if budget < MAX_FRAME_BYTES {
        return Err(PeerError::new("RESOURCE_LIMIT"));
    }
    Ok((budget, reserve(shared, budget)?))
}

pub(super) async fn handle(
    session: Arc<Mutex<Session>>,
    shared: Arc<Shared>,
    operation: &str,
    input: Value,
) -> Result<Response<Body>> {
    if operation == "readOperation" {
        let request: ReadOperation =
            serde_json::from_value(input).map_err(|_| PeerError::new("INVALID_INPUT"))?;
        authorized(&session, &request.context)?;
        let service = shared
            .service
            .upgrade()
            .ok_or_else(|| PeerError::new("NOT_READY"))?;
        let fields = request
            .input
            .as_object()
            .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
        if fields.contains_key("hostId") || fields.contains_key("requestId") {
            return Err(PeerError::new("INVALID_INPUT"));
        }
        let value = service
            .api(request.operation.as_str(), request.input)
            .await
            .map_err(native_error)?;
        authorized(&session, &request.context)?;
        let value = json!({"result":value});
        let bytes = framing::bounded_json(&value, framing::DEFAULT_TRANSFER_BYTES)?;
        let permit = reserve(&shared, bytes.len())?;
        if bytes.len() <= MAX_FRAME_BYTES {
            let stream = futures::stream::once(async move {
                let _permit = permit;
                authorized(&session, &request.context)?;
                Ok::<_, PeerError>(Bytes::from(bytes))
            });
            return Ok(response(Body::from_stream(stream), "application/json"));
        }
        let transfer = framing::Transfer::from_bytes(bytes, "result");
        let stream = futures::stream::unfold(
            (transfer, session, request.context, permit),
            |(mut transfer, session, context, permit)| async move {
                let frame = transfer.next()?;
                let result = authorized(&session, &context)
                    .and_then(|_| framing::encode_line(&frame, false))
                    .map(Bytes::from);
                Some((result, (transfer, session, context, permit)))
            },
        );
        return Ok(response(Body::from_stream(stream), "application/x-ndjson"));
    }
    let request: SubscribeSessionUpdates =
        serde_json::from_value(input).map_err(|_| PeerError::new("INVALID_INPUT"))?;
    authorized(&session, &request.context)?;
    let service = shared
        .service
        .upgrade()
        .ok_or_else(|| PeerError::new("NOT_READY"))?;
    crate::service::validate("getSession", &json!({"sessionId":request.session_id}))
        .map_err(native_error)?;
    service
        .summary(&request.session_id)
        .await
        .map_err(native_error)?;
    let mut changed = service.changed.subscribe();
    let stream = futures::stream::unfold(
        (
            service,
            session,
            shared,
            request,
            dewbow_protocol::id(),
            0u64,
            0u64,
            None::<String>,
            None::<framing::Transfer>,
            None::<OwnedSemaphorePermit>,
            false,
        ),
        move |(
            service,
            session,
            shared,
            request,
            subscription,
            mut event_id,
            mut cursor,
            mut native,
            mut transfer,
            mut permit,
            failed,
        )| {
            // A broadcast receiver is not Clone. Each iteration observes native persistence
            // at the existing one-second cadence; notifications only reduce latency.
            let receiver = std::mem::replace(&mut changed, service.changed.subscribe());
            async move {
                if failed {
                    return None;
                }
                let result = async {
                    authorized(&session, &request.context)?;
                    if transfer.is_none() {
                        if event_id > 0 {
                            let mut receiver = receiver;
                            tokio::select! { _ = receiver.recv()=>{}, _ = tokio::time::sleep(Duration::from_secs(1))=>{} }
                        }
                        authorized(&session, &request.context)?;
                        let payload = service.updates(&request.session_id, cursor, native.as_deref()).await.map_err(native_error)?;
                        authorized(&session, &request.context)?;
                        cursor = payload["history"]["nextCursor"].as_u64().unwrap_or(cursor);
                        native = payload["history"]["updateCursor"].as_str().map(str::to_owned).or_else(|| native.clone());
                        if event_id >= 9_007_199_254_740_991 { return Err(PeerError::new("RESOURCE_LIMIT")); }
                        event_id += 1;
                        let value = RemoteSessionUpdates {
                            subscription_id: subscription.clone(), event_id, network_id: request.context.network_id,
                            host_id: request.context.target_host_id, membership_id: request.context.target_membership_id,
                            runtime_id: service.instance.clone(), history_id: request.context.history_id, payload,
                        };
                        let bytes = framing::bounded_json(&value, framing::DEFAULT_TRANSFER_BYTES)?;
                        permit = Some(reserve(&shared, bytes.len())?);
                        transfer = Some(framing::Transfer::from_bytes(bytes, if event_id == 1 {"snapshot"} else {"update"}));
                    }
                    let frame = transfer.as_mut().unwrap().next().unwrap();
                    let bytes = framing::encode_line(&frame, true)?;
                    if matches!(frame, framing::Frame::End {..}) { transfer = None; permit = None; }
                    Ok::<_, PeerError>(Bytes::from(bytes))
                }.await;
                let failed = result.is_err();
                let bytes = result.unwrap_or_else(|error| {
                    Bytes::from(format!(
                        "event: streamError\ndata: {}\n\n",
                        serde_json::to_string(&error).unwrap()
                    ))
                });
                Some((
                    Ok::<_, std::convert::Infallible>(bytes),
                    (
                        service,
                        session,
                        shared,
                        request,
                        subscription,
                        event_id,
                        cursor,
                        native,
                        transfer,
                        permit,
                        failed,
                    ),
                ))
            }
        },
    );
    Ok(response(Body::from_stream(stream), "text/event-stream"))
}

impl PeerClient {
    fn check_context(&self, context: &BusinessContext) -> Result<()> {
        let _admission = self.shared.admission()?;
        let selected = self
            .repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
        if selected.local_member() != context.caller_membership_id
            || self.hello.membership_id != Some(context.target_membership_id)
            || self
                .shared
                .conflicts
                .lock()
                .unwrap()
                .contains(&(context.network_id, context.target_membership_id))
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        let caller = selected
            .history()
            .member(selected.local_member())
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?
            .public_key;
        check(&self.repo, context, caller, self.remote_key)
    }
    async fn business_request(
        &mut self,
        operation: &str,
        context: &BusinessContext,
        input: &impl serde::Serialize,
    ) -> Result<Response<Incoming>> {
        self.check_context(context)?;
        let bytes = framing::bounded_json(input, MAX_FRAME_BYTES)?;
        let request = Request::builder()
            .method("POST")
            .uri(format!("/network/v1/{operation}"))
            .header("host", &self.authority)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(bytes)))
            .map_err(unavailable)?;
        let response =
            tokio::time::timeout(Duration::from_secs(60), self.sender.send_request(request))
                .await
                .map_err(unavailable)?
                .map_err(unavailable)?;
        if !response.status().is_success() {
            let bytes = tokio::time::timeout(
                Duration::from_secs(60),
                Limited::new(response.into_body(), MAX_FRAME_BYTES).collect(),
            )
            .await
            .map_err(unavailable)?
            .map_err(unavailable)?
            .to_bytes();
            let value: Value = decode(&bytes)?;
            return Err(serde_json::from_value(value["error"].clone())
                .map_err(|_| PeerError::new("INVALID_INPUT"))?);
        }
        Ok(response)
    }
    pub async fn read_operation(&mut self, request: &ReadOperation) -> Result<Value> {
        let response = self
            .business_request("readOperation", &request.context, request)
            .await?;
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let framed = match kind {
            "application/json" => false,
            "application/x-ndjson" => true,
            _ => return Err(PeerError::new("INVALID_INPUT")),
        };
        let mut body = response.into_body();
        let (budget, _permit) = receive_budget(&self.shared)?;
        let value = tokio::time::timeout(Duration::from_secs(60), async {
            let mut receiver = framing::StreamReceiver::new(false, budget);
            let mut bytes = Vec::new();
            let mut result = None;
            while let Some(frame) = body.frame().await {
                self.check_context(&request.context)?;
                if let Ok(data) = frame.map_err(unavailable)?.into_data() {
                    if framed {
                        for (kind, value) in receiver.push(&data)? {
                            if kind != "result" || result.replace(value).is_some() {
                                return Err(PeerError::new("INVALID_INPUT"));
                            }
                        }
                    } else {
                        if bytes.len() + data.len() > MAX_FRAME_BYTES {
                            return Err(PeerError::new("RESOURCE_LIMIT"));
                        }
                        bytes.extend_from_slice(&data);
                    }
                }
            }
            if framed {
                receiver
                    .finish()
                    .map_err(|_| PeerError::new("UNAVAILABLE"))?;
                result.ok_or_else(|| PeerError::new("UNAVAILABLE"))
            } else {
                // Native payloads retain ordinary JSON numbers, unlike signed
                // membership control objects (safe nonnegative integers only).
                serde_json::from_slice(&bytes).map_err(|_| PeerError::new("INVALID_INPUT"))
            }
        })
        .await
        .map_err(unavailable)??;
        self.check_context(&request.context)?;
        value
            .get("result")
            .cloned()
            .ok_or_else(|| PeerError::new("INVALID_INPUT"))
    }
    pub(crate) async fn subscribe(
        mut self,
        context: BusinessContext,
        session_id: String,
    ) -> Result<RemoteStream> {
        let response = self
            .business_request(
                "subscribeSessionUpdates",
                &context,
                &SubscribeSessionUpdates {
                    context: context.clone(),
                    session_id: session_id.clone(),
                },
            )
            .await?;
        if response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            != Some("text/event-stream")
        {
            return Err(PeerError::new("INVALID_INPUT"));
        }
        let (budget, permit) = receive_budget(&self.shared)?;
        Ok(RemoteStream {
            client: self,
            context,
            session_id,
            body: response.into_body(),
            receiver: framing::StreamReceiver::new(true, budget),
            pending: VecDeque::new(),
            subscription: None,
            event: 0,
            runtime: None,
            _permit: permit,
        })
    }
}

pub(crate) struct RemoteStream {
    client: PeerClient,
    context: BusinessContext,
    session_id: String,
    body: Incoming,
    receiver: framing::StreamReceiver,
    pending: VecDeque<(String, Value)>,
    subscription: Option<String>,
    event: u64,
    runtime: Option<String>,
    _permit: OwnedSemaphorePermit,
}
impl RemoteStream {
    pub(crate) async fn next(&mut self) -> Result<(String, Value)> {
        loop {
            self.client.check_context(&self.context)?;
            if let Some((kind, value)) = self.pending.pop_front() {
                let update: RemoteSessionUpdates = serde_json::from_value(value.clone())
                    .map_err(|_| PeerError::new("INVALID_INPUT"))?;
                if update.network_id != self.context.network_id
                    || update.host_id != self.context.target_host_id
                    || update.membership_id != self.context.target_membership_id
                    || update.history_id != self.context.history_id
                    || update.event_id != self.event + 1
                    || update.event_id > 9_007_199_254_740_991
                    || (self.event == 0 && kind != "snapshot")
                    || (self.event > 0 && kind != "update")
                    || self
                        .subscription
                        .as_ref()
                        .is_some_and(|id| *id != update.subscription_id)
                    || self
                        .runtime
                        .as_ref()
                        .is_some_and(|id| *id != update.runtime_id)
                    || update.payload["instanceId"] != update.runtime_id
                    || update.payload["contractVersion"] != "v1"
                    || update.payload["details"]["session"]["sessionId"] != self.session_id
                    || uuid::Uuid::parse_str(&update.subscription_id).is_err()
                    || uuid::Uuid::parse_str(&update.runtime_id).is_err()
                    || update.payload["details"]["session"]["hostId"]
                        != self.context.target_host_id.to_string()
                {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                self.event = update.event_id;
                self.subscription = Some(update.subscription_id);
                self.runtime = Some(update.runtime_id);
                return Ok((kind, value));
            }
            let frame = tokio::time::timeout(Duration::from_secs(1), self.body.frame()).await;
            match frame {
                Err(_) => continue,
                Ok(Some(frame)) => {
                    if let Ok(bytes) = frame.map_err(unavailable)?.into_data() {
                        self.pending.extend(self.receiver.push(&bytes)?);
                    }
                }
                Ok(None) => {
                    self.receiver.cancel();
                    return Err(PeerError::new("UNAVAILABLE"));
                }
            }
        }
    }
}

pub(crate) async fn connect_target(
    service: &Service,
    network: NetworkId,
    host: HostId,
    deadline: Instant,
) -> Result<(PeerClient, BusinessContext)> {
    let repo = &service.store.network;
    let result = tokio::time::timeout_at(deadline, async {
        loop {
            let selected = repo
                .current_selection()
                .map_err(unavailable)?
                .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
            if selected.status() != SelectionStatus::Active
                || selected.history().network_id() != network
            {
                return Err(PeerError::new("FORBIDDEN"));
            }
            let member = selected
                .history()
                .active_members()
                .find(|m| m.host_id == host)
                .ok_or_else(|| PeerError::new("NOT_FOUND"))?
                .membership_id;
            let (shared, local_addr) = service
                .peer
                .lock()
                .await
                .as_ref()
                .map(|p| (p.business_shared(), p.local_addr()))
                .ok_or_else(|| PeerError::new("NOT_READY"))?;
            let mut last = PeerError::new("UNAVAILABLE");
            let mut contacts = repo
                .peer_contacts(network)
                .map_err(unavailable)?
                .into_iter()
                .filter(|c| c.membership_id == member)
                .map(|c| (c.endpoint, c.explicit_seed))
                .collect::<Vec<_>>();
            if member == selected.local_member() {
                let mut address = local_addr;
                if address.ip().is_unspecified() {
                    address.set_ip(if address.is_ipv4() {
                        std::net::Ipv4Addr::LOCALHOST.into()
                    } else {
                        std::net::Ipv6Addr::LOCALHOST.into()
                    });
                }
                contacts.insert(0, (format!("https://{address}"), true));
            }
            for (endpoint, explicit) in contacts {
                let mut client = match PeerClient::connect_shared(
                    repo,
                    &endpoint,
                    member,
                    explicit,
                    Some(&shared),
                )
                .await
                {
                    Ok(client) => client,
                    Err(error) => {
                        last = error;
                        continue;
                    }
                };
                match client.synchronize(repo, deadline).await {
                    Ok(()) => {}
                    Err(error) if error.code == "SYNC_REQUIRED" => {
                        last = error;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
                let selected = repo
                    .current_selection()
                    .map_err(unavailable)?
                    .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
                let context = BusinessContext {
                    protocol_version: 1,
                    network_id: network,
                    caller_membership_id: selected.local_member(),
                    target_membership_id: client
                        .hello
                        .membership_id
                        .ok_or_else(|| PeerError::new("FORBIDDEN"))?,
                    history_id: selected.history().snapshot().history_id,
                    source_host_id: selected
                        .history()
                        .member(selected.local_member())
                        .unwrap()
                        .host_id,
                    target_host_id: host,
                };
                client.check_context(&context)?;
                return Ok((client, context));
            }
            if !matches!(
                last.code.as_str(),
                "UNAVAILABLE" | "NOT_READY" | "SYNC_REQUIRED"
            ) {
                return Err(last);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    result.unwrap_or_else(|_| Err(PeerError::new("NOT_READY")))
}
