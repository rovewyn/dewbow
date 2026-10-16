use super::*;
use crate::{config, store::Store};
use dewbow_protocol::network::*;
use serde_json::json;
use std::{fs, path::PathBuf};

struct Node {
    root: PathBuf,
    store: Store,
}
impl Node {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dewbow-network-state-{}", dewbow_protocol::id()));
        config::init(
            &root,
            Some(PathBuf::from("/synthetic/codex")),
            Some(PathBuf::from("/synthetic/codex-home")),
            Some(3000),
        )
        .unwrap();
        let store = Store::open(&root).unwrap();
        Self { root, store }
    }
    fn restart(&mut self) {
        self.store = Store::open(&self.root).unwrap();
    }
    fn intent(&self, name: &str, id: u8) -> Intent {
        Intent {
            request_id: format!("synthetic-{name}-{id}"),
            operation: name.into(),
            fingerprint: [id; 32],
            operation_id: Some(Nonce::from_bytes([id; 32])),
        }
    }
    fn create(&self) {
        self.store
            .network
            .create_network(
                &self.intent("createNetwork", 1),
                "Synthetic Network".into(),
                Nonce::from_bytes([1; 32]),
            )
            .unwrap();
    }
}
fn proposal(history: &VerifiedHistory, record: &SignedRecord) -> Proposal {
    match consider(history, record, &[], Limits::default()).unwrap() {
        Decision::Proposed(value) => value,
        _ => panic!("Expected a proposed transition"),
    }
}
fn join(a: &Node, b: &Node) -> (AttemptId, PublicInvitation) {
    let issued = a
        .store
        .network
        .create_invitation(
            &a.intent("createInvitation", 2),
            vec!["https://192.0.2.1:7443".into()],
        )
        .unwrap();
    let attempt = b
        .store
        .network
        .prepare_join_attempt(
            &b.intent("joinNetwork", 3),
            &issued.invitation,
            **issued.secret.as_ref().unwrap(),
            Nonce::from_bytes([3; 32]),
        )
        .unwrap();
    let current = a.store.network.current_selection().unwrap().unwrap();
    b.store
        .network
        .prepare_join_proof(attempt, current.history())
        .unwrap();
    let proof = b.store.network.begin_redemption(attempt).unwrap();
    let record = a
        .store
        .network
        .sign_active_change(
            &current.selection_id().to_string(),
            Nonce::from_bytes([4; 32]),
            Change::Admit(Box::new(proof.clone())),
        )
        .unwrap();
    let proposed = proposal(current.history(), &record);
    a.store
        .network
        .commit_confirmed_admission(
            &a.intent("confirmNetworkJoin", 4),
            &proof,
            &proposed,
            record.id(),
        )
        .unwrap();
    b.store
        .network
        .finish_join(attempt, proposed.result().clone(), record.id())
        .unwrap();
    (attempt, issued.invitation)
}
fn remove(node: Node) {
    let root = node.root.clone();
    drop(node);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn admission_restart_and_expired_retry_preserve_identity_and_results() {
    let a = Node::new();
    let mut b = Node::new();
    a.create();
    let host = config::load(&b.root).unwrap().host_id;
    let (attempt, _) = join(&a, &b);
    let original = b.store.network.current_selection().unwrap().unwrap();
    b.restart();
    assert_eq!(
        b.store
            .network
            .current_selection()
            .unwrap()
            .unwrap()
            .local_member(),
        original.local_member()
    );
    assert_eq!(config::load(&b.root).unwrap().host_id, host);
    assert!(
        !b.store
            .network
            .expire_join(attempt, chrono::Utc::now() + chrono::Duration::days(1))
            .unwrap()
    );
    let result = b
        .store
        .network
        .request_result(&b.intent("joinNetwork", 3))
        .unwrap()
        .unwrap();
    assert!(result.get("recordId").is_some());
    remove(a);
    remove(b);
}

#[test]
fn definitely_unsent_joins_expire_but_uncertain_joins_retain_their_key() {
    let a = Node::new();
    a.create();
    for phase in ["prepared", "proofReady", "uncertain"] {
        let mut b = Node::new();
        let issued = a
            .store
            .network
            .create_invitation(
                &a.intent(
                    "createInvitation",
                    if phase == "prepared" {
                        10
                    } else if phase == "proofReady" {
                        11
                    } else {
                        12
                    },
                ),
                vec![],
            )
            .unwrap();
        let id = b
            .store
            .network
            .prepare_join_attempt(
                &b.intent("joinNetwork", 3),
                &issued.invitation,
                **issued.secret.as_ref().unwrap(),
                Nonce::from_bytes([3; 32]),
            )
            .unwrap();
        if phase != "prepared" {
            b.store
                .network
                .prepare_join_proof(
                    id,
                    a.store
                        .network
                        .current_selection()
                        .unwrap()
                        .unwrap()
                        .history(),
                )
                .unwrap();
        }
        if phase == "uncertain" {
            b.store.network.begin_redemption(id).unwrap();
        }
        b.restart();
        let expired = b
            .store
            .network
            .expire_join(id, chrono::Utc::now() + chrono::Duration::days(1))
            .unwrap();
        assert_eq!(expired, phase != "uncertain");
        let key: String = b
            .store
            .network
            .db
            .lock()
            .unwrap()
            .query_row("SELECT key_id FROM network_join_attempts", [], |r| r.get(0))
            .unwrap();
        if expired {
            assert_eq!(
                b.store
                    .network
                    .request_result(&b.intent("joinNetwork", 3))
                    .unwrap()
                    .unwrap()["code"],
                "INVITATION_EXPIRED"
            );
            b.store.network.cleanup_key(&key).unwrap();
            b.restart();
            assert!(
                !b.root
                    .join("network-keys")
                    .join(format!("{key}.pk8"))
                    .exists()
            );
            assert!(b.store.network.begin_redemption(id).is_err());
            b.store
                .network
                .prepare_join_attempt(
                    &b.intent("joinNetwork", 9),
                    &issued.invitation,
                    **issued.secret.as_ref().unwrap(),
                    Nonce::from_bytes([9; 32]),
                )
                .unwrap();
        } else {
            assert!(b.store.network.cleanup_key(&key).is_err());
            assert!(
                b.store
                    .network
                    .prepare_join_attempt(
                        &b.intent("joinNetwork", 9),
                        &issued.invitation,
                        **issued.secret.as_ref().unwrap(),
                        Nonce::from_bytes([9; 32])
                    )
                    .is_err()
            );
            assert!(b.store.network.begin_redemption(id).is_ok());
        }
        remove(b);
    }
    remove(a);
}

#[test]
fn offline_exit_tasks_survive_new_selection_and_cannot_release_the_old_key() {
    let a = Node::new();
    let b = Node::new();
    a.create();
    join(&a, &b);
    let selected = a.store.network.current_selection().unwrap().unwrap();
    let id = selected.selection_id().to_string();
    let record = a
        .store
        .network
        .sign_active_change(&id, Nonce::from_bytes([5; 32]), Change::Leave)
        .unwrap();
    let proposed = proposal(selected.history(), &record);
    let result = a
        .store
        .network
        .commit_local_change(&a.intent("leaveNetwork", 5), &proposed, record.id())
        .unwrap();
    assert_eq!(
        a.store
            .network
            .commit_local_change(&a.intent("leaveNetwork", 5), &proposed, record.id())
            .unwrap(),
        result
    );
    let old_key: String = a
        .store
        .network
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT key_id FROM network_selections WHERE selection_id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(a.store.network.cleanup_key(&old_key).is_err());
    a.store
        .network
        .create_network(
            &a.intent("createNetwork", 6),
            "Another synthetic Network".into(),
            Nonce::from_bytes([6; 32]),
        )
        .unwrap();
    let db = a.store.network.db.lock().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM network_departure_tasks WHERE status='pending'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(db);
    assert!(a.store.network.cleanup_key(&old_key).is_err());
    remove(a);
    remove(b);
}

#[test]
fn scoped_receipts_and_original_targets_survive_restart_and_local_cleanup() {
    let mut a = Node::new();
    let b = Node::new();
    a.create();
    join(&a, &b);
    let scope = ReceiptScope {
        network_id: a
            .store
            .network
            .current_selection()
            .unwrap()
            .unwrap()
            .history()
            .network_id(),
        source_host_id: a.store.network.host.unwrap(),
        request_id: "same-client-id".into(),
    };
    a.store
        .network
        .bind_outbound(
            &scope,
            b.store.network.host.unwrap(),
            "sendMessage",
            [8; 32],
        )
        .unwrap();
    a.store.network.begin_dispatch(&scope).unwrap();
    a.restart();
    assert!(
        a.store
            .network
            .bind_outbound(
                &scope,
                HostId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
                "sendMessage",
                [8; 32]
            )
            .is_err()
    );
    for (index, source) in [
        scope.source_host_id,
        HostId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
    ]
    .into_iter()
    .enumerate()
    {
        let scope = ReceiptScope {
            source_host_id: source,
            ..scope.clone()
        };
        let receipt = json!({"requestId":scope.request_id,"commandId":format!("synthetic-command-{index}"),"operation":"sendMessage","sessionId":"synthetic-session","turnId":null,"status":"unknown","createdAt":dewbow_protocol::now(),"error":null,"fingerprint":"08".repeat(32)});
        b.store
            .network
            .retain_receipt(&scope, "sendMessage", [8; 32], &receipt, None)
            .unwrap();
        assert!(
            b.store
                .network
                .retain_receipt(&scope, "sendMessage", [9; 32], &receipt, None)
                .is_err()
        );
    }
    b.store
        .prune_operations(chrono::Utc::now() + chrono::Duration::days(3))
        .unwrap();
    assert_eq!(
        b.store
            .network
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM network_request_receipts", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        2
    );
    remove(a);
    remove(b);
}

#[test]
fn malformed_history_and_missing_active_keys_are_rejected_before_database_writes() {
    let node = Node::new();
    node.create();
    let root = node.root.clone();
    let db = node.store.network.db.clone();
    drop(node);
    {
        let db = db.lock().unwrap();
        db.pragma_update(None, "journal_mode", "DELETE").unwrap();
        db.execute("UPDATE network_records SET envelope_json=json_set(envelope_json,'$.unknown','synthetic-private-value')",[]).unwrap();
    }
    drop(db);
    let before = fs::read(root.join("daemon.sqlite")).unwrap();
    assert!(Store::open(&root).is_err());
    assert_eq!(fs::read(root.join("daemon.sqlite")).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
    let node = Node::new();
    node.create();
    let key = fs::read_dir(node.root.join("network-keys"))
        .unwrap()
        .find_map(|e| {
            let p = e.unwrap().path();
            (p.extension().is_some_and(|e| e == "pk8")).then_some(p)
        })
        .unwrap();
    fs::remove_file(key).unwrap();
    assert!(Store::open(&node.root).is_err());
    remove(node);
}

#[test]
fn key_publication_and_deletion_interruptions_never_create_authority() {
    for phase in ["keyStaged", "keyPublished"] {
        let node = Node::new();
        migration::fault_at(Some(phase));
        assert!(
            node.store
                .network
                .create_network(
                    &node.intent("createNetwork", 1),
                    "Synthetic".into(),
                    Nonce::from_bytes([1; 32])
                )
                .is_err()
        );
        migration::fault_at(None);
        node.store.network.resume_key_deletions().unwrap();
        assert!(node.store.network.current_selection().unwrap().is_none());
        assert_eq!(
            fs::read_dir(node.root.join("network-keys/quarantine"))
                .unwrap()
                .count(),
            1
        );
        node.create();
        remove(node);
    }
    for phase in ["keyDeletePending", "keyFileDeleted"] {
        let mut node = Node::new();
        node.create();
        let selected = node.store.network.current_selection().unwrap().unwrap();
        let record = node
            .store
            .network
            .sign_active_change(
                &selected.selection_id().to_string(),
                Nonce::from_bytes([5; 32]),
                Change::Leave,
            )
            .unwrap();
        node.store
            .network
            .commit_local_change(
                &node.intent("leaveNetwork", 5),
                &proposal(selected.history(), &record),
                record.id(),
            )
            .unwrap();
        let key: String = node
            .store
            .network
            .db
            .lock()
            .unwrap()
            .query_row("SELECT key_id FROM network_keys", [], |r| r.get(0))
            .unwrap();
        migration::fault_at(Some(phase));
        assert!(node.store.network.cleanup_key(&key).is_err());
        migration::fault_at(None);
        node.restart();
        node.store.network.resume_key_deletions().unwrap();
        assert!(
            !node
                .root
                .join("network-keys")
                .join(format!("{key}.pk8"))
                .exists()
        );
        assert_eq!(
            node.store
                .network
                .db
                .lock()
                .unwrap()
                .query_row("SELECT storage_status FROM network_keys", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "deleted"
        );
        assert!(
            node.store
                .network
                .sign_active_change(
                    &selected.selection_id().to_string(),
                    Nonce::from_bytes([6; 32]),
                    Change::Leave
                )
                .is_err()
        );
        remove(node);
    }
}

#[cfg(unix)]
#[test]
fn interrupted_hard_link_deletion_resumes_only_for_the_same_file() {
    let node = Node::new();
    let files = keys::KeyFiles::new(&node.root);
    let (id, public) = files.create().unwrap();
    let path = node.root.join("network-keys").join(format!("{id}.pk8"));
    let tomb = node
        .root
        .join("network-keys")
        .join(format!(".{id}.deleted"));
    fs::hard_link(&path, &tomb).unwrap();
    files.delete(&id, public).unwrap();
    assert!(!path.exists() && !tomb.exists());
    let (id, public) = files.create().unwrap();
    let path = node.root.join("network-keys").join(format!("{id}.pk8"));
    let tomb = node
        .root
        .join("network-keys")
        .join(format!(".{id}.deleted"));
    fs::copy(&path, &tomb).unwrap();
    assert!(files.delete(&id, public).is_err());
    assert!(path.exists() && tomb.exists());
    remove(node);
}

#[test]
fn expiry_and_dispatch_have_one_serialized_winner() {
    let a = Node::new();
    a.create();
    let b = Node::new();
    let issued = a
        .store
        .network
        .create_invitation(&a.intent("createInvitation", 2), vec![])
        .unwrap();
    let id = b
        .store
        .network
        .prepare_join_attempt(
            &b.intent("joinNetwork", 3),
            &issued.invitation,
            **issued.secret.as_ref().unwrap(),
            Nonce::from_bytes([3; 32]),
        )
        .unwrap();
    b.store
        .network
        .prepare_join_proof(
            id,
            a.store
                .network
                .current_selection()
                .unwrap()
                .unwrap()
                .history(),
        )
        .unwrap();
    let (expired, sent) = std::thread::scope(|s| {
        let expiry = s.spawn(|| {
            b.store
                .network
                .expire_join(id, chrono::Utc::now() + chrono::Duration::days(1))
                .unwrap()
        });
        let send = s.spawn(|| b.store.network.begin_redemption(id).is_ok());
        (expiry.join().unwrap(), send.join().unwrap())
    });
    assert_ne!(expired, sent);
    assert_eq!(
        b.store
            .network
            .db
            .lock()
            .unwrap()
            .query_row("SELECT status FROM network_join_attempts", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        if expired { "expired" } else { "uncertain" }
    );
    remove(a);
    remove(b);
}

#[test]
fn departure_ack_is_scoped_and_inactive_exit_creates_no_new_record() {
    let mut a = Node::new();
    let b = Node::new();
    a.create();
    join(&a, &b);
    let selected = a.store.network.current_selection().unwrap().unwrap();
    let record = a
        .store
        .network
        .sign_active_change(
            &selected.selection_id().to_string(),
            Nonce::from_bytes([5; 32]),
            Change::Leave,
        )
        .unwrap();
    let next = proposal(selected.history(), &record);
    a.store
        .network
        .commit_local_change(&a.intent("leaveNetwork", 5), &next, record.id())
        .unwrap();
    let key: String = a
        .store
        .network
        .db
        .lock()
        .unwrap()
        .query_row("SELECT key_id FROM network_keys", [], |r| r.get(0))
        .unwrap();
    a.store
        .network
        .detach_inactive(&a.intent("leaveNetwork", 6))
        .unwrap();
    assert_eq!(
        a.store
            .network
            .current_selection()
            .unwrap()
            .unwrap()
            .history()
            .snapshot()
            .record_count,
        next.result().snapshot().record_count
    );
    let recipient = b.store.network.current_selection().unwrap().unwrap();
    b.store
        .network
        .commit_adoption(
            &recipient.selection_id().to_string(),
            &proposal(recipient.history(), &record),
        )
        .unwrap();
    let ack = b
        .store
        .network
        .sign_departure_ack(
            &recipient.selection_id().to_string(),
            record.id(),
            next.result(),
        )
        .unwrap();
    let recipient = b.store.network.current_selection().unwrap().unwrap();
    let mut altered = ack.clone();
    altered.body.recipient_membership_id = selected.local_member();
    assert!(
        a.store
            .network
            .confirm_departure(&altered, recipient.history())
            .is_err()
    );
    a.store
        .network
        .confirm_departure(&ack, recipient.history())
        .unwrap();
    a.restart();
    a.store.network.cleanup_key(&key).unwrap();
    remove(a);
    remove(b);
}

#[test]
fn issuer_results_survive_lost_replies_exit_and_explicit_denial() {
    let mut a = Node::new();
    let mut b = Node::new();
    a.create();
    let (attempt, _) = join(&a, &b);
    let proof: String = b
        .store
        .network
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT join_proof_json FROM network_join_attempts",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let proof = decode_join_proof(proof.as_bytes()).unwrap();
    let selected = a.store.network.current_selection().unwrap().unwrap();
    let record = a
        .store
        .network
        .sign_active_change(
            &selected.selection_id().to_string(),
            Nonce::from_bytes([5; 32]),
            Change::Leave,
        )
        .unwrap();
    a.store
        .network
        .commit_local_change(
            &a.intent("leaveNetwork", 5),
            &proposal(selected.history(), &record),
            record.id(),
        )
        .unwrap();
    a.restart();
    b.restart();
    let IssuerJoinResult::Admitted(original) =
        a.store.network.issuer_join_result(&proof).unwrap().unwrap()
    else {
        panic!("Lost admission result");
    };
    let refs = b
        .store
        .network
        .request_result(&b.intent("joinNetwork", 3))
        .unwrap()
        .unwrap();
    assert_eq!(refs["recordId"], json!(original.id()));
    let mut changed = a.intent("confirmNetworkJoin", 4);
    changed.fingerprint = [9; 32];
    assert!(
        a.store
            .network
            .commit_confirmed_admission(
                &changed,
                &proof,
                &proposal(selected.history(), &record),
                original.id()
            )
            .is_err()
    );
    b.store
        .network
        .finish_join(attempt, selected.history().clone(), original.id())
        .unwrap();
    remove(a);
    remove(b);

    let mut a = Node::new();
    let mut b = Node::new();
    a.create();
    let issued = a
        .store
        .network
        .create_invitation(&a.intent("createInvitation", 2), vec![])
        .unwrap();
    let id = b
        .store
        .network
        .prepare_join_attempt(
            &b.intent("joinNetwork", 3),
            &issued.invitation,
            **issued.secret.as_ref().unwrap(),
            Nonce::from_bytes([3; 32]),
        )
        .unwrap();
    b.store
        .network
        .prepare_join_proof(
            id,
            a.store
                .network
                .current_selection()
                .unwrap()
                .unwrap()
                .history(),
        )
        .unwrap();
    let proof = b.store.network.begin_redemption(id).unwrap();
    a.store
        .network
        .record_join_denial(&a.intent("confirmNetworkJoin", 4), &proof)
        .unwrap();
    a.restart();
    b.restart();
    assert!(matches!(
        a.store.network.issuer_join_result(&proof).unwrap(),
        Some(IssuerJoinResult::Denied)
    ));
    a.store
        .network
        .record_join_denial(&a.intent("confirmNetworkJoin", 5), &proof)
        .unwrap();
    b.store.network.finish_join_denied(id).unwrap();
    b.restart();
    assert_eq!(
        b.store
            .network
            .request_result(&b.intent("joinNetwork", 3))
            .unwrap()
            .unwrap()["code"],
        "DENIED"
    );
    assert_eq!(
        a.store
            .network
            .db
            .lock()
            .unwrap()
            .query_row("SELECT status FROM network_invitations", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "live"
    );
    remove(a);
    remove(b);
}
