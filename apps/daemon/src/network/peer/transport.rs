use super::super::Repository;
use super::{
    Result,
    session::{Session, Shared},
    tls, unavailable,
};
use axum::body::Body;
use axum::http::{Method, Request, Response, Uri};
use dewbow_protocol::network::{peer::*, *};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, watch},
    task::{JoinHandle, JoinSet},
};

pub(super) fn endpoint(value: &str) -> Result<(String, u16)> {
    super::super::types::endpoint(value).map_err(|_| PeerError::new("INVALID_INPUT"))?;
    let uri: Uri = value.parse().map_err(|_| PeerError::new("INVALID_INPUT"))?;
    let host = uri
        .host()
        .ok_or_else(|| PeerError::new("INVALID_INPUT"))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    Ok((
        host,
        uri.port_u16()
            .ok_or_else(|| PeerError::new("INVALID_INPUT"))?,
    ))
}
fn forbidden(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_link_local()
        }
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|v| forbidden(IpAddr::V4(v)))
            .unwrap_or(
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || ip.is_unicast_link_local(),
            ),
    }
}
pub(super) fn validate_remote_hint(value: &str) -> Result<()> {
    let (host, _) = endpoint(value)?;
    if host.parse::<IpAddr>().is_ok_and(forbidden) {
        return Err(PeerError::new("INVALID_INPUT"));
    }
    Ok(())
}
async fn dial(value: &str, explicit: bool) -> Result<TcpStream> {
    let (host, port) = endpoint(value)?;
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(unavailable)?;
    for address in addresses {
        if !explicit && forbidden(address.ip()) {
            continue;
        }
        if let Ok(stream) = TcpStream::connect(address).await {
            return Ok(stream);
        }
    }
    Err(PeerError::new("UNAVAILABLE"))
}

pub struct PeerRuntime {
    repo: Repository,
    address: SocketAddr,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
    shared: Arc<Shared>,
}
impl PeerRuntime {
    pub async fn start(repo: Repository) -> anyhow::Result<Option<Self>> {
        Self::start_with_capacity(repo, super::PeerCapacity::default()).await
    }
    pub async fn start_with_capacity(
        repo: Repository,
        capacity: super::PeerCapacity,
    ) -> anyhow::Result<Option<Self>> {
        Self::start_inner(repo, capacity, None, std::sync::Weak::new()).await
    }
    pub(crate) async fn start_in_service(
        repo: Repository,
        maintenance: Arc<crate::maintenance::Maintenance>,
        service: std::sync::Weak<crate::service::Service>,
    ) -> anyhow::Result<Option<Self>> {
        Self::start_inner(
            repo,
            super::PeerCapacity::default(),
            Some(maintenance),
            service,
        )
        .await
    }
    async fn start_inner(
        repo: Repository,
        capacity: super::PeerCapacity,
        maintenance: Option<Arc<crate::maintenance::Maintenance>>,
        service: std::sync::Weak<crate::service::Service>,
    ) -> anyhow::Result<Option<Self>> {
        let Some(address) = repo.peer_settings()?.listen_endpoint else {
            return Ok(None);
        };
        let (host, port) = endpoint(&address)?;
        let listener = TcpListener::bind((host.as_str(), port)).await?;
        let address = listener.local_addr()?;
        let identities = Arc::new(tls::server(repo.clone())?);
        let mut shared = Shared::with_capacity(capacity)?;
        shared.maintenance = maintenance;
        shared.service = service;
        let shared = Arc::new(shared);
        *shared.conflicts.lock().unwrap() = repo.peer_conflicts()?;
        let retained_repo = repo.clone();
        let (stop, mut stopped) = watch::channel(false);
        let runtime_shared = shared.clone();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            tasks.spawn(super::lifecycle::schedule(
                repo.clone(),
                runtime_shared.clone(),
                stopped.clone(),
            ));
            tasks.spawn(super::reconcile::schedule(
                repo.clone(),
                runtime_shared.clone(),
                stopped.clone(),
            ));
            loop {
                tokio::select! {
                    _=stopped.changed()=>break,
                    _=tasks.join_next(),if tasks.len()>1=>{},
                    incoming=listener.accept()=>{
                        let Ok((stream,_))=incoming else{break};
                        let Ok(permit)=runtime_shared.connections.clone().try_acquire_owned()else{continue};
                        tasks.spawn(serve_connection(repo.clone(),runtime_shared.clone(),identities.clone(),stopped.clone(),stream,permit));
                    }
                }
            }
            runtime_shared.stop();
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
            runtime_shared.drain().await;
        });
        Ok(Some(Self {
            repo: retained_repo,
            address,
            stop,
            task: Some(task),
            shared,
        }))
    }
    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }
    pub(super) fn business_shared(&self) -> Arc<Shared> {
        self.shared.clone()
    }
    pub fn address_hint_is_fresh(
        &self,
        network: NetworkId,
        member: MembershipId,
        nonce: Nonce,
    ) -> bool {
        self.shared.hint_is_fresh(network, member, nonce)
    }
    pub async fn connect(
        &self,
        repo: &Repository,
        address: &str,
        member: MembershipId,
        explicit_seed: bool,
    ) -> Result<PeerClient> {
        PeerClient::connect_shared(repo, address, member, explicit_seed, Some(&self.shared)).await
    }
    pub async fn shutdown(mut self) {
        self.shared.stop();
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
    /// Explicit local reconnection clears runtime quarantine; proof is rechecked.
    pub fn reconnect(&self, network: NetworkId, member: MembershipId) -> anyhow::Result<()> {
        let _work = self.shared.begin_work()?;
        let _admission = self.shared.admission()?;
        self.repo.clear_peer_quarantine(network, member)?;
        self.shared
            .conflicts
            .lock()
            .unwrap()
            .remove(&(network, member));
        self.shared.changed.notify_one();
        Ok(())
    }
}
impl Drop for PeerRuntime {
    fn drop(&mut self) {
        self.shared.stop();
        let _ = self.stop.send(true);
    }
}

async fn serve_connection(
    repo: Repository,
    shared: Arc<Shared>,
    identities: Arc<tls::ServerKeys>,
    mut stopped: watch::Receiver<bool>,
    stream: TcpStream,
    _permit: OwnedSemaphorePermit,
) {
    let accepted = tokio::time::timeout(Duration::from_secs(5), async {
        let start =
            tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), stream)
                .await?;
        let name = start
            .client_hello()
            .server_name()
            .ok_or_else(|| std::io::Error::other("SNI required"))?
            .to_string();
        let (config, local) = tokio::task::spawn_blocking(move || identities.select(&name))
            .await
            .map_err(std::io::Error::other)?
            .map_err(std::io::Error::other)?;
        Ok::<_, std::io::Error>((start.into_stream(config).await?, local))
    })
    .await;
    let Ok(Ok((stream, local))) = accepted else {
        return;
    };
    let Some(peer) = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .and_then(|cert| tls::public_key(cert).ok())
    else {
        return;
    };
    let session = Arc::new(Mutex::new(Session::new(
        repo.clone(),
        shared.clone(),
        peer,
        local,
    )));
    let state = session.clone();
    let service = service_fn(move |request| handle(state.clone(), shared.clone(), request));
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder.max_buf_size(MAX_FRAME_BYTES).keep_alive(true);
    let connection = builder.serve_connection(TokioIo::new(stream), service);
    tokio::pin!(connection);
    let mut sweep = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _=stopped.changed()=>break,
            _=&mut connection=>break,
            _=repo.changed.notified()=>{if session.try_lock().is_ok_and(|mut session|session.revoked()){break}},
            _=sweep.tick()=>{if session.try_lock().is_ok_and(|mut session|session.revoked()){break}},
        }
    }
}

async fn handle(
    session: Arc<Mutex<Session>>,
    shared: Arc<Shared>,
    request: Request<Incoming>,
) -> std::result::Result<Response<Body>, Infallible> {
    let result = async {
        if request.method() != Method::POST
            || request.uri().query().is_some()
            || request.headers().contains_key("cookie")
            || request.headers().contains_key("authorization")
            || request.headers().contains_key("content-encoding")
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        let operation = request
            .uri()
            .path()
            .strip_prefix("/network/v1/")
            .filter(|s| !s.is_empty() && !s.contains('/'))
            .ok_or_else(|| PeerError::new("PROTOCOL_UNSUPPORTED"))?
            .to_string();
        let bytes = tokio::time::timeout(
            Duration::from_secs(60),
            Limited::new(request.into_body(), MAX_FRAME_BYTES).collect(),
        )
        .await
        .map_err(|_| PeerError::new("UNAVAILABLE"))?
        .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?
        .to_bytes();
        let input: Value = decode(&bytes)?;
        if matches!(
            operation.as_str(),
            "readOperation" | "subscribeSessionUpdates"
        ) {
            return super::business::handle(session, shared, &operation, input).await;
        }
        let work = shared.begin_work()?;
        tokio::task::spawn_blocking(move || {
            let _work = work;
            session.lock().unwrap().dispatch(&operation, input)
        })
        .await
        .map_err(unavailable)?
        .and_then(|value| {
            let bytes = super::framing::bounded_json(&json!({"result":value}), MAX_FRAME_BYTES)?;
            Ok(Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .header("cache-control", "no-store")
                .body(Body::from(bytes))
                .unwrap())
        })
    }
    .await;
    let error = match result {
        Ok(response) => return Ok(response),
        Err(error) => error,
    };
    let (status, body) = (error.status(), json!({"error":error}));
    let mut bytes = serde_json::to_vec(&body).unwrap_or_default();
    let status = if bytes.len() > MAX_FRAME_BYTES {
        bytes = serde_json::to_vec(&json!({"error":PeerError::new("RESOURCE_LIMIT")})).unwrap();
        429
    } else {
        status
    };
    Ok(Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Body::from(bytes))
        .unwrap())
}

pub struct PeerClient {
    pub(super) business_context: Option<super::business::Authorization>,
    pub(super) repo: Repository,
    binding: (uuid::Uuid, NetworkId, MembershipId),
    pub(super) shared: Arc<Shared>,
    pub(super) remote_key: PublicKey,
    proof_channel: bool,
    lifecycle_channel: bool,
    pub(super) sender: hyper::client::conn::http1::SendRequest<Full<Bytes>>,
    task: JoinHandle<()>,
    pub(super) authority: String,
    pub(super) hello: HelloResult,
    _permit: Option<OwnedSemaphorePermit>,
}
impl Drop for PeerClient {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl PeerClient {
    pub async fn connect(
        repo: &Repository,
        address: &str,
        member: MembershipId,
        explicit_seed: bool,
    ) -> Result<Self> {
        Self::connect_shared(repo, address, member, explicit_seed, None).await
    }
    pub(super) async fn connect_shared(
        repo: &Repository,
        address: &str,
        member: MembershipId,
        explicit_seed: bool,
        shared: Option<&Arc<Shared>>,
    ) -> Result<Self> {
        let shared = shared
            .cloned()
            .unwrap_or_else(|| Arc::new(Shared::default()));
        match Self::connect_member(repo, address, member, explicit_seed, &shared).await {
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "UNAVAILABLE" | "UNAUTHORIZED" | "FORBIDDEN"
                ) =>
            {
                let resolved = tokio::time::timeout(
                    shared.proof_budget,
                    Self::recover_identity(repo, address, member, explicit_seed, &shared),
                )
                .await
                .map_err(|_| PeerError::new("RESOURCE_LIMIT"))??;
                let client =
                    Self::connect_member(repo, address, resolved, explicit_seed, &shared).await?;
                let _work = shared.begin_work()?;
                let _admission = shared.admission()?;
                repo.remember_verified_peer(
                    client.hello.network_id,
                    resolved,
                    address,
                    explicit_seed,
                )
                .map_err(unavailable)?;
                Ok(client)
            }
            result => result,
        }
    }
    pub fn hello(&self) -> &HelloResult {
        &self.hello
    }
    async fn connect_member(
        repo: &Repository,
        address: &str,
        member: MembershipId,
        explicit_seed: bool,
        shared: &Arc<Shared>,
    ) -> Result<Self> {
        let selected = repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("NOT_READY"))?;
        if shared
            .conflicts
            .lock()
            .unwrap()
            .contains(&(selected.history().network_id(), member))
        {
            return Err(PeerError::new("HISTORY_CONFLICT"));
        }
        if selected.status() != SelectionStatus::Active {
            return Err(PeerError::new("FORBIDDEN"));
        }
        let expected = selected
            .history()
            .member(member)
            .filter(|_| selected.history().is_active(member))
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
        for attempt in 0..2 {
            let mut client = Self::open_transport(
                repo,
                address,
                Some(expected.public_key),
                explicit_seed,
                shared,
            )
            .await?;
            client.hello = client
                .request(
                    "hello",
                    &Hello::Member {
                        protocol_version: 1,
                        network_id: selected.history().network_id(),
                        membership_id: selected.local_member(),
                        history: selected.history().snapshot().clone(),
                    },
                )
                .await?;
            if client.hello.protocol_version != 1
                || client.hello.network_id != selected.history().network_id()
                || client.hello.membership_id != Some(member)
            {
                return Err(PeerError::new("UNAUTHORIZED"));
            }
            if client.hello.access != Access::ProofOnly {
                return Ok(client);
            }
            if attempt == 1 {
                return Err(PeerError::new("FORBIDDEN"));
            }
            match client
                .read_proof(
                    repo,
                    SubmitMembershipProof::Open {
                        purpose: ProofPurpose::Exclusion,
                        membership_id: Some(selected.local_member()),
                        record_id: None,
                    },
                )
                .await
            {
                Ok(history) => {
                    Self::adopt_proof(repo, shared, member, &history).await?;
                    let current = repo
                        .current_selection()
                        .map_err(unavailable)?
                        .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
                    if current.status() != SelectionStatus::Active
                        || !current.history().is_active(member)
                    {
                        return Err(PeerError::new("FORBIDDEN"));
                    }
                }
                Err(error) if error.code == "FORBIDDEN" => {}
                Err(error) => return Err(error),
            }
            let opened: Value = client
                .request(
                    "submitMembershipProof",
                    &SubmitMembershipProof::Open {
                        purpose: ProofPurpose::Admission,
                        membership_id: Some(selected.local_member()),
                        record_id: Some(RecordId::from_bytes(*selected.local_member().as_bytes())),
                    },
                )
                .await?;
            let proof_token = opened["proofToken"]
                .as_str()
                .ok_or_else(|| PeerError::new("INVALID_PROOF"))?
                .to_string();
            let history = super::super::peer_store::history_subset(
                selected.history(),
                &[RecordId::from_bytes(*selected.local_member().as_bytes())],
                repo.limits,
            )?;
            let ordered = super::session::ancestor_order(&history);
            let mut offset = 0;
            while offset < ordered.len() {
                let mut records = Vec::new();
                let mut bytes = 256;
                for r in ordered[offset..].iter().take(MAX_RECORD_PAGE) {
                    if bytes + r.encoded().len() > MAX_FRAME_BYTES - 1024 {
                        break;
                    }
                    bytes += r.encoded().len();
                    records
                        .push(serde_json::from_slice::<Value>(r.encoded()).map_err(unavailable)?);
                }
                offset += records.len();
                let result: Value = client
                    .request(
                        "submitMembershipProof",
                        &SubmitMembershipProof::Write {
                            proof_token: proof_token.clone(),
                            records,
                            done: offset == ordered.len(),
                        },
                    )
                    .await?;
                if offset == ordered.len() && result["complete"] != true {
                    return Err(PeerError::new("PROOF_INCOMPLETE"));
                }
            }
        }
        Err(PeerError::new("FORBIDDEN"))
    }
    pub(super) async fn open_transport(
        repo: &Repository,
        address: &str,
        expected: Option<PublicKey>,
        explicit_seed: bool,
        shared: &Arc<Shared>,
    ) -> Result<Self> {
        let selected = repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("NOT_READY"))?;
        if selected.status() != SelectionStatus::Active {
            return Err(PeerError::new("FORBIDDEN"));
        }
        let local = selected.history().member(selected.local_member()).unwrap();
        Self::open_identity(
            repo,
            address,
            expected,
            explicit_seed,
            shared,
            local.public_key,
            (
                selected.selection_id(),
                selected.history().network_id(),
                selected.local_member(),
            ),
            false,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn open_identity(
        repo: &Repository,
        address: &str,
        expected: Option<PublicKey>,
        explicit_seed: bool,
        shared: &Arc<Shared>,
        local: PublicKey,
        binding: (uuid::Uuid, NetworkId, MembershipId),
        lifecycle_channel: bool,
    ) -> Result<Self> {
        let permit = shared
            .connections
            .clone()
            .try_acquire_owned()
            .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?;
        let config = tls::client(repo, local, expected).map_err(unavailable)?;
        let name = rustls::pki_types::ServerName::try_from(
            expected
                .map(tls::selector)
                .unwrap_or_else(|| "proof.dewbow.invalid".into()),
        )
        .map_err(unavailable)?;
        let stream = tokio::time::timeout(Duration::from_secs(5), async {
            let tcp = dial(address, explicit_seed).await?;
            tokio_rustls::TlsConnector::from(config)
                .connect(name, tcp)
                .await
                .map_err(unavailable)
        })
        .await
        .map_err(|_| PeerError::new("UNAVAILABLE"))??;
        let remote_key = tls::public_key(
            &stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|c| c.first())
                .cloned()
                .ok_or_else(|| PeerError::new("UNAUTHORIZED"))?,
        )
        .map_err(unavailable)?;
        let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(unavailable)?;
        let mut stopped = shared.stopping.subscribe();
        let task = tokio::spawn(async move {
            if *stopped.borrow() {
                return;
            }
            tokio::select! {_=stopped.changed()=>{},_=connection=>{}}
        });
        Ok(Self {
            business_context: None,
            repo: repo.clone(),
            binding,
            lifecycle_channel,
            shared: shared.clone(),
            remote_key,
            proof_channel: expected.is_none(),
            sender,
            task,
            authority: address
                .parse::<Uri>()
                .map_err(unavailable)?
                .authority()
                .unwrap()
                .to_string(),
            hello: HelloResult {
                protocol_version: 1,
                network_id: binding.1,
                membership_id: None,
                history: None,
                access: Access::ProofOnly,
            },
            _permit: Some(permit),
        })
    }
    pub async fn request<T: DeserializeOwned>(
        &mut self,
        operation: &str,
        input: &impl Serialize,
    ) -> Result<T> {
        if self.shared.stopped.load(Ordering::Acquire) {
            return Err(PeerError::new("UNAVAILABLE"));
        }
        if self.proof_channel
            && !self.lifecycle_channel
            && !matches!(operation, "hello" | "submitMembershipProof")
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        if self.lifecycle_channel {
            if !matches!(
                operation,
                "hello"
                    | "submitMembershipProof"
                    | "getInvitationProof"
                    | "redeemInvitation"
                    | "getJoinResult"
                    | "deliverDeparture"
                    | "getDepartureStatus"
            ) {
                return Err(PeerError::new("FORBIDDEN"));
            }
        } else {
            let selected = self
                .repo
                .current_selection()
                .map_err(unavailable)?
                .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
            if selected.status() != SelectionStatus::Active
                || (
                    selected.selection_id(),
                    selected.history().network_id(),
                    selected.local_member(),
                ) != self.binding
                || (!self.proof_channel
                    && self
                        .hello
                        .membership_id
                        .is_some_and(|id| !selected.history().is_active(id)))
            {
                return Err(PeerError::new("FORBIDDEN"));
            }
        }
        let bytes = super::framing::bounded_json(input, MAX_FRAME_BYTES)?;
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/network/v1/{operation}"))
            .header("host", &self.authority)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(bytes)))
            .map_err(unavailable)?;
        let response =
            tokio::time::timeout(Duration::from_secs(60), self.sender.send_request(request))
                .await
                .map_err(|_| PeerError::new("UNAVAILABLE"))?
                .map_err(unavailable)?;
        let status = response.status();
        let bytes = tokio::time::timeout(
            Duration::from_secs(60),
            Limited::new(response.into_body(), MAX_FRAME_BYTES).collect(),
        )
        .await
        .map_err(|_| PeerError::new("UNAVAILABLE"))?
        .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?
        .to_bytes();
        let body: Value = decode(&bytes)?;
        if let Some(error) = body.get("error") {
            return Err(serde_json::from_value(error.clone())
                .map_err(|_| PeerError::new("INVALID_INPUT"))?);
        }
        if !status.is_success() {
            return Err(PeerError::new("UNAVAILABLE"));
        }
        serde_json::from_value(
            body.get("result")
                .cloned()
                .ok_or_else(|| PeerError::new("INVALID_INPUT"))?,
        )
        .map_err(|_| PeerError::new("INVALID_INPUT"))
    }
}
