use super::{keys::KeyFiles, schema, types::*};
use crate::store::INVALID_STATE;
use anyhow::ensure;
use dewbow_protocol::network::*;
use rusqlite::{Connection, params};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

fn bytes(value: Vec<u8>) -> anyhow::Result<[u8; 32]> {
    value.try_into().map_err(|_| anyhow::anyhow!(INVALID_STATE))
}
fn uuid(value: &str) -> anyhow::Result<uuid::Uuid> {
    let id = uuid::Uuid::parse_str(value)?;
    ensure!(id.to_string() == value, INVALID_STATE);
    Ok(id)
}

pub fn selection(db: &Connection, id: &str, limits: Limits) -> anyhow::Result<LocalSelection> {
    let (network,member,status,frontier,commitment,count):(Vec<u8>,Vec<u8>,String,String,Vec<u8>,i64)=db.query_row("SELECT network_id,local_membership_id,status,frontier_json,history_id,record_count FROM network_selections WHERE selection_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    let network = NetworkId::from_bytes(bytes(network)?);
    let frontier: Vec<RecordId> = serde_json::from_str(&frontier)?;
    ensure!(
        !frontier.is_empty() && frontier.windows(2).all(|p| p[0] < p[1]),
        INVALID_STATE
    );
    let mut records = BTreeMap::new();
    let mut todo = frontier.clone();
    let mut total = 0usize;
    while let Some(id) = todo.pop() {
        if records.contains_key(&id) {
            continue;
        }
        let (stored_network, kind, encoded): (Vec<u8>, String, String) = db.query_row(
            "SELECT network_id,kind,envelope_json FROM network_records WHERE record_id=?",
            [id.as_bytes().as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        total = total.saturating_add(encoded.len()).saturating_add(512);
        ensure!(
            total.saturating_mul(2) <= limits.working_bytes,
            "Increase DEWBOW_NETWORK_WORKING_BYTES for retained membership history"
        );
        let record = decode_record(encoded.as_bytes())?;
        ensure!(
            record.id() == id
                && stored_network == network.as_bytes()
                && record.encoded() == encoded.as_bytes(),
            INVALID_STATE
        );
        let body: serde_json::Value = serde_json::from_slice(record.encoded())?;
        ensure!(body["body"]["kind"] == kind, INVALID_STATE);
        todo.extend_from_slice(record.body().parents());
        records.insert(id, record);
    }
    let history = verify_history(network, &records.into_values().collect::<Vec<_>>(), limits)?;
    ensure!(
        history.snapshot().frontier == frontier
            && history.snapshot().history_id.as_bytes().as_slice() == commitment
            && history.snapshot().record_count as i64 == count,
        INVALID_STATE
    );
    let status = match status.as_str() {
        "active" => SelectionStatus::Active,
        "left" => SelectionStatus::Left,
        "removed" => SelectionStatus::Removed,
        _ => anyhow::bail!(INVALID_STATE),
    };
    Ok(LocalSelection::restore(
        uuid(id)?,
        MembershipId::from_bytes(bytes(member)?),
        status,
        history,
    )?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultRefs {
    code: Option<String>,
    record_id: Option<RecordId>,
    selection_id: Option<String>,
    join_attempt_id: Option<Nonce>,
    issuer_membership_id: Option<MembershipId>,
    invitation_id: Option<Nonce>,
    departure_record_id: Option<RecordId>,
    command_id: Option<String>,
    session_id: Option<String>,
    turn_id: Option<String>,
}
fn result_refs(value: &str) -> anyhow::Result<()> {
    let refs: ResultRefs = serde_json::from_str(value)?;
    if let Some(id) = refs.selection_id {
        uuid(&id)?;
    }
    for value in [refs.code, refs.command_id, refs.session_id, refs.turn_id]
        .into_iter()
        .flatten()
    {
        ensure!(!value.is_empty(), INVALID_STATE);
    }
    let _ = (
        refs.record_id,
        refs.join_attempt_id,
        refs.issuer_membership_id,
        refs.invitation_id,
        refs.departure_record_id,
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddressBody {
    protocol_version: u64,
    network_id: NetworkId,
    membership_id: MembershipId,
    endpoints: Vec<String>,
    lease_seconds: u64,
    nonce: Nonce,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddressHint {
    body: AddressBody,
    signature: Signature,
}

pub fn validate(
    db: &Connection,
    state: &Path,
    host: Option<HostId>,
    limits: Limits,
) -> anyhow::Result<()> {
    validate_inner(db,state,host,limits).map_err(|error| {
        if error.to_string().contains("DEWBOW_NETWORK_WORKING_BYTES") || error.downcast_ref::<dewbow_protocol::network::Error>().is_some_and(|e|e.kind==ErrorKind::ResourceLimit) {
            anyhow::anyhow!("RECOVERY_REQUIRED: increase DEWBOW_NETWORK_WORKING_BYTES for retained membership history")
        } else {anyhow::anyhow!(INVALID_STATE)}
    })
}

fn validate_inner(
    db: &Connection,
    state: &Path,
    host: Option<HostId>,
    limits: Limits,
) -> anyhow::Result<()> {
    ensure!(schema::inspect(db)? == 2, INVALID_STATE);
    ensure!(
        db.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))? == "ok",
        INVALID_STATE
    );
    let (selected,listen,endpoints):(Option<String>,Option<String>,String)=db.query_row("SELECT current_selection_id,listen_endpoint,advertised_endpoints_json FROM network_settings",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if let Some(listen) = listen {
        endpoint(&listen)?;
    }
    let endpoints: Vec<String> = serde_json::from_str(&endpoints)?;
    ensure!(endpoints.len() <= 8, INVALID_STATE);
    for value in endpoints {
        endpoint(&value)?;
    }
    let mut keys = BTreeMap::new();
    let mut q =
        db.prepare("SELECT key_id,public_key,storage_status,created_at FROM network_keys")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (id, public, status, created) = row?;
        uuid(&id)?;
        local_timestamp(&created)?;
        keys.insert(id, (PublicKey::from_bytes(bytes(public)?), status));
    }
    let mut reachable = BTreeSet::new();
    let mut members = BTreeMap::new();
    let mut active = 0;
    let mut q = db.prepare("SELECT selection_id,key_id,created_at FROM network_selections")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (id, key, created) = row?;
        local_timestamp(&created)?;
        let selected_history = selection(db, &id, limits)?;
        let member = selected_history
            .history()
            .member(selected_history.local_member())
            .unwrap();
        ensure!(
            Some(member.host_id) == host
                && keys
                    .get(&key)
                    .is_some_and(|(public, _)| *public == member.public_key),
            INVALID_STATE
        );
        for record in selected_history.history().records() {
            reachable.insert(record.id());
        }
        for record in selected_history.history().records() {
            let member = match record.body() {
                RecordBody::CreateNetwork {
                    host_id,
                    public_key,
                    ..
                } => Some((MembershipId::from(record.id()), (*host_id, *public_key))),
                _ => record
                    .body()
                    .join()
                    .map(|j| (MembershipId::from(record.id()), (j.host_id, j.public_key))),
            };
            if let Some((id, binding)) = member {
                ensure!(
                    members.insert(id, binding).is_none_or(|old| old == binding),
                    INVALID_STATE
                );
            }
        }
        if selected_history.status() == SelectionStatus::Active {
            active += 1;
            ensure!(
                selected.as_deref() == Some(&id) && keys[&key].1 == "present",
                INVALID_STATE
            );
            KeyFiles::new(state).validate(&key, member.public_key)?;
        }
    }
    ensure!(active <= 1, INVALID_STATE);
    let count: i64 = db.query_row("SELECT count(*) FROM network_records", [], |r| r.get(0))?;
    ensure!(reachable.len() as i64 == count, INVALID_STATE);
    let pending:i64=db.query_row("SELECT count(*) FROM network_join_attempts WHERE role='joiner' AND status IN ('prepared','proofReady','uncertain')",[],|r|r.get(0))?;
    ensure!(pending <= 1 && (pending == 0 || active == 0), INVALID_STATE);

    let mut q = db.prepare(
        "SELECT request_id,fingerprint,result_refs_json,created_at FROM network_requests",
    )?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (id, fingerprint, result, created) = row?;
        ensure!(
            !id.trim().is_empty() && fingerprint.len() == 32,
            INVALID_STATE
        );
        local_timestamp(&created)?;
        result_refs(&result)?;
    }
    let mut q=db.prepare("SELECT role,issuer_membership_id,join_attempt_id,invitation_id,host_id,public_key,key_id,invitation_json,join_proof_json,status,result_record_id,created_at,credential_secret,local_request_id,fingerprint FROM network_join_attempts")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, Vec<u8>>(2)?,
            r.get::<_, Vec<u8>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Vec<u8>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, Option<Vec<u8>>>(10)?,
            r.get::<_, String>(11)?,
            r.get::<_, Option<Vec<u8>>>(12)?,
            r.get::<_, Option<String>>(13)?,
            r.get::<_, Vec<u8>>(14)?,
        ))
    })? {
        let (
            role,
            issuer,
            attempt,
            invitation,
            local_host,
            public,
            key,
            encoded,
            proof,
            status,
            result,
            created,
            secret,
            request,
            fingerprint,
        ) = row?;
        local_timestamp(&created)?;
        let local_host = HostId::parse(&local_host)?;
        let public = PublicKey::from_bytes(bytes(public)?);
        let invitation_data: PublicInvitation = serde_json::from_str(&encoded)?;
        invitation_data.validate()?;
        ensure!(
            invitation_data
                .body
                .issuer_membership_id
                .as_bytes()
                .as_slice()
                == issuer
                && invitation_data.body.invitation_id.as_bytes().as_slice() == invitation,
            INVALID_STATE
        );
        if let Some(secret) = secret {
            use sha2::{Digest, Sha256};
            ensure!(
                Sha256::digest(secret).as_slice()
                    == invitation_data.body.credential_hash.as_bytes(),
                INVALID_STATE
            );
        }
        if role == "joiner" {
            ensure!(
                Some(local_host) == host
                    && key
                        .as_ref()
                        .is_some_and(|k| keys.get(k).is_some_and(|(p, s)| *p == public
                            && (!matches!(
                                status.as_str(),
                                "prepared" | "proofReady" | "uncertain"
                            ) || s == "present"))),
                INVALID_STATE
            );
            let (op,input,result_json,request_status):(String,Vec<u8>,String,String)=db.query_row("SELECT operation,fingerprint,result_refs_json,status FROM network_requests WHERE request_id=?",[request.as_ref().unwrap()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            ensure!(op == "joinNetwork" && input == fingerprint, INVALID_STATE);
            let refs: serde_json::Value = serde_json::from_str(&result_json)?;
            ensure!(
                refs["joinAttemptId"]
                    == serde_json::json!(Nonce::from_bytes(bytes(attempt.clone())?)),
                INVALID_STATE
            );
            if status == "expired" {
                ensure!(
                    request_status == "failed" && refs["code"] == "INVITATION_EXPIRED",
                    INVALID_STATE
                );
            }
            if matches!(status.as_str(), "prepared" | "proofReady" | "uncertain") {
                ensure!(request_status == "pending", INVALID_STATE);
                KeyFiles::new(state).validate(key.as_ref().unwrap(), public)?;
            } else if status == "admitted" {
                ensure!(
                    request_status == "succeeded"
                        && refs["recordId"]
                            == serde_json::json!(RecordId::from_bytes(bytes(
                                result.clone().unwrap()
                            )?)),
                    INVALID_STATE
                );
            } else if status == "denied" {
                ensure!(
                    request_status == "failed" && refs["code"] == "DENIED",
                    INVALID_STATE
                );
            }
        }
        if let Some(proof) = proof {
            let proof = decode_join_proof(proof.as_bytes())?;
            if role == "issuer" {
                use sha2::{Digest, Sha256};
                ensure!(
                    fingerprint == Sha256::digest(serde_jcs::to_vec(&proof)?).as_slice(),
                    INVALID_STATE
                );
                let invitation:String=db.query_row("SELECT public_invitation_json FROM network_invitations WHERE issuer_membership_id=?1 AND invitation_id=?2",params![issuer,invitation],|r|r.get(0))?;
                ensure!(invitation == encoded, INVALID_STATE);
                let (operation, status_json): (String, String) = db.query_row(
                    "SELECT operation,status FROM network_requests WHERE request_id=?",
                    [request.as_ref().unwrap()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                ensure!(
                    operation == "confirmNetworkJoin" && status_json == "succeeded",
                    INVALID_STATE
                );
            }
            ensure!(
                proof.body.host_id == local_host
                    && proof.body.public_key == public
                    && proof.body.issuer_membership_id.as_bytes().as_slice() == issuer
                    && proof.body.join_attempt_id.as_bytes().as_slice() == attempt
                    && proof.body.invitation_id.as_bytes().as_slice() == invitation
                    && proof.body.network_id == invitation_data.body.network_id
                    && proof.body.invitation_history_id == invitation_data.body.history_id
                    && proof.body.invitation_frontier == invitation_data.body.invitation_frontier,
                INVALID_STATE
            );
            if let Some(result) = result {
                let record: String = db.query_row(
                    "SELECT envelope_json FROM network_records WHERE record_id=?",
                    [result],
                    |r| r.get(0),
                )?;
                ensure!(
                    matches!(decode_record(record.as_bytes())?.body(),RecordBody::AdmitMember{payload,..} if *payload.join_proof==proof),
                    INVALID_STATE
                );
            }
        }
    }
    let mut q=db.prepare("SELECT issuer_membership_id,invitation_id,public_invitation_json,secret,status,consumed_attempt_id,expires_at,created_at FROM network_invitations")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, Vec<u8>>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<Vec<u8>>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<Vec<u8>>>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
        ))
    })? {
        let (issuer, id, encoded, secret, status, attempt, expires, created) = row?;
        local_timestamp(&created)?;
        let invitation: PublicInvitation = serde_json::from_str(&encoded)?;
        invitation.validate()?;
        ensure!(
            invitation.body.issuer_membership_id.as_bytes().as_slice() == issuer
                && invitation.body.invitation_id.as_bytes().as_slice() == id
                && invitation.body.expires_at == expires,
            INVALID_STATE
        );
        ensure!(
            members
                .get(&invitation.body.issuer_membership_id)
                .is_some_and(|(h, p)| Some(*h) == host && *p == invitation.body.issuer_public_key),
            INVALID_STATE
        );
        if let Some(secret) = secret {
            use sha2::{Digest, Sha256};
            ensure!(
                Sha256::digest(secret).as_slice() == invitation.body.credential_hash.as_bytes(),
                INVALID_STATE
            );
        }
        if status == "consumed" {
            ensure!(db.query_row("SELECT count(*) FROM network_join_attempts WHERE role='issuer' AND issuer_membership_id=?1 AND join_attempt_id=?2 AND invitation_id=?3 AND status='admitted'",params![issuer,attempt,id],|r|r.get::<_,i64>(0))?==1,INVALID_STATE);
        }
    }
    let mut q=db.prepare("SELECT d.departure_record_id,d.network_id,d.membership_id,d.operation_id,d.key_id,d.created_at,r.envelope_json FROM network_departures d JOIN network_records r ON r.record_id=d.departure_record_id")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, Vec<u8>>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, Vec<u8>>(2)?,
            r.get::<_, Vec<u8>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
        ))
    })? {
        let (_, network, member, operation, key, created, encoded) = row?;
        local_timestamp(&created)?;
        let record = decode_record(encoded.as_bytes())?;
        ensure!(
            matches!(record.body(),RecordBody::LeaveNetwork{network_id,author_membership_id,operation_id,..} if network_id.as_bytes().as_slice()==network && author_membership_id.as_bytes().as_slice()==member && operation_id.as_bytes().as_slice()==operation),
            INVALID_STATE
        );
        let member = MembershipId::from_bytes(bytes(member)?);
        ensure!(
            members.get(&member).is_some_and(
                |(h, p)| Some(*h) == host && keys.get(&key).is_some_and(|(k, _)| k == p)
            ),
            INVALID_STATE
        );
    }
    let mut q=db.prepare("SELECT t.recipient_membership_id,t.recipient_host_id,t.recipient_public_key,t.contact_candidates_json,t.status,t.acknowledgement_json,d.key_id,d.departure_record_id,d.network_id,d.membership_id FROM network_departure_tasks t JOIN network_departures d USING(departure_record_id)")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, Vec<u8>>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Vec<u8>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Vec<u8>>(7)?,
            r.get::<_, Vec<u8>>(8)?,
            r.get::<_, Vec<u8>>(9)?,
        ))
    })? {
        let (member, host, public, contacts, status, ack, key, departure, network, withdrawn) =
            row?;
        let member = MembershipId::from_bytes(bytes(member)?);
        let host = HostId::parse(&host)?;
        let public = PublicKey::from_bytes(bytes(public)?);
        ensure!(members.get(&member) == Some(&(host, public)), INVALID_STATE);
        let contacts: Vec<String> = serde_json::from_str(&contacts)?;
        ensure!(contacts.len() <= 8, INVALID_STATE);
        for value in contacts {
            endpoint(&value)?;
        }
        if status == "pending" {
            ensure!(keys[&key].1 == "present", INVALID_STATE);
        }
        if let Some(ack) = ack {
            let ack: DepartureAck = serde_json::from_str(&ack)?;
            ack.validate(public)?;
            ensure!(
                status == "confirmed"
                    && ack.body.recipient_membership_id == member
                    && ack.body.departure_record_id.as_bytes().as_slice() == departure
                    && ack.body.network_id.as_bytes().as_slice() == network
                    && ack.body.membership_id.as_bytes().as_slice() == withdrawn,
                INVALID_STATE
            );
        }
    }
    for table in ["network_outbound_requests", "network_request_receipts"] {
        let mut q = db.prepare(&format!(
            "SELECT source_host_id,target_host_id,request_id,fingerprint,created_at FROM {table}"
        ))?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })? {
            let (source, target, request, fingerprint, created) = row?;
            let source = HostId::parse(&source)?;
            let target = HostId::parse(&target)?;
            ensure!(
                !request.trim().is_empty()
                    && fingerprint.len() == 32
                    && Some(if table == "network_outbound_requests" {
                        source
                    } else {
                        target
                    }) == host,
                INVALID_STATE
            );
            local_timestamp(&created)?;
        }
    }
    let mut q=db.prepare("SELECT request_id,command_id,operation,fingerprint,receipt_json,recovery_refs_json,created_at FROM network_request_receipts")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Vec<u8>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, String>(6)?,
        ))
    })? {
        let (request, command, operation, fingerprint, encoded, recovery, created) = row?;
        let value: serde_json::Value = serde_json::from_str(&encoded)?;
        crate::store::validate_record("operation", &request, &value)?;
        let hex: String = fingerprint.iter().map(|b| format!("{b:02x}")).collect();
        ensure!(
            value["commandId"] == command
                && value["operation"] == operation
                && value["fingerprint"] == hex
                && value["createdAt"] == created,
            INVALID_STATE
        );
        if let Some(recovery) = recovery {
            let refs: RecoveryRefs = serde_json::from_str(&recovery)?;
            ensure!(value["sessionId"] == refs.session_id, INVALID_STATE);
        }
    }
    let mut q = db.prepare(
        "SELECT result_ref_json FROM network_outbound_requests WHERE result_ref_json IS NOT NULL",
    )?;
    for value in q.query_map([], |r| r.get::<_, String>(0))? {
        result_refs(&value?)?;
    }
    let mut q=db.prepare("SELECT network_id,membership_id,endpoint,signed_hint_json,last_success_at FROM network_contacts")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, Vec<u8>>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    })? {
        let (network, member, address, hint, success) = row?;
        endpoint(&address)?;
        if let Some(value) = success {
            local_timestamp(&value)?;
        }
        if let Some(hint) = hint {
            let value: serde_json::Value = serde_json::from_str(&hint)?;
            let hint: AddressHint = serde_json::from_value(value.clone())?;
            ensure!(
                hint.body.protocol_version == 1
                    && (1..=300).contains(&hint.body.lease_seconds)
                    && hint.body.endpoints.len() <= 8
                    && hint.body.network_id.as_bytes().as_slice() == network
                    && hint.body.membership_id.as_bytes().as_slice() == member
                    && hint.body.endpoints.contains(&address),
                INVALID_STATE
            );
            let (_, key) = members
                .get(&hint.body.membership_id)
                .ok_or_else(|| anyhow::anyhow!(INVALID_STATE))?;
            let mut bytes = b"dewbow.network.address.v1\0".to_vec();
            bytes.extend(serde_jcs::to_vec(&value["body"])?);
            ed25519_dalek::VerifyingKey::from_bytes(key.as_bytes())?.verify_strict(
                &bytes,
                &ed25519_dalek::Signature::from_bytes(hint.signature.as_bytes()),
            )?;
            let _ = hint.body.nonce;
        }
    }
    ensure!(
        !db.prepare(
            "SELECT 1 FROM network_contacts GROUP BY network_id,membership_id HAVING count(*)>8"
        )?
        .exists([])?,
        INVALID_STATE
    );
    let (witnesses, size): (i64, i64) = db.query_row(
        "SELECT count(*),coalesce(sum(byte_count),0) FROM network_conflicts",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    ensure!(witnesses <= 64 && size <= 16 * 1024 * 1024, INVALID_STATE);
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Witness {
        local_history_id: HistoryId,
        foreign_history_id: HistoryId,
        record_ids: Vec<RecordId>,
        foreign_records: Vec<serde_json::Value>,
    }
    let mut q =
        db.prepare("SELECT witness_id,evidence_json,byte_count,created_at FROM network_conflicts")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (id, encoded, size, created) = row?;
        uuid(&id)?;
        local_timestamp(&created)?;
        ensure!(encoded.len() as i64 == size, INVALID_STATE);
        let evidence: Witness = serde_json::from_str(&encoded)?;
        ensure!(
            evidence.local_history_id != evidence.foreign_history_id
                && !evidence.record_ids.is_empty(),
            INVALID_STATE
        );
        for value in evidence.foreign_records {
            decode_record(&serde_jcs::to_vec(&value)?)?;
        }
    }
    Ok(())
}
