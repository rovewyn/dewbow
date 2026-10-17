use super::*;
use crate::{
    config,
    network::{AttemptId, Intent, PeerSettings, Repository},
    store::Store,
};
use dewbow_protocol::network::{peer::*, *};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc, time::Duration};
use tokio::time::Instant;

struct Node {
    root: PathBuf,
    store: Option<Store>,
}
impl Node {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dewbow-peer-{}", uuid::Uuid::new_v4()));
        config::init(
            &root,
            Some("/synthetic/codex".into()),
            Some("/synthetic/codex-home".into()),
            Some(3000),
        )
        .unwrap();
        Self {
            store: Some(Store::open(&root).unwrap()),
            root,
        }
    }
    fn repo(&self) -> &Repository {
        &self.store.as_ref().unwrap().network
    }
    fn selected(&self) -> LocalSelection {
        self.repo().current_selection().unwrap().unwrap()
    }
    fn member(&self) -> MembershipId {
        self.selected().local_member()
    }
    fn public(&self) -> PublicKey {
        let s = self.selected();
        s.history().member(s.local_member()).unwrap().public_key
    }
    fn intent(&self, operation: &str) -> Intent {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).unwrap();
        Intent {
            request_id: uuid::Uuid::new_v4().to_string(),
            operation: operation.into(),
            fingerprint: bytes,
            operation_id: Some(Nonce::from_bytes(bytes)),
        }
    }
    fn create(&self) {
        let intent = self.intent("createNetwork");
        self.repo()
            .create_network(
                &intent,
                "Synthetic peers".into(),
                intent.operation_id.unwrap(),
            )
            .unwrap();
    }
    fn admit(&self, other: &Node) {
        let issued = self
            .repo()
            .create_invitation(
                &self.intent("createInvitation"),
                vec!["https://192.0.2.1:7443".into()],
            )
            .unwrap();
        let intent = other.intent("joinNetwork");
        let attempt = other
            .repo()
            .prepare_join_attempt(
                &intent,
                &issued.invitation,
                **issued.secret.as_ref().unwrap(),
                intent.operation_id.unwrap(),
            )
            .unwrap();
        let current = self.selected();
        other
            .repo()
            .prepare_join_proof(attempt, current.history())
            .unwrap();
        let proof = other.repo().begin_redemption(attempt).unwrap();
        let intent = self.intent("confirmNetworkJoin");
        let record = self
            .repo()
            .sign_active_change(
                &current.selection_id().to_string(),
                intent.operation_id.unwrap(),
                Change::Admit(Box::new(proof.clone())),
            )
            .unwrap();
        let Decision::Proposed(proposal) =
            consider(current.history(), &record, &[], Limits::default()).unwrap()
        else {
            panic!("Expected admission")
        };
        self.repo()
            .commit_confirmed_admission(&intent, &proof, &proposal, record.id())
            .unwrap();
        other
            .repo()
            .finish_join(attempt, proposal.result().clone(), record.id())
            .unwrap();
    }
    fn change(&self, change: Change) -> SignedRecord {
        let intent = self.intent(if matches!(change, Change::Leave) {
            "leaveNetwork"
        } else {
            "removeNetworkMember"
        });
        let selected = self.selected();
        let record = self
            .repo()
            .sign_active_change(
                &selected.selection_id().to_string(),
                intent.operation_id.unwrap(),
                change,
            )
            .unwrap();
        let Decision::Proposed(proposal) =
            consider(selected.history(), &record, &[], Limits::default()).unwrap()
        else {
            panic!("Expected change")
        };
        self.repo()
            .commit_local_change(&intent, &proposal, record.id())
            .unwrap();
        record
    }
    fn catch_up(&self, source: &Node) {
        let history = source.selected();
        for record in session::ancestor_order(history.history()) {
            let selected = self.selected();
            if let Decision::Proposed(proposal) =
                consider(selected.history(), record, &[], Limits::default()).unwrap()
            {
                self.repo()
                    .commit_adoption(&selected.selection_id().to_string(), &proposal)
                    .unwrap();
            }
        }
    }
    async fn listen(&self) -> PeerRuntime {
        self.repo()
            .configure_peer(&PeerSettings {
                listen_endpoint: Some("https://127.0.0.1:0".into()),
                advertised_endpoints: vec![],
            })
            .unwrap();
        PeerRuntime::start(self.repo().clone())
            .await
            .unwrap()
            .unwrap()
    }
    fn restart(&mut self) {
        self.store.take();
        self.store = Some(Store::open(&self.root).unwrap());
    }
}
impl Drop for Node {
    fn drop(&mut self) {
        self.store.take();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn common() -> (Node, Node, Node) {
    let a = Node::new();
    let b = Node::new();
    let c = Node::new();
    a.create();
    a.admit(&b);
    a.admit(&c);
    b.catch_up(&a);
    (a, b, c)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn business_reads_bind_current_history_and_both_tls_generations() {
    let (a, b, c) = common();
    let server = c.listen().await;
    let mut client = PeerClient::connect(b.repo(), &endpoint(&server), c.member(), true)
        .await
        .unwrap();
    let context = BusinessContext {
        protocol_version: 1,
        network_id: c.selected().history().network_id(),
        caller_membership_id: b.member(),
        target_membership_id: c.member(),
        history_id: c.selected().history().snapshot().history_id,
        source_host_id: b.selected().history().member(b.member()).unwrap().host_id,
        target_host_id: c.selected().history().member(c.member()).unwrap().host_id,
    };
    let request = ReadOperation {
        context: context.clone(),
        operation: ReadName::ListHosts,
        input: json!({}),
    };
    // Standalone transport has no native service, but authorization is still enforced first.
    assert_eq!(
        client.read_operation(&request).await.unwrap_err().code,
        "NOT_READY"
    );
    let mut forged = request.clone();
    forged.context.caller_membership_id = a.member();
    forged.context.source_host_id = a.selected().history().member(a.member()).unwrap().host_id;
    assert_eq!(
        client
            .request::<Value>("readOperation", &forged)
            .await
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
    forged = request.clone();
    forged.context.target_host_id = forged.context.source_host_id;
    assert_eq!(
        client
            .request::<Value>("readOperation", &forged)
            .await
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
    let mut unknown = serde_json::to_value(&request).unwrap();
    unknown["operation"] = json!("sendMessage");
    assert_eq!(
        client
            .request::<Value>("readOperation", &unknown)
            .await
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    unknown = serde_json::to_value(&request).unwrap();
    unknown["extra"] = json!(true);
    assert_eq!(
        client
            .request::<Value>("readOperation", &unknown)
            .await
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    // Quarantine is independent of the selected history and must override a
    // previously verified context on this same connection.
    let shared = client.shared.clone();
    shared
        .conflicts
        .lock()
        .unwrap()
        .insert((context.network_id, c.member()));
    assert_eq!(
        client.read_operation(&request).await.unwrap_err().code,
        "HISTORY_CONFLICT"
    );
    shared
        .conflicts
        .lock()
        .unwrap()
        .remove(&(context.network_id, c.member()));
    c.change(Change::Remove(a.member()));
    assert_eq!(
        client.read_operation(&request).await.unwrap_err().code,
        "SYNC_REQUIRED"
    );
    c.change(Change::Remove(b.member()));
    assert!(
        client
            .request::<Value>("readOperation", &request)
            .await
            .is_err()
    );
    drop(client);
    server.shutdown().await;
}
fn endpoint(runtime: &PeerRuntime) -> String {
    format!("https://{}", runtime.local_addr())
}
async fn sync(from: &Node, to: &Node, runtime: &PeerRuntime) -> super::Result<()> {
    let mut client =
        PeerClient::connect(from.repo(), &endpoint(runtime), to.member(), true).await?;
    client
        .synchronize(from.repo(), Instant::now() + Duration::from_secs(15))
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn founder_offline_unknown_admission_and_revocation_use_real_tls() {
    let (a, b, c) = common();
    let network = b.selected().history().network_id();
    let server = c.listen().await;
    // The founder never starts a listener. B/C are equal peers.
    c.change(Change::Remove(a.member()));
    sync(&b, &c, &server).await.unwrap();
    assert_eq!(
        b.selected().history().snapshot(),
        c.selected().history().snapshot()
    );
    assert!(!b.selected().history().is_active(a.member()));
    let d = Node::new();
    b.admit(&d);
    assert!(c.selected().history().member(d.member()).is_none());
    let mut client = PeerClient::connect(d.repo(), &endpoint(&server), c.member(), true)
        .await
        .unwrap();
    assert!(c.selected().history().is_active(d.member()));
    assert_eq!(client.hello.network_id, network);
    assert_ne!(client.hello.access, Access::ProofOnly);
    c.change(Change::Remove(d.member()));
    let denied = client
        .request::<Value>("openHistory", &OpenHistory { frontier: None })
        .await;
    assert!(denied.is_err());
    assert!(d.selected().history().is_active(d.member())); // Local reachability is not membership knowledge.
    drop(client);
    let address = server.local_addr();
    server.shutdown().await;
    assert!(tokio::net::TcpListener::bind(address).await.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_commit_and_lost_ack_recover_without_reverting_history() {
    let (a, mut b, c) = common();
    let server = c.listen().await;
    c.change(Change::Remove(a.member()));
    let before = b.selected().history().snapshot().clone();
    b.repo().db.lock().unwrap().execute_batch("CREATE TEMP TRIGGER synthetic_failure BEFORE INSERT ON network_records BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    assert_eq!(sync(&b, &c, &server).await.unwrap_err().code, "UNAVAILABLE");
    assert_eq!(*b.selected().history().snapshot(), before);
    b.repo()
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER synthetic_failure;")
        .unwrap();
    // Model a lost acknowledgement after durable adoption of the received record.
    b.catch_up(&c);
    let accepted = b.selected().history().snapshot().clone();
    b.restart();
    sync(&b, &c, &server).await.unwrap();
    assert_eq!(*b.selected().history().snapshot(), accepted);
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn verified_conflict_is_quarantined_without_branch_rollback() {
    let (a, b, mut c) = common();
    let d = Node::new();
    b.admit(&d);
    c.catch_up(&b);
    a.change(Change::Remove(b.member()));
    let before = c.selected().history().snapshot().clone();
    let server = a.listen().await;
    let shared = Arc::new(session::Shared::default());
    let mut client = PeerClient::connect_shared(
        c.repo(),
        &endpoint(&server),
        a.member(),
        true,
        Some(&shared),
    )
    .await
    .unwrap();
    assert_eq!(
        client
            .synchronize_shared(c.repo(), &shared, Instant::now() + Duration::from_secs(15))
            .await
            .unwrap_err()
            .code,
        "HISTORY_CONFLICT"
    );
    assert_eq!(*c.selected().history().snapshot(), before);
    assert!(
        shared
            .conflicts
            .lock()
            .unwrap()
            .contains(&(before_network(&c), a.member()))
    );
    let count: i64 = c
        .repo()
        .db
        .lock()
        .unwrap()
        .query_row("SELECT count(*) FROM network_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    drop(client);
    server.shutdown().await;
    let network = c.selected().history().network_id();
    c.restart();
    assert!(
        c.repo()
            .peer_conflicts()
            .unwrap()
            .contains(&(network, a.member()))
    );
    let restarted = c.listen().await;
    assert_eq!(
        restarted
            .connect(c.repo(), "https://127.0.0.1:1", a.member(), true)
            .await
            .err()
            .unwrap()
            .code,
        "HISTORY_CONFLICT"
    );
    restarted.reconnect(network, a.member()).unwrap();
    assert!(c.repo().peer_conflicts().unwrap().is_empty());
    assert_eq!(*c.selected().history().snapshot(), before);
    restarted.shutdown().await;
}
fn before_network(node: &Node) -> NetworkId {
    node.selected().history().network_id()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peer_listener_isolated_from_operator_routes_and_tls_key_substitution() {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    use hyper_util::rt::TokioIo;
    let (a, b, c) = common();
    let server = a.listen().await;
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let tcp = tokio::net::TcpStream::connect(server.local_addr())
            .await
            .unwrap();
        let connected = tokio_rustls::TlsConnector::from(tls::anonymous_client(a.public()))
            .connect(
                rustls::pki_types::ServerName::try_from(tls::selector(a.public())).unwrap(),
                tcp,
            )
            .await;
        if let Ok(mut stream) = connected {
            let written=stream.write_all(b"POST /network/v1/hello HTTP/1.1\r\nHost: synthetic\r\nContent-Length: 2\r\n\r\n{}").await;
            if written.is_ok() {
                let mut byte = [0];
                let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
                    .await
                    .unwrap();
                assert!(read.is_err() || read.unwrap() == 0);
            }
        }
    }
    let address = endpoint(&server);
    let before = b.selected().history().snapshot().clone();
    assert_eq!(
        PeerClient::connect(b.repo(), &address, c.member(), true)
            .await
            .err()
            .unwrap()
            .code,
        "UNAUTHORIZED"
    );
    assert_eq!(*b.selected().history().snapshot(), before);
    let mut client = PeerClient::connect(b.repo(), &address, a.member(), true)
        .await
        .unwrap();
    assert_eq!(
        client
            .request::<Value>("../internal/stop", &json!({}))
            .await
            .unwrap_err()
            .code,
        "PROTOCOL_UNSUPPORTED"
    );
    assert_eq!(
        client
            .request::<Value>("executeOperation", &json!({}))
            .await
            .unwrap_err()
            .code,
        "NOT_READY"
    );
    assert_eq!(
        client
            .request::<Value>(
                "hello",
                &Hello::Member {
                    protocol_version: 1,
                    network_id: b.selected().history().network_id(),
                    membership_id: b.member(),
                    history: b.selected().history().snapshot().clone()
                }
            )
            .await
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    let wrong = tls::client(b.repo(), b.public(), Some(b.public())).unwrap();
    let tcp = tokio::net::TcpStream::connect(server.local_addr())
        .await
        .unwrap();
    assert!(
        tokio_rustls::TlsConnector::from(wrong)
            .connect(
                rustls::pki_types::ServerName::try_from(tls::selector(a.public())).unwrap(),
                tcp
            )
            .await
            .is_err()
    );
    let config = tls::client(b.repo(), b.public(), Some(a.public())).unwrap();
    let tcp = tokio::net::TcpStream::connect(server.local_addr())
        .await
        .unwrap();
    let stream = tokio_rustls::TlsConnector::from(config)
        .connect(
            rustls::pki_types::ServerName::try_from(tls::selector(a.public())).unwrap(),
            tcp,
        )
        .await
        .unwrap();
    assert_eq!(
        stream.get_ref().1.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_3)
    );
    assert_eq!(
        stream.get_ref().1.handshake_kind(),
        Some(rustls::HandshakeKind::Full)
    );
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    let request = hyper::Request::builder()
        .method("POST")
        .uri("/network/v1/hello")
        .header("host", "synthetic")
        .body(Full::new(Bytes::from(
            serde_json::to_vec(&Hello::Member {
                protocol_version: 1,
                network_id: b.selected().history().network_id(),
                membership_id: a.member(),
                history: b.selected().history().snapshot().clone(),
            })
            .unwrap(),
        )))
        .unwrap();
    let response = sender.send_request(request).await.unwrap();
    assert_eq!(response.status(), 401);
    let _ = response.into_body().collect().await;
    task.abort();
    drop(client);
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn automatic_reconciliation_reconnects_without_founder_or_membership_timeouts() {
    let (a, mut b, c) = common();
    let rb = b.listen().await;
    let rc = c.listen().await;
    let network = b.selected().history().network_id();
    b.repo()
        .set_peer_address(network, c.member(), &endpoint(&rc))
        .unwrap();
    c.repo()
        .set_peer_address(network, b.member(), &endpoint(&rb))
        .unwrap();
    b.change(Change::Remove(a.member()));
    tokio::time::timeout(Duration::from_secs(20), async {
        while b.selected().history().snapshot() != c.selected().history().snapshot() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    let retained = c.selected().history().snapshot().clone();
    rb.shutdown().await;
    b.restart();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(*c.selected().history().snapshot(), retained);
    assert!(c.selected().history().is_active(b.member()));
    let d = Node::new();
    c.admit(&d);
    let rb = b.listen().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        while b.selected().history().snapshot() != c.selected().history().snapshot() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(b.selected().history().is_active(d.member()));
    rb.shutdown().await;
    rc.shutdown().await;
}

#[test]
fn manifest_retry_proof_scope_and_incomplete_records_do_not_grant_authority() {
    let (a, b, _c) = common();
    let shared = Arc::new(session::Shared::default());
    let selected = b.selected();
    let mut session = session::Session::new(a.repo().clone(), shared, b.public(), a.public());
    session
        .dispatch(
            "hello",
            serde_json::to_value(Hello::Member {
                protocol_version: 1,
                network_id: selected.history().network_id(),
                membership_id: b.member(),
                history: selected.history().snapshot().clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let history = a.selected();
    let ids: Vec<_> = history.history().records().map(|r| r.id()).collect();
    let opened = session
        .dispatch(
            "submitHistoryManifest",
            serde_json::to_value(SubmitHistoryManifest::Open {
                history: history.history().snapshot().clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let token = opened["manifestToken"].as_str().unwrap().to_string();
    let request = serde_json::to_value(SubmitHistoryManifest::Write {
        manifest_token: token.clone(),
        after_record_id: None,
        record_ids: ids.clone(),
        done: true,
    })
    .unwrap();
    let first = session
        .dispatch("submitHistoryManifest", request.clone())
        .unwrap();
    assert_eq!(
        session.dispatch("submitHistoryManifest", request).unwrap(),
        first
    );
    assert_eq!(
        session
            .dispatch(
                "submitHistoryManifest",
                serde_json::to_value(SubmitHistoryManifest::Write {
                    manifest_token: token,
                    after_record_id: None,
                    record_ids: vec![ids[0]],
                    done: true
                })
                .unwrap()
            )
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    assert!(decode::<Value>(br#"{"x":1,"x":2}"#).is_err());
    let unrelated = Node::new();
    unrelated.create();
    let mut unknown = session::Session::new(
        a.repo().clone(),
        Arc::new(session::Shared::default()),
        unrelated.public(),
        a.public(),
    );
    let result = unknown
        .dispatch(
            "hello",
            serde_json::to_value(Hello::Member {
                protocol_version: 1,
                network_id: selected.history().network_id(),
                membership_id: unrelated.member(),
                history: unrelated.selected().history().snapshot().clone(),
            })
            .unwrap(),
        )
        .unwrap();
    assert_eq!(result["access"], "proofOnly");
    assert_eq!(
        unknown
            .dispatch("openHistory", json!({"frontier":null}))
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
    let proof = unknown
        .dispatch(
            "submitMembershipProof",
            serde_json::to_value(SubmitMembershipProof::Open {
                purpose: ProofPurpose::Admission,
                membership_id: Some(unrelated.member()),
                record_id: None,
            })
            .unwrap(),
        )
        .unwrap();
    assert!(proof["history"].is_null());
    assert_eq!(
        unknown
            .dispatch(
                "submitMembershipProof",
                serde_json::to_value(SubmitMembershipProof::Read {
                    proof_token: proof["proofToken"].as_str().unwrap().into(),
                    cursor: None,
                    limit: 32
                })
                .unwrap()
            )
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
}

#[test]
fn framed_results_preserve_large_values_and_reject_partial_corrupt_or_excess_data() {
    use framing::*;
    let expected = json!({"result":{"nativeItem":"中文🚀".repeat(150_000),"number":1.25}});
    let frames = Transfer::new(&expected, "result", DEFAULT_TRANSFER_BYTES)
        .unwrap()
        .collect::<Vec<_>>();
    let mut receiver = Receiver::new(DEFAULT_TRANSFER_BYTES);
    let mut result = None;
    for frame in frames.clone() {
        assert!(encode_line(&frame, false).unwrap().len() <= MAX_FRAME_BYTES);
        assert!(encode_line(&frame, true).unwrap().starts_with(b"event: "));
        if let Some(value) = receiver.accept(frame).unwrap() {
            result = Some(value.1);
        }
    }
    assert_eq!(result, Some(expected.clone()));
    for sse in [false, true] {
        let mut stream = StreamReceiver::new(sse, DEFAULT_TRANSFER_BYTES);
        let mut received = Vec::new();
        for frame in Transfer::new(&expected, "snapshot", DEFAULT_TRANSFER_BYTES).unwrap() {
            let line = encode_line(&frame, sse).unwrap();
            for part in line.chunks(137) {
                received.extend(stream.push(part).unwrap());
            }
        }
        assert_eq!(received, vec![("snapshot".into(), expected.clone())]);
        stream.finish().unwrap();
    }
    receiver.finish().unwrap();
    let mut partial = Receiver::new(DEFAULT_TRANSFER_BYTES);
    partial.accept(frames[0].clone()).unwrap();
    partial.accept(frames[1].clone()).unwrap();
    assert!(partial.finish().is_err());
    let mut reordered = Receiver::new(DEFAULT_TRANSFER_BYTES);
    reordered.accept(frames[0].clone()).unwrap();
    assert!(reordered.accept(frames[2].clone()).is_err());
    let mut limited = Receiver::new(1);
    limited.accept(frames[0].clone()).unwrap();
    assert_eq!(
        limited.accept(frames[1].clone()).unwrap_err().code,
        "RESOURCE_LIMIT"
    );
    assert!(Transfer::new(&expected, "result", 1).is_err());
    let mut corrupt = frames;
    if let Frame::End { sha256, .. } = corrupt.last_mut().unwrap() {
        *sha256 = Nonce::from_bytes([0; 32]);
    }
    let mut receiver = Receiver::new(DEFAULT_TRANSFER_BYTES);
    assert!(corrupt.into_iter().any(|f| receiver.accept(f).is_err()));
}

#[tokio::test(start_paused = true)]
async fn snapshots_renew_idle_expiry_without_mixing_advancing_history() {
    let (a, b, c) = common();
    let shared = Arc::new(session::Shared::default());
    let memory = shared.memory.clone();
    let mut session = session::Session::new(a.repo().clone(), shared, b.public(), a.public());
    session
        .dispatch(
            "hello",
            serde_json::to_value(Hello::Member {
                protocol_version: 1,
                network_id: b.selected().history().network_id(),
                membership_id: b.member(),
                history: b.selected().history().snapshot().clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let opened = session
        .dispatch("openHistory", json!({"frontier":null}))
        .unwrap();
    let original = a.selected().history().snapshot().clone();
    b.repo()
        .configure_peer(&PeerSettings {
            listen_endpoint: None,
            advertised_endpoints: vec!["https://192.0.2.2:7443".into()],
        })
        .unwrap();
    let hint = b.repo().sign_address_hint().unwrap().unwrap();
    let exchange = serde_json::to_value(ExchangeAddressHints {
        hints: vec![hint.clone()],
    })
    .unwrap();
    session
        .dispatch("exchangeAddressHints", exchange.clone())
        .unwrap();
    a.change(Change::Remove(c.member()));
    let mut after = None;
    let mut ids = Vec::new();
    loop {
        tokio::time::advance(Duration::from_secs(50)).await;
        let page: HistoryIds = serde_json::from_value(
            session
                .dispatch(
                    "listHistoryIds",
                    serde_json::to_value(ListHistoryIds {
                        snapshot_token: opened["snapshotToken"].as_str().unwrap().into(),
                        after_record_id: after,
                        limit: 1,
                    })
                    .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(page.history_id, original.history_id);
        ids.extend(page.record_ids);
        after = page.next_after_record_id;
        if after.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), original.record_count);
    assert_ne!(
        original.history_id,
        a.selected().history().snapshot().history_id
    );
    assert!(memory.available_permits() < 64 * 1024 * 1024);
    tokio::time::advance(Duration::from_secs(61)).await;
    assert_eq!(
        session
            .dispatch(
                "listHistoryIds",
                serde_json::to_value(ListHistoryIds {
                    snapshot_token: opened["snapshotToken"].as_str().unwrap().into(),
                    after_record_id: None,
                    limit: 1
                })
                .unwrap()
            )
            .unwrap_err()
            .code,
        "SNAPSHOT_EXPIRED"
    );
    assert_eq!(memory.available_permits(), 64 * 1024 * 1024);
    session.dispatch("exchangeAddressHints", exchange).unwrap();
    tokio::time::advance(Duration::from_secs(90)).await;
    assert!(!session.shared.hint_is_fresh(
        hint.body.network_id,
        hint.body.membership_id,
        hint.body.nonce
    ));
    assert!(
        !a.repo()
            .peer_contacts(hint.body.network_id)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn discarded_child_is_rediscovered_and_proof_connection_stays_restricted() {
    let (a, b, _c) = common();
    let d = Node::new();
    let e = Node::new();
    b.admit(&d);
    d.admit(&e);
    let child = RecordId::from_bytes(*e.member().as_bytes());
    let parent = RecordId::from_bytes(*d.member().as_bytes());
    let history = e.selected();
    let shared = Arc::new(session::Shared::default());
    let mut session = session::Session::new(a.repo().clone(), shared, e.public(), a.public());
    session
        .dispatch(
            "hello",
            serde_json::to_value(Hello::Member {
                protocol_version: 1,
                network_id: history.history().network_id(),
                membership_id: e.member(),
                history: history.history().snapshot().clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let opened = session
        .dispatch(
            "submitMembershipProof",
            serde_json::to_value(SubmitMembershipProof::Open {
                purpose: ProofPurpose::Admission,
                membership_id: Some(e.member()),
                record_id: Some(child),
            })
            .unwrap(),
        )
        .unwrap();
    let token = opened["proofToken"].as_str().unwrap().to_string();
    let encoded = |id| {
        serde_json::from_slice::<Value>(history.history().record(id).unwrap().encoded()).unwrap()
    };
    let write = |records, done| {
        serde_json::to_value(SubmitMembershipProof::Write {
            proof_token: token.clone(),
            records,
            done,
        })
        .unwrap()
    };
    session
        .dispatch("submitMembershipProof", write(vec![encoded(child)], false))
        .unwrap();
    assert!(a.selected().history().member(e.member()).is_none());
    session
        .dispatch("submitMembershipProof", write(vec![encoded(parent)], false))
        .unwrap();
    let result = session
        .dispatch("submitMembershipProof", write(vec![encoded(child)], true))
        .unwrap();
    assert_eq!(result["complete"], true);
    assert!(a.selected().history().is_active(e.member()));
    assert_eq!(
        session
            .dispatch("openHistory", json!({"frontier":null}))
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
}

#[tokio::test(start_paused = true)]
async fn http1_requests_wait_for_dispatcher_readiness_within_the_send_deadline() {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    use hyper_util::rt::TokioIo;
    let request = || {
        hyper::Request::builder()
            .uri("/synthetic")
            .header("host", "synthetic")
            .body(Full::new(Bytes::new()))
            .unwrap()
    };
    let (client, server) = tokio::io::duplex(4096);
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(client))
        .await
        .unwrap();
    let first = sender.send_request(request());
    assert!(!sender.is_ready());
    let (response, driver, serving) = {
        let pending = transport::send_request(&mut sender, request());
        tokio::pin!(pending);
        // Occupy the dispatch slot before driving the connection. A second direct
        // send fails deterministically with "connection was not ready".
        assert!(futures::poll!(pending.as_mut()).is_pending());
        let driver = tokio::spawn(connection);
        let serving = tokio::spawn(async move {
            hyper::server::conn::http1::Builder::new()
                .serve_connection(
                    TokioIo::new(server),
                    hyper::service::service_fn(|_| async {
                        Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(
                            Bytes::from_static(b"synthetic response"),
                        )))
                    }),
                )
                .await
        });
        let (first, response) = tokio::join!(
            async {
                first
                    .await
                    .unwrap()
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
            },
            pending
        );
        assert_eq!(first, "synthetic response");
        (response.unwrap(), driver, serving)
    };
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "synthetic response"
    );
    drop(sender);
    driver.abort();
    serving.abort();

    let (idle, _peer) = tokio::io::duplex(4096);
    let (mut sender, _connection) = hyper::client::conn::http1::handshake(TokioIo::new(idle))
        .await
        .unwrap();
    let began = Instant::now();
    assert_eq!(
        transport::send_request(&mut sender, request())
            .await
            .unwrap_err()
            .code,
        "UNAVAILABLE"
    );
    assert_eq!(began.elapsed(), Duration::from_secs(60));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retained_old_key_has_only_its_proof_binding_after_fresh_admission() {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    use hyper_util::rt::TokioIo;
    let (a, b, c) = common();
    let old_member = a.member();
    let old_key = a.public();
    let network = a.selected().history().network_id();
    a.change(Change::Leave);
    c.catch_up(&a);
    let server = a.listen().await;
    c.admit(&a);
    assert_ne!(a.member(), old_member);
    assert_ne!(a.public(), old_key);
    let recovered = PeerClient::connect(b.repo(), &endpoint(&server), old_member, true)
        .await
        .unwrap();
    assert_eq!(recovered.hello.membership_id, Some(a.member()));
    assert_eq!(recovered.remote_key, a.public());
    assert!(b.selected().history().is_active(a.member()));
    assert!(!b.selected().history().is_active(old_member));
    drop(recovered);
    let current = a.selected().history().snapshot().clone();
    let tls = tls::client(b.repo(), b.public(), Some(old_key)).unwrap();
    let tcp = tokio::net::TcpStream::connect(server.local_addr())
        .await
        .unwrap();
    let stream = tokio_rustls::TlsConnector::from(tls)
        .connect(
            rustls::pki_types::ServerName::try_from(tls::selector(old_key)).unwrap(),
            tcp,
        )
        .await
        .unwrap();
    assert_eq!(
        tls::public_key(&stream.get_ref().1.peer_certificates().unwrap()[0]).unwrap(),
        old_key
    );
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    let hello = Hello::Proof {
        protocol_version: 1,
        network_id: network,
        membership_id: Some(b.member()),
        purpose: ProofPurpose::Exclusion,
    };
    let request = hyper::Request::builder()
        .method("POST")
        .uri("/network/v1/hello")
        .header("host", "synthetic")
        .body(Full::new(Bytes::from(serde_json::to_vec(&hello).unwrap())))
        .unwrap();
    sender.ready().await.unwrap();
    let response = sender.send_request(request).await.unwrap();
    assert_eq!(response.status(), 200);
    let response: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(response["result"]["membershipId"], old_member.to_string());
    assert_eq!(response["result"]["access"], "proofOnly");
    let request = hyper::Request::builder()
        .method("POST")
        .uri("/network/v1/openHistory")
        .header("host", "synthetic")
        .body(Full::new(Bytes::from_static(b"{\"frontier\":null}")))
        .unwrap();
    sender.ready().await.unwrap();
    assert_eq!(sender.send_request(request).await.unwrap().status(), 403);
    assert_eq!(*a.selected().history().snapshot(), current);
    task.abort();
    let d = Node::new();
    c.admit(&d);
    let mut retired = session::Session::new(
        a.repo().clone(),
        Arc::new(session::Shared::default()),
        d.public(),
        old_key,
    );
    retired
        .dispatch(
            "hello",
            serde_json::to_value(Hello::Member {
                protocol_version: 1,
                network_id: network,
                membership_id: d.member(),
                history: d.selected().history().snapshot().clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let opened = retired
        .dispatch(
            "submitMembershipProof",
            serde_json::to_value(SubmitMembershipProof::Open {
                purpose: ProofPurpose::Admission,
                membership_id: Some(d.member()),
                record_id: Some(RecordId::from_bytes(*d.member().as_bytes())),
            })
            .unwrap(),
        )
        .unwrap();
    let history = d.selected();
    let records = session::ancestor_order(history.history())
        .into_iter()
        .map(|r| serde_json::from_slice::<Value>(r.encoded()).unwrap())
        .collect();
    assert_eq!(
        retired
            .dispatch(
                "submitMembershipProof",
                serde_json::to_value(SubmitMembershipProof::Write {
                    proof_token: opened["proofToken"].as_str().unwrap().into(),
                    records,
                    done: true
                })
                .unwrap()
            )
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
    assert!(a.selected().history().member(d.member()).is_none());
    server.shutdown().await;
    let shared = Arc::new(
        session::Shared::with_capacity(PeerCapacity {
            total_working_bytes: 1,
            ..Default::default()
        })
        .unwrap(),
    );
    let mut session = session::Session::new(c.repo().clone(), shared, b.public(), c.public());
    session
        .dispatch(
            "hello",
            serde_json::to_value(Hello::Member {
                protocol_version: 1,
                network_id: network,
                membership_id: b.member(),
                history: b.selected().history().snapshot().clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let before = c.selected().history().snapshot().clone();
    assert_eq!(
        session
            .dispatch("openHistory", json!({"frontier":null}))
            .unwrap_err()
            .code,
        "RESOURCE_LIMIT"
    );
    assert_eq!(*c.selected().history().snapshot(), before);
}

#[tokio::test]
async fn sealed_upgrade_blocks_peer_admission_and_shutdown_drains_started_work() {
    let (a, b, _c) = common();
    config::secure_directory(&a.root.join("upgrade")).unwrap();
    let transaction = crate::maintenance::Transaction {
        contract_version: "v1".into(),
        token: uuid::Uuid::new_v4().to_string(),
        executable: a.root.join("synthetic-current"),
        previous: a.root.join("synthetic-previous"),
        previous_hash: "a".repeat(64),
        candidate_hash: "b".repeat(64),
        previous_version: "0.0.0-synthetic.0".into(),
        version: "0.2.0".into(),
        was_running: false,
        config_hash: "c".repeat(64),
        database_hash: None,
        state_schema: None,
        key_hashes: None,
    };
    config::write_json(&a.root.join("upgrade/transaction.json"), &transaction).unwrap();
    let mut shared = session::Shared::default();
    shared.maintenance = Some(Arc::new(
        crate::maintenance::Maintenance::open(&a.root).unwrap(),
    ));
    let shared = Arc::new(shared);
    let before = a.selected().history().snapshot().clone();
    let mut peer = session::Session::new(a.repo().clone(), shared, b.public(), a.public());
    assert_eq!(
        peer.dispatch(
            "hello",
            serde_json::to_value(Hello::Member {
                protocol_version: 1,
                network_id: b.selected().history().network_id(),
                membership_id: b.member(),
                history: b.selected().history().snapshot().clone()
            })
            .unwrap()
        )
        .unwrap_err()
        .code,
        "UNAVAILABLE"
    );
    assert_eq!(*a.selected().history().snapshot(), before);
    let shared = Arc::new(session::Shared::default());
    let work = shared.begin_work().unwrap();
    shared.stop();
    assert!(shared.begin_work().is_err());
    let waiting = shared.clone();
    let drained = tokio::spawn(async move {
        waiting.drain().await;
    });
    tokio::task::yield_now().await;
    assert!(!drained.is_finished());
    drop(work);
    tokio::time::timeout(Duration::from_secs(2), drained)
        .await
        .unwrap()
        .unwrap();
}

fn local(node: &Node, operation: &str, mut input: Value) -> Value {
    if !matches!(
        operation,
        "getNetwork" | "listNetworkJoins" | "listNetworkMembers"
    ) {
        input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    }
    node.repo()
        .local_network_operation(operation, &input)
        .unwrap()
}
async fn lifecycle_join(
    issuer: &Node,
    joiner: &Node,
    runtime: &PeerRuntime,
    finish: bool,
) -> AttemptId {
    let issued = local(issuer, "createInvitation", json!({}));
    let invitation =
        crate::network::lifecycle::Invitation::parse(issued["invitation"].as_str().unwrap())
            .unwrap();
    let intent = joiner.intent("joinNetwork");
    let id = joiner
        .repo()
        .prepare_join_attempt(
            &intent,
            &invitation.public(),
            *invitation.secret.as_bytes(),
            intent.operation_id.unwrap(),
        )
        .unwrap();
    let shared = Arc::new(session::Shared::default());
    super::lifecycle::recover_join(joiner.repo(), &shared, id)
        .await
        .unwrap();
    let pending = local(issuer, "listNetworkJoins", json!({}));
    assert_eq!(pending["joins"].as_array().unwrap().len(), 1);
    let proof = &pending["joins"][0];
    local(
        issuer,
        "confirmNetworkJoin",
        json!({"joinAttemptId":proof["joinAttemptId"],"publicKey":proof["publicKey"],"decision":"allow"}),
    );
    if finish {
        super::lifecycle::recover_join(joiner.repo(), &shared, id)
            .await
            .unwrap();
    }
    assert!(runtime.local_addr().port() > 0);
    id
}
async fn lifecycle_listener(node: &Node) -> PeerRuntime {
    let runtime = node.listen().await;
    node.repo()
        .configure_peer(&PeerSettings {
            listen_endpoint: Some(endpoint(&runtime)),
            advertised_endpoints: vec![endpoint(&runtime)],
        })
        .unwrap();
    runtime
}
#[tokio::test]
async fn lifecycle_bootstrap_lost_reply_founder_exit_and_fresh_invitation() {
    let a = Node::new();
    let mut b = Node::new();
    let c = Node::new();
    let d = Node::new();
    local(
        &a,
        "createNetwork",
        json!({"networkName":"Synthetic lifecycle"}),
    );
    let ra = lifecycle_listener(&a).await;
    let id = lifecycle_join(&a, &b, &ra, false).await;
    // Issuer committed; joiner still uncertain and has not selected a Network.
    assert!(b.repo().current_selection().unwrap().is_none());
    b.restart();
    super::lifecycle::recover_join(b.repo(), &Arc::new(session::Shared::default()), id)
        .await
        .unwrap();
    assert_eq!(b.repo().network_status().unwrap()["localStatus"], "active");
    let rb = lifecycle_listener(&b).await;
    lifecycle_join(&a, &c, &ra, true).await;
    sync(&b, &a, &ra).await.unwrap();
    // Fixed old-generation endpoints are retained before self-exit.
    a.repo()
        .set_peer_address(
            a.selected().history().network_id(),
            b.member(),
            &endpoint(&rb),
        )
        .unwrap();
    local(&a, "leaveNetwork", json!({}));
    assert_eq!(a.repo().network_status().unwrap()["localStatus"], "left");
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let status = a.repo().network_status().unwrap();
            if status["dissemination"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["membershipId"] == json!(b.member()) && t["status"] == "confirmed")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(!b.selected().history().is_active(a.member()));
    ra.shutdown().await;
    lifecycle_join(&b, &d, &rb, true).await;
    assert!(d.selected().history().is_active(d.member()));
    assert!(!d.selected().history().is_active(a.member()));
    assert_eq!(
        a.repo().network_status().unwrap()["dissemination"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["status"] == "confirmed")
            .count(),
        1
    );
    rb.shutdown().await;
}
#[tokio::test]
async fn lifecycle_offline_exits_restart_and_rebased_departure() {
    let (mut a, b, c) = common();
    // A has unseen admissions which conflict with B withdrawing their author C.
    let d = Node::new();
    c.admit(&d);
    a.catch_up(&c);
    b.change(Change::Remove(c.member()));
    let rb = lifecycle_listener(&b).await;
    a.repo()
        .set_peer_address(
            a.selected().history().network_id(),
            b.member(),
            &endpoint(&rb),
        )
        .unwrap();
    let request = json!({"requestId":"synthetic-offline-exit"});
    a.repo()
        .local_network_operation("leaveNetwork", &request)
        .unwrap();
    a.restart();
    let task = a
        .repo()
        .departure_tasks()
        .unwrap()
        .into_iter()
        .find(|t| t.recipient == b.member())
        .unwrap();
    super::lifecycle::deliver_at(
        a.repo(),
        &Arc::new(session::Shared::default()),
        &task,
        &endpoint(&rb),
    )
    .await
    .unwrap();
    assert!(!b.selected().history().is_active(a.member()));
    assert!(!b.selected().history().is_active(c.member()));
    assert!(!b.selected().history().is_active(d.member()));
    a.repo()
        .local_network_operation("leaveNetwork", &request)
        .unwrap();
    assert_eq!(a.repo().network_status().unwrap()["localStatus"], "left");
    rb.shutdown().await;
    let (a, b, _) = common();
    let ra = lifecycle_listener(&a).await;
    let rb = lifecycle_listener(&b).await;
    a.repo()
        .set_peer_address(
            a.selected().history().network_id(),
            b.member(),
            &endpoint(&rb),
        )
        .unwrap();
    local(&a, "leaveNetwork", json!({}));
    local(&b, "leaveNetwork", json!({}));
    let task = a
        .repo()
        .departure_tasks()
        .unwrap()
        .into_iter()
        .find(|t| t.recipient == b.member())
        .unwrap();
    super::lifecycle::deliver_at(
        a.repo(),
        &Arc::new(session::Shared::default()),
        &task,
        &endpoint(&rb),
    )
    .await
    .unwrap();
    assert_eq!(b.repo().network_status().unwrap()["localStatus"], "left");
    ra.shutdown().await;
    rb.shutdown().await;
}

#[tokio::test]
async fn lifecycle_unknown_departing_generation_proves_claim_without_branch_adoption() {
    let (a, b, c) = common();
    let d = Node::new();
    c.admit(&d);
    a.change(Change::Remove(c.member()));
    b.catch_up(&a);
    let before = b.selected().history().snapshot().clone();
    let rb = lifecycle_listener(&b).await;
    d.repo()
        .set_peer_address(
            d.selected().history().network_id(),
            b.member(),
            &endpoint(&rb),
        )
        .unwrap();
    local(&d, "leaveNetwork", json!({}));
    let task = d
        .repo()
        .departure_tasks()
        .unwrap()
        .into_iter()
        .find(|t| t.recipient == b.member())
        .unwrap();
    super::lifecycle::deliver_at(
        d.repo(),
        &Arc::new(session::Shared::default()),
        &task,
        &endpoint(&rb),
    )
    .await
    .unwrap();
    assert_eq!(b.selected().history().snapshot(), &before);
    assert!(b.selected().history().member(d.member()).is_none());
    assert!(
        d.repo().network_status().unwrap()["dissemination"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["membershipId"] == json!(b.member()) && t["status"] == "confirmed")
    );
    rb.shutdown().await;
}
#[tokio::test]
async fn lifecycle_denial_retry_and_public_result_recovery_without_old_issuer_key() {
    let mut a = Node::new();
    let b = Node::new();
    a.create();
    let ra = lifecycle_listener(&a).await;
    let issued = local(&a, "createInvitation", json!({}));
    let token =
        crate::network::lifecycle::Invitation::parse(issued["invitation"].as_str().unwrap())
            .unwrap();
    let request = b.intent("joinNetwork");
    let id = b
        .repo()
        .prepare_join_attempt(
            &request,
            &token.public(),
            *token.secret.as_bytes(),
            request.operation_id.unwrap(),
        )
        .unwrap();
    let shared = Arc::new(session::Shared::default());
    super::lifecycle::recover_join(b.repo(), &shared, id)
        .await
        .unwrap();
    let proof = local(&a, "listNetworkJoins", json!({}))["joins"][0].clone();
    let deny = json!({"requestId":"synthetic-denial","joinAttemptId":proof["joinAttemptId"],"publicKey":proof["publicKey"],"decision":"deny"});
    a.repo()
        .local_network_operation("confirmNetworkJoin", &deny)
        .unwrap();
    ra.shutdown().await;
    a.restart();
    a.repo()
        .local_network_operation("confirmNetworkJoin", &deny)
        .unwrap();
    assert_eq!(
        a.repo()
            .join_details(&json!({"joinAttemptId":id.attempt}))
            .unwrap()["publicKey"],
        proof["publicKey"]
    );
    let ra = PeerRuntime::start(a.repo().clone()).await.unwrap().unwrap();
    super::lifecycle::recover_join(b.repo(), &shared, id)
        .await
        .unwrap();
    assert_eq!(b.repo().join_material(id).unwrap().0.status, "denied");
    assert!(b.repo().current_selection().unwrap().is_none());
    ra.shutdown().await;
    let a = Node::new();
    let b = Node::new();
    let c = Node::new();
    a.create();
    a.admit(&b);
    let ra = lifecycle_listener(&a).await;
    let id = lifecycle_join(&a, &c, &ra, false).await;
    b.catch_up(&a);
    b.change(Change::Remove(a.member()));
    a.catch_up(&b);
    let selection_id = a.selected().selection_id().to_string();
    let key: String = a
        .repo()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT key_id FROM network_selections WHERE selection_id=?",
            [selection_id],
            |r| r.get(0),
        )
        .unwrap();
    a.repo().cleanup_key(&key).unwrap();
    super::lifecycle::recover_join(c.repo(), &Arc::new(session::Shared::default()), id)
        .await
        .unwrap();
    assert_eq!(c.repo().join_material(id).unwrap().0.status, "admitted");
    assert!(c.selected().history().is_active(c.member()));
    ra.shutdown().await;
}

#[tokio::test]
async fn lifecycle_expiry_is_rechecked_at_confirmation_without_consuming_invitation() {
    let a = Node::new();
    let b = Node::new();
    a.create();
    let ra = lifecycle_listener(&a).await;
    let issued = a
        .repo()
        .create_invitation(&a.intent("createInvitation"), vec![endpoint(&ra)])
        .unwrap();
    let selection_id = a.selected().selection_id().to_string();
    let key: String = a
        .repo()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT key_id FROM network_selections WHERE selection_id=?",
            [selection_id],
            |r| r.get(0),
        )
        .unwrap();
    let mut body = issued.invitation.body;
    body.issued_at = (chrono::Utc::now() - chrono::Duration::seconds(60))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    body.expires_at = (chrono::Utc::now() + chrono::Duration::seconds(3))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let signed = crate::network::keys::KeyFiles::new(&a.repo().state)
        .sign_invitation(&key, body)
        .unwrap();
    a.repo().transaction(|tx|{tx.execute("UPDATE network_invitations SET public_invitation_json=?,expires_at=? WHERE invitation_id=?",rusqlite::params![serde_jcs::to_string(&signed)?,signed.body.expires_at,signed.body.invitation_id.as_bytes().as_slice()])?;Ok(())}).unwrap();
    let request = b.intent("joinNetwork");
    let id = b
        .repo()
        .prepare_join_attempt(
            &request,
            &signed,
            **issued.secret.as_ref().unwrap(),
            request.operation_id.unwrap(),
        )
        .unwrap();
    super::lifecycle::recover_join(b.repo(), &Arc::new(session::Shared::default()), id)
        .await
        .unwrap();
    let p = local(&a, "listNetworkJoins", json!({}))["joins"][0].clone();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let confirm = json!({"requestId":"synthetic-expired-confirmation","joinAttemptId":p["joinAttemptId"],"publicKey":p["publicKey"],"decision":"allow"});
    assert!(
        a.repo()
            .local_network_operation("confirmNetworkJoin", &confirm)
            .is_err()
    );
    a.repo().expire_invitations().unwrap();
    let status: String = a
        .repo()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT status FROM network_invitations WHERE invitation_id=?",
            [signed.body.invitation_id.as_bytes().as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "expired");
    assert_eq!(a.selected().history().active_members().count(), 1);
    assert_eq!(b.repo().join_material(id).unwrap().0.status, "uncertain");
    ra.shutdown().await;
}
