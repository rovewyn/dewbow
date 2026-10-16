use super::{
    PeerClient, Result,
    session::{Shared, ancestor_order},
    unavailable,
};
use crate::network::{
    lifecycle::{DepartureTask, Invitation},
    *,
};
use dewbow_protocol::network::{peer::*, *};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

impl PeerClient {
    async fn lifecycle_proof(
        &mut self,
        repo: &Repository,
        opened: Value,
    ) -> Result<super::bootstrap::ProofView> {
        let worker = self
            .shared
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?;
        self.read_opened_proof(repo, opened, worker).await
    }
    async fn write_departure_proof(
        &mut self,
        history: &VerifiedHistory,
        member: MembershipId,
        record: RecordId,
    ) -> Result<Value> {
        let opened: Value = self
            .request(
                "submitMembershipProof",
                &SubmitMembershipProof::Open {
                    purpose: ProofPurpose::Departure,
                    membership_id: Some(member),
                    record_id: Some(record),
                },
            )
            .await?;
        let token = opened["proofToken"]
            .as_str()
            .ok_or_else(|| PeerError::new("INVALID_PROOF"))?
            .to_string();
        let ordered = ancestor_order(history);
        let mut offset = 0;
        let mut last = json!({});
        while offset < ordered.len() {
            let mut records = Vec::new();
            let mut bytes = 256;
            for r in ordered[offset..].iter().take(MAX_RECORD_PAGE) {
                if bytes + r.encoded().len() > MAX_FRAME_BYTES - 1024 {
                    break;
                }
                bytes += r.encoded().len();
                records.push(serde_json::from_slice::<Value>(r.encoded()).map_err(unavailable)?);
            }
            offset += records.len();
            let reply: Value = self
                .request(
                    "submitMembershipProof",
                    &SubmitMembershipProof::Write {
                        proof_token: token.clone(),
                        records,
                        done: offset == ordered.len(),
                    },
                )
                .await?;
            if offset == ordered.len() && reply["complete"] != true {
                return Err(PeerError::new("PROOF_INCOMPLETE"));
            }
            last = reply;
        }
        Ok(last)
    }
}

async fn join_at(
    repo: &Repository,
    shared: &Arc<Shared>,
    id: AttemptId,
    address: &str,
    recovery: bool,
) -> Result<()> {
    let (row, secret) = repo.join_material(id).map_err(unavailable)?;
    let b = &row.invitation.body;
    let mut client = PeerClient::open_identity(
        repo,
        address,
        if recovery {
            None
        } else {
            Some(b.issuer_public_key)
        },
        true,
        shared,
        row.public,
        (uuid::Uuid::nil(), b.network_id, id.issuer),
        true,
    )
    .await?;
    let hello = if recovery {
        Hello::JoinRecovery {
            protocol_version: 1,
            network_id: b.network_id,
            join_proof: Box::new(decode_join_proof(
                row.proof
                    .as_ref()
                    .ok_or_else(|| PeerError::new("NOT_READY"))?
                    .as_bytes(),
            )?),
        }
    } else {
        Hello::Join {
            protocol_version: 1,
            network_id: b.network_id,
            issuer_membership_id: id.issuer,
            invitation_id: b.invitation_id,
            join_attempt_id: id.attempt,
        }
    };
    client.hello = client.request("hello", &hello).await?;
    let proof = if matches!(row.status.as_str(), "prepared" | "proofReady") {
        let secret = secret.ok_or_else(|| PeerError::new("INVALID_PROOF"))?;
        let invitation = Invitation {
            body: b.clone(),
            signature: row.invitation.signature,
            secret,
        }
        .encoded()
        .map_err(unavailable)?;
        let opened: Value = client
            .request("getInvitationProof", &json!({"invitation":invitation}))
            .await?;
        let history = client.lifecycle_proof(repo, opened).await?;
        repo.prepare_join_proof(id, &history).map_err(unavailable)?;
        repo.begin_redemption(id).map_err(unavailable)?
    } else {
        decode_join_proof(
            row.proof
                .as_ref()
                .ok_or_else(|| PeerError::new("INVALID_PROOF"))?
                .as_bytes(),
        )?
    };
    let reply: Value = if recovery {
        client
            .request("getJoinResult", &json!({"joinProof":proof}))
            .await?
    } else {
        let secret = secret.ok_or_else(|| PeerError::new("INVALID_PROOF"))?;
        let invitation = Invitation {
            body: b.clone(),
            signature: row.invitation.signature,
            secret,
        }
        .encoded()
        .map_err(unavailable)?;
        if row.status == "uncertain" {
            let result: Value = client
                .request("getJoinResult", &json!({"joinProof":proof}))
                .await?;
            if result["status"] != "awaitingConfirmation" {
                return finish_join_reply(repo, &mut client, id, &proof, result, true).await;
            }
            let _: Value = client
                .request("getInvitationProof", &json!({"invitation":invitation}))
                .await?;
        }
        client
            .request(
                "redeemInvitation",
                &json!({"invitation":invitation,"joinProof":proof}),
            )
            .await?
    };
    finish_join_reply(repo, &mut client, id, &proof, reply, !recovery).await
}
async fn finish_join_reply(
    repo: &Repository,
    client: &mut PeerClient,
    id: AttemptId,
    proof: &JoinProof,
    reply: Value,
    trusted: bool,
) -> Result<()> {
    match reply["status"].as_str() {
        Some("admitted") => {
            let record =
                decode_record(&serde_json::to_vec(&reply["record"]).map_err(unavailable)?)?;
            let history = client.lifecycle_proof(repo, reply).await?;
            let expected = repo
                .join_material(id)
                .map_err(unavailable)?
                .0
                .invitation
                .body
                .issuer_public_key;
            if history
                .member(id.issuer)
                .is_none_or(|m| m.public_key != expected)
                || !matches!(record.body(),RecordBody::AdmitMember{payload,..} if *payload.join_proof==*proof)
                || history.record(record.id()).is_none()
            {
                return Err(PeerError::new("INVALID_PROOF"));
            }
            repo.finish_join(id, (*history).clone(), record.id())
                .map_err(unavailable)?;
            for address in repo
                .join_material(id)
                .map_err(unavailable)?
                .0
                .invitation
                .body
                .endpoints
            {
                repo.set_peer_address(history.network_id(), id.issuer, &address)
                    .map_err(unavailable)?;
            }
            Ok(())
        }
        Some("denied") if trusted => repo.finish_join_denied(id).map_err(unavailable),
        Some("awaitingConfirmation") => Ok(()),
        _ => Err(PeerError::new("DELIVERY_UNCERTAIN")),
    }
}

pub(super) async fn recover_join(
    repo: &Repository,
    shared: &Arc<Shared>,
    id: AttemptId,
) -> Result<()> {
    if repo
        .expire_join(id, chrono::Utc::now())
        .map_err(unavailable)?
    {
        return Ok(());
    }
    let (row, _) = repo.join_material(id).map_err(unavailable)?;
    for address in row.invitation.body.endpoints {
        if join_at(repo, shared, id, &address, false).await.is_ok() {
            return Ok(());
        }
        if row.status == "uncertain" && join_at(repo, shared, id, &address, true).await.is_ok() {
            return Ok(());
        }
    }
    Err(PeerError::new("UNAVAILABLE"))
}

pub(super) async fn deliver_at(
    repo: &Repository,
    shared: &Arc<Shared>,
    task: &DepartureTask,
    address: &str,
) -> Result<()> {
    let original = repo
        .retained_history(task.network, &[task.record])
        .map_err(unavailable)?;
    let local = original
        .member(task.member)
        .ok_or_else(|| PeerError::new("INVALID_PROOF"))?
        .public_key;
    let mut client = PeerClient::open_identity(
        repo,
        address,
        Some(task.public),
        true,
        shared,
        local,
        (uuid::Uuid::nil(), task.network, task.member),
        true,
    )
    .await?;
    client.hello = client
        .request(
            "hello",
            &Hello::Proof {
                protocol_version: 1,
                network_id: task.network,
                membership_id: Some(task.member),
                purpose: ProofPurpose::Departure,
            },
        )
        .await?;
    let mut opened: Value = client
        .request(
            "submitMembershipProof",
            &SubmitMembershipProof::Open {
                purpose: ProofPurpose::Departure,
                membership_id: Some(task.member),
                record_id: Some(task.record),
            },
        )
        .await?;
    if opened["history"].is_null() {
        opened = client
            .write_departure_proof(&original, task.member, task.record)
            .await?;
    }
    let recipient = client.lifecycle_proof(repo, opened).await?;
    if recipient
        .member(task.recipient)
        .is_none_or(|m| m.public_key != task.public)
    {
        return Err(PeerError::new("INVALID_PROOF"));
    }
    let mut reply: Value = client
        .request(
            "getDepartureStatus",
            &json!({"departureRecordId":task.record,"membershipId":task.member}),
        )
        .await?;
    if reply["status"] == "proofRequired" {
        let record = original.record(task.record).unwrap();
        let (record, history) = match consider(
            &recipient,
            record,
            &original.records().cloned().collect::<Vec<_>>(),
            repo.limits,
        )? {
            Decision::Proposed(p) => (record.clone(), p.result().clone()),
            Decision::Duplicate(_) => (record.clone(), original.clone()),
            Decision::HistoryConflict(_) => match repo
                .sign_departure_rebase(task.record, &recipient)
                .map_err(unavailable)?
            {
                PreparedDepartureResult::Signed(r) => {
                    let Decision::Proposed(p) = consider(&recipient, &r, &[], repo.limits)? else {
                        return Err(PeerError::new("INVALID_PROOF"));
                    };
                    (*r, p.result().clone())
                }
                PreparedDepartureResult::Absent { .. } => {
                    return Err(PeerError::new("SYNC_REQUIRED"));
                }
            },
        };
        client
            .write_departure_proof(&history, task.member, record.id())
            .await?;
        reply=client.request("deliverDeparture",&json!({"departureRecordId":task.record,"record":serde_json::from_slice::<Value>(record.encoded()).map_err(unavailable)?})).await?;
    }
    let ack: DepartureAck = serde_json::from_value(reply["acknowledgement"].clone())
        .map_err(|_| PeerError::new("INVALID_PROOF"))?;
    let context = client.lifecycle_proof(repo, reply).await?;
    repo.confirm_departure(&ack, &context).map_err(unavailable)
}
pub(super) async fn schedule(
    repo: Repository,
    shared: Arc<Shared>,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {_=stop.changed()=>break,_=interval.tick()=>{}}
        let Ok(_admission) = shared.admission() else {
            continue;
        };
        let _ = repo.expire_invitations();
        let mut tasks = tokio::task::JoinSet::new();
        if let Ok(attempts) = repo.pending_attempts() {
            for id in attempts {
                let r = repo.clone();
                let s = shared.clone();
                tasks.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(45), recover_join(&r, &s, id))
                        .await;
                });
            }
        }
        if let Ok(departures) = repo.departure_tasks() {
            let slots = Arc::new(tokio::sync::Semaphore::new(4));
            for task in departures {
                let r = repo.clone();
                let s = shared.clone();
                let slots = slots.clone();
                tasks.spawn(async move {
                    let Ok(_permit) = slots.acquire_owned().await else {
                        return;
                    };
                    let _ = r.retry_departure(&task);
                    for address in &task.endpoints {
                        if tokio::time::timeout(
                            Duration::from_secs(20),
                            deliver_at(&r, &s, &task, address),
                        )
                        .await
                        .is_ok_and(|r| r.is_ok())
                        {
                            break;
                        }
                    }
                });
            }
        }
        while !tasks.is_empty() {
            tokio::select! {_=stop.changed()=>{tasks.abort_all();return;},_=tasks.join_next()=>{}}
        }
    }
}
