use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use dewbow_protocol::network::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn limits() -> Limits {
    Limits::default()
}
fn nonce(n: u8) -> Nonce {
    Nonce::from_bytes([n; 32])
}
fn host(n: u8) -> HostId {
    HostId::parse(&format!("00000000-0000-4000-8000-{n:012}")).unwrap()
}
struct Actor {
    host: HostId,
    key: SigningKey,
}
impl Actor {
    fn new(n: u8) -> Self {
        Self {
            host: host(n),
            key: SigningKey::from_bytes(&[n; 32]),
        }
    }
    fn public(&self) -> PublicKey {
        PublicKey::from_bytes(self.key.verifying_key().to_bytes())
    }
    fn sign(&self, prepared: PreparedRecord) -> SignedRecord {
        let signature = Signature::from_bytes(self.key.sign(prepared.signing_bytes()).to_bytes());
        prepared.finish(signature).unwrap()
    }
}
fn genesis(a: &Actor) -> VerifiedHistory {
    let record =
        a.sign(prepare_genesis(nonce(99), "Synthetic Network".into(), a.host, a.public()).unwrap());
    verify_history(record.id().into(), &[record], limits()).unwrap()
}
fn changed(
    h: &VerifiedHistory,
    a: &Actor,
    member: MembershipId,
    n: u8,
    change: Change,
) -> SignedRecord {
    match prepare_change(h, member, nonce(n), change, limits()).unwrap() {
        PreparedChange::Sign(p) => a.sign(p),
        PreparedChange::Existing(r) => r,
    }
}
fn join(
    h: &VerifiedHistory,
    issuer: MembershipId,
    a: &Actor,
    invitation: u8,
    attempt: u8,
) -> JoinProof {
    let p = prepare_join(
        h,
        issuer,
        nonce(invitation),
        nonce(attempt),
        a.host,
        a.public(),
    )
    .unwrap();
    let signature = Signature::from_bytes(a.key.sign(p.signing_bytes()).to_bytes());
    p.finish(signature).unwrap()
}
fn admission(
    h: &VerifiedHistory,
    a: &Actor,
    member: MembershipId,
    target: &Actor,
    n: u8,
) -> SignedRecord {
    changed(
        h,
        a,
        member,
        n,
        Change::Admit(Box::new(join(h, member, target, n, n.wrapping_add(100)))),
    )
}
fn proposal(h: &VerifiedHistory, record: &SignedRecord, proof: &[SignedRecord]) -> Proposal {
    match consider(h, record, proof, limits()).unwrap() {
        Decision::Proposed(p) => p,
        other => panic!("Expected proposal: {other:?}"),
    }
}
fn adopt(h: &VerifiedHistory, record: &SignedRecord) -> VerifiedHistory {
    proposal(h, record, &[]).result().clone()
}
struct Group {
    actors: Vec<Actor>,
    members: Vec<MembershipId>,
    history: VerifiedHistory,
}
fn group(count: u8) -> Group {
    let actors: Vec<_> = (1..=count).map(Actor::new).collect();
    let mut history = genesis(&actors[0]);
    let mut members = vec![MembershipId::from(RecordId::from(history.network_id()))];
    for (i, actor) in actors.iter().enumerate().skip(1) {
        let record = admission(&history, &actors[0], members[0], actor, i as u8);
        members.push(record.id().into());
        history = adopt(&history, &record);
    }
    Group {
        actors,
        members,
        history,
    }
}
fn conflict(
    h: &VerifiedHistory,
    record: &SignedRecord,
    proof: &[SignedRecord],
) -> ConflictEvidence {
    match consider(h, record, proof, limits()).unwrap() {
        Decision::HistoryConflict(witness) => witness,
        other => panic!("Expected verified conflict: {other:?}"),
    }
}
// Independent signing helper for hostile but correctly signed protocol input.
fn signed_body(body: RecordBody, actor: &Actor) -> SignedRecord {
    let label = if matches!(body, RecordBody::CreateNetwork { .. }) {
        "genesis"
    } else {
        "change"
    };
    let mut bytes = format!("dewbow.network.{label}.v1\0").into_bytes();
    bytes.extend(serde_jcs::to_vec(&body).unwrap());
    let value = json!({ "recordId": URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)), "body": body,
        "signature": URL_SAFE_NO_PAD.encode(actor.key.sign(&bytes).to_bytes()) });
    decode_record(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn bad_kind(result: Result<impl std::fmt::Debug>, kind: ErrorKind) {
    assert_eq!(result.unwrap_err().kind, kind);
}

#[test]
fn independent_vectors_and_strict_wire_validation() {
    let vectors: Value = serde_json::from_str(include_str!("fixtures/network-v1.json")).unwrap();
    let scenario = &vectors["membershipScenario"];
    let records: Vec<_> = scenario["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| decode_record(v["canonicalEnvelope"].as_str().unwrap().as_bytes()).unwrap())
        .collect();
    let expected_network = records[0].id().into();
    for (name, indices) in [
        ("initial", vec![0]),
        ("joined", vec![0, 1]),
        ("removed", vec![0, 1, 2]),
        ("departed", vec![0, 1, 3]),
        ("combined", vec![0, 1, 2, 3]),
    ] {
        let history = verify_history(
            expected_network,
            &indices
                .iter()
                .map(|i| records[*i].clone())
                .collect::<Vec<_>>(),
            limits(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(history.snapshot()).unwrap(),
            scenario["snapshots"][name]
        );
    }
    let original = verify_history(
        expected_network,
        &[records[0].clone(), records[1].clone(), records[3].clone()],
        limits(),
    )
    .unwrap();
    let recipient = verify_history(expected_network, &records[..2], limits()).unwrap();
    let PreparedDeparture::Sign(rebased) =
        prepare_departure_rebase(&original, records[3].id(), &recipient, limits()).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        dewbow_protocol::hex(rebased.signing_bytes()),
        scenario["rebasedDeparture"]["signingBytesHex"]
    );
    assert_eq!(
        Actor::new(2).sign(rebased).encoded(),
        scenario["rebasedDeparture"]["canonicalEnvelope"]
            .as_str()
            .unwrap()
            .as_bytes()
    );
    for vector in vectors["vectors"].as_array().unwrap() {
        let encoded = vector["canonicalEnvelope"].as_str().unwrap();
        let record = decode_record(encoded.as_bytes()).unwrap();
        assert_eq!(record.id().to_string(), vector["recordId"]);
        assert_eq!(record.signature().to_string(), vector["signature"]);
        let actor = Actor::new(vector["seedByte"].as_u64().unwrap() as u8);
        let p = prepare_genesis(
            Nonce::parse(vector["body"]["nonce"].as_str().unwrap()).unwrap(),
            vector["body"]["networkName"].as_str().unwrap().into(),
            actor.host,
            actor.public(),
        )
        .unwrap();
        assert_eq!(
            dewbow_protocol::hex(p.signing_bytes()),
            vector["signingBytesHex"]
        );
        assert_eq!(actor.sign(p).encoded(), record.encoded());
        verify_history(record.id().into(), std::slice::from_ref(&record), limits()).unwrap();
        let pretty =
            serde_json::to_string_pretty(&serde_json::from_str::<Value>(encoded).unwrap()).unwrap();
        assert_eq!(decode_record(pretty.as_bytes()).unwrap(), record);
        let duplicate = encoded.replacen("\"body\":", "\"recordId\":\"duplicate\",\"body\":", 1);
        bad_kind(decode_record(duplicate.as_bytes()), ErrorKind::InvalidInput);
        let nested_duplicate = encoded.replacen("\"kind\":", "\"protocolVersion\":1,\"kind\":", 1);
        bad_kind(
            decode_record(nested_duplicate.as_bytes()),
            ErrorKind::InvalidInput,
        );
        for field in [
            "extra",
            "publicKey",
            "hostId",
            "nonce",
            "protocolVersion",
            "networkName",
        ] {
            let mut value: Value = serde_json::from_str(encoded).unwrap();
            value["body"][field] = match field {
                "publicKey" => json!(format!("{}=", vector["body"][field].as_str().unwrap())),
                "hostId" => json!("not-a-canonical-uuid"),
                "nonce" => json!("short"),
                "protocolVersion" => json!(1.0),
                "networkName" => Value::Null,
                _ => json!("unexpected"),
            };
            bad_kind(
                decode_record(&serde_json::to_vec(&value).unwrap()),
                ErrorKind::InvalidInput,
            );
        }
        let mut unsupported: Value = serde_json::from_str(encoded).unwrap();
        unsupported["body"]["protocolVersion"] = json!(2);
        bad_kind(
            decode_record(&serde_json::to_vec(&unsupported).unwrap()),
            ErrorKind::ProtocolUnsupported,
        );
        let mut invalid: Value = serde_json::from_str(encoded).unwrap();
        invalid["body"]["kind"] = json!("futureOperation");
        bad_kind(
            decode_record(&serde_json::to_vec(&invalid).unwrap()),
            ErrorKind::ProtocolUnsupported,
        );
        let invalid_unicode = encoded.replacen("\"createNetwork\"", "\"\\ud800\"", 1);
        bad_kind(
            decode_record(invalid_unicode.as_bytes()),
            ErrorKind::InvalidInput,
        );
        for signature in [[0; 64], [255; 64]] {
            let mut forged: Value = serde_json::from_str(encoded).unwrap();
            forged["signature"] = json!(Signature::from_bytes(signature));
            let parsed = decode_record(&serde_json::to_vec(&forged).unwrap()).unwrap();
            bad_kind(
                verify_history(parsed.id().into(), &[parsed], limits()),
                ErrorKind::InvalidInput,
            );
        }
        let mut noncanonical_scalar = *record.signature().as_bytes();
        noncanonical_scalar[32..].fill(255);
        let mut forged: Value = serde_json::from_str(encoded).unwrap();
        forged["signature"] = json!(Signature::from_bytes(noncanonical_scalar));
        let parsed = decode_record(&serde_json::to_vec(&forged).unwrap()).unwrap();
        bad_kind(
            verify_history(parsed.id().into(), &[parsed], limits()),
            ErrorKind::InvalidInput,
        );
        for number in ["-1", "9007199254740992"] {
            let unsafe_number = encoded.replacen(
                "\"protocolVersion\":1",
                &format!("\"protocolVersion\":{number}"),
                1,
            );
            bad_kind(
                decode_record(unsafe_number.as_bytes()),
                ErrorKind::InvalidInput,
            );
        }
    }
    bad_kind(
        decode_record(&vec![b' '; MAX_RECORD_BYTES + 1]),
        ErrorKind::ResourceLimit,
    );
    bad_kind(
        prepare_genesis(
            nonce(0),
            "Weak".into(),
            host(1),
            PublicKey::from_bytes([0; 32]),
        ),
        ErrorKind::InvalidInput,
    );
    // Non-small-order, noncanonical point: the library may decompress it, but
    // the protocol requires its canonical compressed representation.
    let noncanonical = (2..19)
        .find_map(|offset| {
            let mut bytes = [255; 32];
            bytes[0] = 0xed + offset;
            bytes[31] = 0x7f;
            ed25519_dalek::VerifyingKey::from_bytes(&bytes)
                .ok()
                .filter(|key| !key.is_weak())
                .map(|_| PublicKey::from_bytes(bytes))
        })
        .unwrap();
    bad_kind(
        prepare_genesis(nonce(0), "Noncanonical".into(), host(1), noncanonical),
        ErrorKind::InvalidInput,
    );
}

#[test]
fn compatible_sets_converge_and_generation_withdrawals_commute() {
    let g = group(4);
    let h = &g.history;
    let a = changed(
        h,
        &g.actors[0],
        g.members[0],
        20,
        Change::Remove(g.members[1]),
    );
    let c = changed(
        h,
        &g.actors[2],
        g.members[2],
        21,
        Change::Remove(g.members[1]),
    );
    let d = changed(h, &g.actors[3], g.members[3], 22, Change::Leave);
    let events = [a, c, d];
    let expected = events.iter().fold(h.clone(), |state, r| adopt(&state, r));
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let mut state = h.clone();
        for i in order {
            state = adopt(&state, &events[i]);
            assert!(matches!(
                consider(&state, &events[i], &[], limits()).unwrap(),
                Decision::Duplicate(_)
            ));
        }
        assert_eq!(state.snapshot(), expected.snapshot());
        assert_eq!(
            state.active_members().collect::<Vec<_>>(),
            expected.active_members().collect::<Vec<_>>()
        );
    }
    let b_leave = changed(h, &g.actors[1], g.members[1], 23, Change::Leave);
    let both = adopt(&adopt(h, &events[0]), &b_leave);
    assert!(!both.is_active(g.members[1]));
    let d_actor = Actor::new(8);
    let admitted = admission(h, &g.actors[1], g.members[1], &d_actor, 24);
    let mut advanced = adopt(h, &admitted);
    let remove_inviter = changed(
        &advanced,
        &g.actors[0],
        g.members[0],
        25,
        Change::Remove(g.members[1]),
    );
    advanced = adopt(&advanced, &remove_inviter);
    assert!(advanced.is_active(admitted.id().into()));
    let mut replacement = Actor::new(9);
    replacement.host = g.actors[1].host;
    let readmitted = admission(&advanced, &g.actors[0], g.members[0], &replacement, 26);
    let advanced = adopt(&advanced, &readmitted);
    assert!(advanced.is_active(readmitted.id().into()));
    assert!(matches!(
        consider(&advanced, &remove_inviter, &[], limits()).unwrap(),
        Decision::Duplicate(_)
    ));
    assert!(advanced.is_active(readmitted.id().into()));
    bad_kind(
        prepare_join(
            &advanced,
            g.members[0],
            nonce(27),
            nonce(28),
            host(99),
            g.actors[1].public(),
        ),
        ErrorKind::InvalidInput,
    );
}

#[test]
fn first_accepted_conflict_and_complete_ancestry_are_preserved() {
    let g = group(3);
    let h = &g.history;
    let remove_b = changed(
        h,
        &g.actors[0],
        g.members[0],
        30,
        Change::Remove(g.members[1]),
    );
    let admit_d = admission(h, &g.actors[1], g.members[1], &Actor::new(4), 31);
    let left = adopt(h, &remove_b);
    let right = adopt(h, &admit_d);
    assert_eq!(
        conflict(&left, &admit_d, &[]).kind,
        ConflictKind::AuthorWithdrawal
    );
    assert_eq!(
        conflict(&right, &remove_b, &[]).kind,
        ConflictKind::AuthorWithdrawal
    );
    let batch = [admit_d.clone(), remove_b.clone()];
    let ready = ready_candidates(h, &batch, limits()).unwrap();
    let records = |id| batch.iter().find(|r| r.id() == id).unwrap();
    let selected = adopt(h, records(ready[0]));
    assert_eq!(
        conflict(&selected, records(ready[1]), &[]).kind,
        ConflictKind::AuthorWithdrawal
    );
    bad_kind(
        consider(
            &left,
            &admit_d,
            &[],
            Limits {
                conflict_bytes: 1,
                ..limits()
            },
        ),
        ErrorKind::ResourceLimit,
    );
    assert!(!left.is_active(g.members[1]));
    assert!(right.is_active(g.members[1]));
    let admit_e = admission(
        &right,
        &Actor::new(4),
        admit_d.id().into(),
        &Actor::new(5),
        32,
    );
    bad_kind(
        consider(&left, &admit_e, &[], limits()),
        ErrorKind::ProofIncomplete,
    );
    let witness = conflict(&left, &admit_e, std::slice::from_ref(&admit_d));
    assert!(witness.record_ids.contains(&admit_d.id()));
    assert!(
        witness
            .foreign_records
            .iter()
            .any(|r| r.id() == admit_d.id())
    );
    let admit_f = admission(&right, &g.actors[2], g.members[2], &Actor::new(6), 33);
    assert_eq!(
        conflict(&left, &admit_f, &[admit_d]).kind,
        ConflictKind::AuthorWithdrawal
    );
    let independent = admission(h, &g.actors[2], g.members[2], &Actor::new(7), 34);
    let combined = proposal(&left, &independent, &[admit_f]);
    assert!(combined.result().record(independent.id()).is_some());
    assert!(
        combined
            .result()
            .active_members()
            .all(|m| m.host_id != host(6))
    );
}

#[test]
fn whole_union_checks_removal_cycles_and_all_identity_races() {
    let g = group(3);
    let h = &g.history;
    let mut cycle = h.records().cloned().collect::<Vec<_>>();
    for (i, target) in [(0, 1), (1, 2), (2, 0)] {
        cycle.push(changed(
            h,
            &g.actors[i],
            g.members[i],
            40 + i as u8,
            Change::Remove(g.members[target]),
        ));
    }
    bad_kind(
        verify_history(h.network_id(), &cycle, limits()),
        ErrorKind::InvalidInput,
    );
    let mut same_host = Actor::new(5);
    same_host.host = host(4);
    let mut same_key = Actor::new(4);
    same_key.host = host(5);
    let first = admission(h, &g.actors[0], g.members[0], &Actor::new(4), 50);
    let accepted = adopt(h, &first);
    for other in [&same_host, &same_key] {
        let second = admission(h, &g.actors[0], g.members[0], other, 51);
        assert_eq!(
            conflict(&accepted, &second, &[]).kind,
            ConflictKind::CompetingAdmission
        );
    }
    for (invitation, attempt, operation, expected) in [
        (50, 152, 52, ConflictKind::InvitationReuse),
        (52, 150, 52, ConflictKind::JoinEquivocation),
        (52, 152, 50, ConflictKind::OperationEquivocation),
    ] {
        let proof = join(h, g.members[0], &Actor::new(6), invitation, attempt);
        let second = changed(
            h,
            &g.actors[0],
            g.members[0],
            operation,
            Change::Admit(Box::new(proof)),
        );
        let witness = conflict(&accepted, &second, &[]);
        assert_eq!(witness.kind, expected);
        let mut sequential = second.body().clone();
        if let RecordBody::AdmitMember { parents, .. } = &mut sequential {
            *parents = accepted.snapshot().frontier.clone();
        }
        let sequential = signed_body(sequential, &g.actors[0]);
        bad_kind(
            consider(&accepted, &sequential, &[], limits()),
            ErrorKind::InvalidInput,
        );
    }
}

#[test]
fn join_proofs_bind_exact_issuance_context_without_current_clock() {
    let g = group(2);
    let h = &g.history;
    let a = &g.actors[0];
    let d = Actor::new(4);
    let original = admission(h, a, g.members[0], &d, 60);
    let proof = join(h, g.members[0], &d, 62, 63);
    let proof_json = serde_jcs::to_vec(&proof).unwrap();
    assert_eq!(decode_join_proof(&proof_json).unwrap(), proof);
    let duplicate = String::from_utf8(proof_json).unwrap().replacen(
        "\"body\":",
        "\"signature\":\"duplicate\",\"body\":",
        1,
    );
    bad_kind(
        decode_join_proof(duplicate.as_bytes()),
        ErrorKind::InvalidInput,
    );
    for mode in 0..4 {
        let mut body = original.body().clone();
        if let RecordBody::AdmitMember { payload, .. } = &mut body {
            let join_body = &mut payload.join_proof.body;
            match mode {
                0 => join_body.invitation_history_id = HistoryId::from_bytes([99; 32]),
                1 => join_body.issuer_membership_id = g.members[1],
                2 => join_body.invitation_frontier = vec![RecordId::from_bytes([99; 32])],
                _ => join_body.network_id = NetworkId::from_bytes([99; 32]),
            }
            let mut bytes = b"dewbow.network.join.v1\0".to_vec();
            bytes.extend(serde_jcs::to_vec(join_body).unwrap());
            payload.join_proof.signature = Signature::from_bytes(d.key.sign(&bytes).to_bytes());
        }
        let forged = signed_body(body, a);
        bad_kind(consider(h, &forged, &[], limits()), ErrorKind::InvalidInput);
    }
    let joined = adopt(h, &original);
    let without_inviter = changed(
        &joined,
        &g.actors[1],
        g.members[1],
        61,
        Change::Remove(g.members[0]),
    );
    let history = adopt(&joined, &without_inviter);
    // No live issuer, invitation secret or wall-clock input is needed here.
    let records = history.records().cloned().collect::<Vec<_>>();
    let restored = verify_history(h.network_id(), &records, limits()).unwrap();
    assert!(restored.is_active(original.id().into()));
    let mut redundant = original.body().clone();
    if let RecordBody::AdmitMember { parents, .. } = &mut redundant {
        parents.push(h.network_id().into());
        parents.sort();
    }
    let redundant = signed_body(redundant, a);
    bad_kind(
        consider(h, &redundant, &[], limits()),
        ErrorKind::InvalidInput,
    );
}

#[test]
fn incomplete_invalid_and_over_budget_inputs_cannot_reserve_or_change_state() {
    let g = group(2);
    let h = &g.history;
    let first = admission(h, &g.actors[0], g.members[0], &Actor::new(3), 70);
    let right = adopt(h, &first);
    let child = admission(
        &right,
        &Actor::new(3),
        first.id().into(),
        &Actor::new(4),
        71,
    );
    let snapshot = h.snapshot().clone();
    bad_kind(
        consider(h, &child, &[], limits()),
        ErrorKind::ProofIncomplete,
    );
    assert!(
        ready_candidates(h, std::slice::from_ref(&child), limits())
            .unwrap()
            .is_empty()
    );
    let local = changed(
        h,
        &g.actors[1],
        g.members[1],
        72,
        Change::Remove(g.members[0]),
    );
    let advanced = adopt(h, &local);
    assert_eq!(
        conflict(&advanced, &child, std::slice::from_ref(&first)).kind,
        ConflictKind::AuthorWithdrawal
    );
    let batch = vec![child.clone(), first.clone()];
    let ready = ready_candidates(h, &batch, limits()).unwrap();
    assert!(ready.windows(2).all(|w| w[0] < w[1]));
    let mut bad: Value = serde_json::from_slice(first.encoded()).unwrap();
    bad["signature"] = json!(Signature::from_bytes([0; 64]));
    let bad = decode_record(&serde_json::to_vec(&bad).unwrap()).unwrap();
    bad_kind(consider(h, &bad, &[], limits()), ErrorKind::InvalidInput);
    assert!(matches!(
        consider(h, &first, &[], limits()).unwrap(),
        Decision::Proposed(_)
    ));
    bad_kind(
        consider(
            h,
            &first,
            &[],
            Limits {
                working_bytes: 1,
                ..limits()
            },
        ),
        ErrorKind::ResourceLimit,
    );
    let independent_foreign = genesis(&Actor::new(9));
    let foreign = independent_foreign.records().next().unwrap();
    bad_kind(consider(h, foreign, &[], limits()), ErrorKind::InvalidInput);
    assert_eq!(h.snapshot(), &snapshot);
}

#[test]
fn retry_reuses_frozen_result_and_candidates_require_commit_and_fresh_base() {
    let g = group(3);
    let h = &g.history;
    let record = changed(
        h,
        &g.actors[0],
        g.members[0],
        80,
        Change::Remove(g.members[1]),
    );
    let pending = proposal(h, &record, &[]);
    assert!(!pending.result().is_active(g.members[1]));
    let committed = h.clone();
    // Simulated write failure: drop the proposal, leave current authority alone.
    assert!(committed.is_active(g.members[1]));
    let unrelated = changed(h, &g.actors[2], g.members[2], 81, Change::Leave);
    let advanced = adopt(h, &unrelated);
    bad_kind(pending.ensure_base(&advanced), ErrorKind::StaleBase);
    pending.ensure_base(&committed).unwrap();
    let saved = pending.result().clone();
    let after = adopt(&saved, &unrelated);
    let retry = changed(
        &after,
        &g.actors[0],
        g.members[0],
        80,
        Change::Remove(g.members[1]),
    );
    assert_eq!(record.encoded(), retry.encoded());
    bad_kind(
        prepare_change(
            &after,
            g.members[0],
            nonce(80),
            Change::Remove(g.members[2]),
            limits(),
        ),
        ErrorKind::InvalidInput,
    );
    let another_intent = changed(
        &after,
        &g.actors[0],
        g.members[0],
        82,
        Change::Remove(g.members[1]),
    );
    assert_eq!(record.encoded(), another_intent.encoded());
    let leave = changed(h, &g.actors[1], g.members[1], 83, Change::Leave);
    let inactive = adopt(h, &leave);
    assert_eq!(
        changed(&inactive, &g.actors[1], g.members[1], 84, Change::Leave).encoded(),
        leave.encoded()
    );
}

#[test]
fn local_selection_requires_exit_then_fresh_confirmed_admission_and_preserves_evidence() {
    let g = group(3);
    let h = &g.history;
    let local = LocalSelection::restore(
        uuid::Uuid::from_u128(1),
        g.members[1],
        SelectionStatus::Active,
        h.clone(),
    )
    .unwrap();
    let d = admission(h, &g.actors[1], g.members[1], &Actor::new(4), 90);
    let left_history = adopt(h, &d);
    let leave = changed(&left_history, &g.actors[1], g.members[1], 91, Change::Leave);
    let left_history = adopt(&left_history, &leave);
    let before_exit = LocalSelection::restore(
        local.selection_id(),
        g.members[1],
        SelectionStatus::Active,
        adopt(h, &d),
    )
    .unwrap();
    let after_exit = before_exit
        .after_adoption(&proposal(before_exit.history(), &leave, &[]))
        .unwrap();
    assert_eq!(after_exit.status(), SelectionStatus::Left);
    let remove = changed(
        h,
        &g.actors[0],
        g.members[0],
        92,
        Change::Remove(g.members[1]),
    );
    let excluded = local.after_adoption(&proposal(h, &remove, &[])).unwrap();
    assert_eq!(excluded.status(), SelectionStatus::Removed);
    let detached = excluded.detach_inactive().unwrap();
    assert_eq!(detached.status(), SelectionStatus::Left);
    assert_eq!(detached.history().snapshot(), excluded.history().snapshot());
    let left = LocalSelection::restore(
        local.selection_id(),
        g.members[1],
        SelectionStatus::Left,
        left_history.clone(),
    )
    .unwrap();
    let mut replacement = Actor::new(8);
    replacement.host = g.actors[1].host;
    let other = adopt(h, &remove);
    let fresh = admission(&other, &g.actors[0], g.members[0], &replacement, 93);
    let other = adopt(&other, &fresh);
    let confirmation =
        || ConfirmedLocalAdmission::from_local_confirmation(replacement.host, fresh.id().into());
    bad_kind(
        plan_fresh_selection(
            Some(&local),
            uuid::Uuid::from_u128(2),
            other.clone(),
            confirmation(),
        ),
        ErrorKind::InvalidInput,
    );
    let plan = plan_fresh_selection(
        Some(&left),
        uuid::Uuid::from_u128(2),
        other.clone(),
        confirmation(),
    )
    .unwrap();
    assert_eq!(plan.current.local_member(), fresh.id().into());
    assert_eq!(
        plan.previous.unwrap().history().snapshot(),
        left_history.snapshot()
    );
    assert!(plan.current.history().record(d.id()).is_none());
    bad_kind(
        plan_fresh_selection(
            Some(&left),
            uuid::Uuid::from_u128(3),
            h.clone(),
            ConfirmedLocalAdmission::from_local_confirmation(g.actors[1].host, g.members[1]),
        ),
        ErrorKind::InvalidInput,
    );
    bad_kind(
        LocalSelection::restore(
            uuid::Uuid::from_u128(4),
            g.members[1],
            SelectionStatus::Active,
            left_history,
        ),
        ErrorKind::InvalidInput,
    );
    assert_eq!(local.status(), SelectionStatus::Active);
}

#[test]
fn departure_rebase_constructs_only_the_exact_retained_old_generation() {
    let g = group(3);
    let h = &g.history;
    let b_remove_c = changed(
        h,
        &g.actors[1],
        g.members[1],
        100,
        Change::Remove(g.members[2]),
    );
    let branch = adopt(h, &b_remove_c);
    let leave = changed(&branch, &g.actors[1], g.members[1], 101, Change::Leave);
    let departed = adopt(&branch, &leave);
    let c_admit_d = admission(h, &g.actors[2], g.members[2], &Actor::new(4), 102);
    let recipient = adopt(h, &c_admit_d);
    let prepared = prepare_departure_rebase(&departed, leave.id(), &recipient, limits()).unwrap();
    let PreparedDeparture::Sign(prepared) = prepared else {
        panic!("Expected exact-generation rebase")
    };
    assert_eq!(prepared.body().withdrawal(), Some(g.members[1]));
    assert_eq!(prepared.body().parents(), recipient.snapshot().frontier);
    let rebased = g.actors[1].sign(prepared);
    let updated = adopt(&recipient, &rebased);
    assert!(!updated.is_active(g.members[1]));
    assert!(updated.is_active(c_admit_d.id().into()));
    assert!(updated.record(b_remove_c.id()).is_none());
    let retry = prepare_departure_rebase(&departed, leave.id(), &recipient, limits()).unwrap();
    let PreparedDeparture::Sign(retry) = retry else {
        panic!()
    };
    assert_eq!(rebased.encoded(), g.actors[1].sign(retry).encoded());
    bad_kind(
        prepare_departure_rebase(&departed, b_remove_c.id(), &recipient, limits()),
        ErrorKind::InvalidInput,
    );
    bad_kind(
        prepare_departure_rebase(&departed, leave.id(), &genesis(&Actor::new(9)), limits()),
        ErrorKind::InvalidInput,
    );
    let mut replacement = Actor::new(8);
    replacement.host = g.actors[1].host;
    let fresh = admission(&updated, &g.actors[0], g.members[0], &replacement, 103);
    let rejoined = adopt(&updated, &fresh);
    assert!(matches!(
        prepare_departure_rebase(&departed, leave.id(), &rejoined, limits()).unwrap(),
        PreparedDeparture::Absent { .. }
    ));
    assert!(rejoined.is_active(fresh.id().into()));
    // A valid same-Network view may never have admitted this old generation.
    let initial = genesis(&g.actors[0]);
    assert!(matches!(
        prepare_departure_rebase(&departed, leave.id(), &initial, limits()).unwrap(),
        PreparedDeparture::Absent { .. }
    ));
}
