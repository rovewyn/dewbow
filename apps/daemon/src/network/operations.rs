use super::{Repository, keys::KeyFiles, repository::*, types::*, validation};
use anyhow::ensure;
use dewbow_protocol::network::*;
use ed25519_dalek::VerifyingKey;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub struct InvitationResult {
    pub invitation: PublicInvitation,
    pub secret: Option<zeroize::Zeroizing<[u8; 32]>>,
    pub status: String,
}
pub enum IssuerJoinResult {
    Admitted(Box<SignedRecord>),
    Denied,
}

impl Repository {
    pub fn issuer_join_result(
        &self,
        proof: &JoinProof,
    ) -> anyhow::Result<Option<IssuerJoinResult>> {
        issuer_terminal(&self.db.lock().unwrap(), proof)
    }
    pub fn create_invitation(
        &self,
        intent: &Intent,
        endpoints: Vec<String>,
    ) -> anyhow::Result<InvitationResult> {
        ensure!(
            intent.operation == "createInvitation",
            "Wrong invitation intent"
        );
        self.transaction(|tx| {
            let (issuer,id)=if let Some(result)=intent_result(tx,intent)? {
                (MembershipId::parse(result["issuerMembershipId"].as_str().ok_or_else(||anyhow::anyhow!("Missing issuer"))?)?,Nonce::parse(result["invitationId"].as_str().ok_or_else(||anyhow::anyhow!("Missing invitation"))?)?)
            } else {
                let selected=current(tx,self.limits)?.ok_or_else(||anyhow::anyhow!("No active Network"))?;
                ensure!(selected.status()==SelectionStatus::Active,"Inactive invitation issuer");
                let key:String=tx.query_row("SELECT key_id FROM network_selections WHERE selection_id=?",[selected.selection_id().to_string()],|r|r.get(0))?;
                let public=selected.history().member(selected.local_member()).unwrap().public_key;
                let mut secret=zeroize::Zeroizing::new([0u8;32]);getrandom::fill(secret.as_mut())?;
                let mut id=[0u8;32];getrandom::fill(&mut id)?;let id=Nonce::from_bytes(id);
                let now=chrono::Utc::now();
                let body=InvitationBody {protocol_version:1,network_id:selected.history().network_id(),issuer_membership_id:selected.local_member(),issuer_public_key:public,history_id:selected.history().snapshot().history_id,invitation_frontier:selected.history().snapshot().frontier.clone(),invitation_id:id,issued_at:now.format("%Y-%m-%dT%H:%M:%SZ").to_string(),expires_at:(now+chrono::Duration::seconds(600)).format("%Y-%m-%dT%H:%M:%SZ").to_string(),credential_hash:Nonce::from_bytes(Sha256::digest(secret.as_slice()).into()),endpoints};
                let invitation=KeyFiles::new(&self.state).sign_invitation(&key,body)?;
                insert_intent(tx,intent)?;
                tx.execute("INSERT INTO network_invitations VALUES(?1,?2,?3,?4,?5,'live',NULL,?6)",params![selected.local_member().as_bytes().as_slice(),id.as_bytes().as_slice(),serde_jcs::to_string(&invitation)?,secret.as_slice(),invitation.body.expires_at,dewbow_protocol::now()])?;
                finish_intent(tx,&intent.request_id,"succeeded",&json!({"invitationId":id,"issuerMembershipId":selected.local_member()}))?;
                (selected.local_member(),id)
            };
            let (encoded,secret,status):(String,Option<Vec<u8>>,String)=tx.query_row("SELECT public_invitation_json,secret,status FROM network_invitations WHERE issuer_membership_id=?1 AND invitation_id=?2",params![issuer.as_bytes().as_slice(),id.as_bytes().as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            let invitation:PublicInvitation=serde_json::from_str(&encoded)?;
            if status=="live" && chrono::Utc::now()>=timestamp(&invitation.body.expires_at)? {
                tx.execute("UPDATE network_invitations SET status='expired',secret=NULL WHERE issuer_membership_id=?1 AND invitation_id=?2",params![issuer.as_bytes().as_slice(),id.as_bytes().as_slice()])?;
                return Ok(InvitationResult {invitation,secret:None,status:"expired".into()});
            }
            Ok(InvitationResult {invitation,secret:secret.map(|s|s.try_into().map(zeroize::Zeroizing::new)).transpose().map_err(|_|anyhow::anyhow!("Invalid private credential"))?,status})
        })
    }

    /// The local authenticated operator must have confirmed the exact join proof.
    pub fn commit_confirmed_admission(
        &self,
        intent: &Intent,
        proof: &JoinProof,
        proposal: &Proposal,
        admission: RecordId,
    ) -> anyhow::Result<SignedRecord> {
        ensure!(
            intent.operation == "confirmNetworkJoin",
            "Wrong admission intent"
        );
        self.transaction(|tx| {
            intent_result(tx,intent)?;
            if let Some(result)=issuer_terminal(tx,proof)? {
                let IssuerJoinResult::Admitted(record)=result else {anyhow::bail!("Original join attempt was denied");};
                retain_issuer_retry(tx,intent,proof,Some(record.id()))?;
                return Ok(*record);
            }
            let selected=current(tx,self.limits)?.ok_or_else(||anyhow::anyhow!("No active Network"))?;
            ensure!(selected.status()==SelectionStatus::Active && selected.local_member()==proof.body.issuer_membership_id,"Inactive or different issuer");
            let (encoded,status):(String,String)=tx.query_row("SELECT public_invitation_json,status FROM network_invitations WHERE issuer_membership_id=?1 AND invitation_id=?2",params![proof.body.issuer_membership_id.as_bytes().as_slice(),proof.body.invitation_id.as_bytes().as_slice()],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let invitation:PublicInvitation=serde_json::from_str(&encoded)?;
            let now=chrono::Utc::now();
            ensure!(status=="live" && now>=timestamp(&invitation.body.issued_at)? && now<timestamp(&invitation.body.expires_at)?,"Invitation unavailable");
            ensure!(proof.body.invitation_history_id==invitation.body.history_id && proof.body.invitation_frontier==invitation.body.invitation_frontier,"Invitation context changed");
            let record=proposal.result().record(admission).ok_or_else(||anyhow::anyhow!("Admission missing"))?;
            ensure!(record.body().operation_id()==intent.operation_id,"Admission operation changed");
            ensure!(matches!(record.body(),RecordBody::AdmitMember {payload,..} if *payload.join_proof==*proof),"Admission proof changed");
            let next=selected.after_adoption(proposal)?;
            let key:String=tx.query_row("SELECT key_id FROM network_selections WHERE selection_id=?",[selected.selection_id().to_string()],|r|r.get(0))?;
            insert_intent(tx,intent)?;
            save_selection(tx,&next,&key)?;
            insert_issuer_attempt(tx,intent,proof,&invitation,"admitted",Some(admission))?;
            tx.execute("UPDATE network_invitations SET status='consumed',secret=NULL,consumed_attempt_id=?1 WHERE issuer_membership_id=?2 AND invitation_id=?3",params![proof.body.join_attempt_id.as_bytes().as_slice(),proof.body.issuer_membership_id.as_bytes().as_slice(),proof.body.invitation_id.as_bytes().as_slice()])?;
            finish_intent(tx,&intent.request_id,"succeeded",&json!({"recordId":admission,"joinAttemptId":proof.body.join_attempt_id,"issuerMembershipId":proof.body.issuer_membership_id}))?;
            Ok(record.clone())
        })
    }

    pub fn record_join_denial(&self, intent: &Intent, proof: &JoinProof) -> anyhow::Result<()> {
        ensure!(
            intent.operation == "confirmNetworkJoin",
            "Wrong confirmation intent"
        );
        decode_join_proof(&serde_json::to_vec(proof)?)?;
        self.transaction(|tx| {
            intent_result(tx,intent)?;
            if let Some(result)=issuer_terminal(tx,proof)? {
                ensure!(matches!(result,IssuerJoinResult::Denied),"Admission already settled");
                retain_issuer_retry(tx,intent,proof,None)?;
                return Ok(());
            }
            let selected=current(tx,self.limits)?.ok_or_else(||anyhow::anyhow!("No active issuer"))?;
            ensure!(selected.status()==SelectionStatus::Active && selected.local_member()==proof.body.issuer_membership_id,"Inactive or different issuer");
            let encoded:String=tx.query_row("SELECT public_invitation_json FROM network_invitations WHERE issuer_membership_id=?1 AND invitation_id=?2 AND status='live'",params![proof.body.issuer_membership_id.as_bytes().as_slice(),proof.body.invitation_id.as_bytes().as_slice()],|r|r.get(0))?;
            let invitation:PublicInvitation=serde_json::from_str(&encoded)?;
            ensure!(chrono::Utc::now()<timestamp(&invitation.body.expires_at)? && proof.body.invitation_history_id==invitation.body.history_id && proof.body.invitation_frontier==invitation.body.invitation_frontier,"Invitation unavailable");
            insert_intent(tx,intent)?;
            insert_issuer_attempt(tx,intent,proof,&invitation,"denied",None)?;
            finish_intent(tx,&intent.request_id,"succeeded",&json!({"code":"DENIED","joinAttemptId":proof.body.join_attempt_id,"issuerMembershipId":proof.body.issuer_membership_id}))?;
            Ok(())
        })
    }

    pub fn bind_outbound(
        &self,
        scope: &ReceiptScope,
        target: HostId,
        operation: &str,
        fingerprint: [u8; 32],
    ) -> anyhow::Result<()> {
        ensure!(
            Some(scope.source_host_id) == self.host,
            "Foreign source host"
        );
        self.transaction(|tx| {
            let old:Option<(String,String,Vec<u8>)>=tx.query_row("SELECT target_host_id,operation,fingerprint FROM network_outbound_requests WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((host,op,input))=old {ensure!(host==target.to_string() && op==operation && input==fingerprint,"REQUEST_CONFLICT: original target or input changed");}
            else {tx.execute("INSERT INTO network_outbound_requests VALUES(?1,?2,?3,?4,?5,?6,'prepared',NULL,?7)",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id,target.to_string(),operation,fingerprint.as_slice(),dewbow_protocol::now()])?;}
            Ok(())
        })
    }

    pub fn begin_dispatch(&self, scope: &ReceiptScope) -> anyhow::Result<()> {
        self.transaction(|tx| {ensure!(tx.execute("UPDATE network_outbound_requests SET dispatch_state='uncertain' WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3 AND dispatch_state IN ('prepared','uncertain')",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id])?==1,"Dispatch binding unavailable");Ok(())})
    }

    /// Target-owned delivery receipt; this method never starts native work.
    pub fn retain_receipt(
        &self,
        scope: &ReceiptScope,
        operation: &str,
        fingerprint: [u8; 32],
        receipt: &Value,
        recovery: Option<&RecoveryRefs>,
    ) -> anyhow::Result<Value> {
        let target = self
            .host
            .ok_or_else(|| anyhow::anyhow!("Missing target host"))?;
        self.transaction(|tx| {
            if let Some((op,input,old))=tx.query_row("SELECT operation,fingerprint,receipt_json FROM network_request_receipts WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?,r.get::<_,String>(2)?))).optional()? {ensure!(op==operation && input==fingerprint,"REQUEST_CONFLICT: retained receipt input changed");return Ok(serde_json::from_str(&old)?);}
            crate::store::validate_record("operation",&scope.request_id,receipt)?;
            tx.execute("INSERT INTO network_request_receipts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id,target.to_string(),operation,fingerprint.as_slice(),receipt["commandId"].as_str().unwrap(),receipt.to_string(),recovery.map(serde_json::to_string).transpose()?,receipt["createdAt"].as_str().unwrap()])?;
            Ok(receipt.clone())
        })
    }

    pub fn request_receipt(&self, scope: &ReceiptScope) -> anyhow::Result<Option<Value>> {
        let db = self.db.lock().unwrap();
        let value:Option<String>=db.query_row("SELECT receipt_json FROM network_request_receipts WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id],|r|r.get(0)).optional()?;
        value
            .map(|v| serde_json::from_str(&v).map_err(Into::into))
            .transpose()
    }

    pub fn settle_receipt(
        &self,
        scope: &ReceiptScope,
        receipt: &Value,
        recovery: Option<&RecoveryRefs>,
    ) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let old:String=tx.query_row("SELECT receipt_json FROM network_request_receipts WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id],|r|r.get(0))?;
            let old:Value=serde_json::from_str(&old)?;
            for field in ["requestId","commandId","operation","sessionId","fingerprint","createdAt"] {ensure!(receipt[field]==old[field],"Receipt identity changed");}
            ensure!(!matches!(old["status"].as_str(),Some("delivered"|"error")) || old==*receipt,"A settled receipt cannot be rewritten");
            tx.execute("UPDATE network_request_receipts SET receipt_json=?1,recovery_refs_json=?2 WHERE network_id=?3 AND source_host_id=?4 AND request_id=?5",params![receipt.to_string(),recovery.map(serde_json::to_string).transpose()?,scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id])?;Ok(())
        })
    }

    pub fn set_peer_address(
        &self,
        network: NetworkId,
        member: MembershipId,
        address: &str,
    ) -> anyhow::Result<()> {
        endpoint(address)?;
        self.transaction(|tx| {
            tx.execute("INSERT INTO network_contacts VALUES(?1,?2,?3,1,NULL,NULL) ON CONFLICT(network_id,membership_id,endpoint) DO UPDATE SET explicit_seed=1",params![network.as_bytes().as_slice(),member.as_bytes().as_slice(),address])?;
            ensure!(tx.query_row("SELECT count(*) FROM network_contacts WHERE network_id=?1 AND membership_id=?2",params![network.as_bytes().as_slice(),member.as_bytes().as_slice()],|r|r.get::<_,i64>(0))?<=8,"Too many member contact candidates");Ok(())
        })
    }

    pub fn retain_conflict(&self, evidence: &ConflictEvidence) -> anyhow::Result<()> {
        self.persist_conflict(evidence, None)
    }
    pub(super) fn retain_peer_conflict(
        &self,
        evidence: &ConflictEvidence,
        peer: MembershipId,
    ) -> anyhow::Result<()> {
        self.persist_conflict(evidence, Some(peer))
    }
    fn persist_conflict(
        &self,
        evidence: &ConflictEvidence,
        peer: Option<MembershipId>,
    ) -> anyhow::Result<()> {
        let records: Vec<Value> = evidence
            .foreign_records
            .iter()
            .map(|r| serde_json::from_slice(r.encoded()))
            .collect::<std::result::Result<_, _>>()?;
        let value = json!({"localHistoryId":evidence.local_history_id,"foreignHistoryId":evidence.foreign_history_id,"recordIds":evidence.record_ids,"foreignRecords":records});
        let encoded = serde_jcs::to_string(&value)?;
        let reason = match peer {
            Some(member) => format!("{:?}:peer:{member}", evidence.kind),
            None => format!("{:?}", evidence.kind),
        };
        ensure!(
            encoded.len() <= 16 * 1024 * 1024,
            "Conflict witness too large"
        );
        self.transaction(|tx| {
            tx.execute("INSERT INTO network_conflicts VALUES(?1,?2,?3,?4,?5,?6)",params![dewbow_protocol::id(),evidence.network_id.as_bytes().as_slice(),reason,encoded,encoded.len() as i64,dewbow_protocol::now()])?;
            loop {let (count,size):(i64,i64)=tx.query_row("SELECT count(*),sum(byte_count) FROM network_conflicts",[],|r|Ok((r.get(0)?,r.get(1)?)))?;if count<=64 && size<=16*1024*1024 {break;}tx.execute("DELETE FROM network_conflicts WHERE witness_id=(SELECT witness_id FROM network_conflicts ORDER BY created_at,witness_id LIMIT 1)",[])?;}
            Ok(())
        })
    }

    pub fn sign_departure_rebase(
        &self,
        departure: RecordId,
        recipient: &VerifiedHistory,
    ) -> anyhow::Result<PreparedDepartureResult> {
        let db = self.db.lock().unwrap();
        let (key, network): (String, Vec<u8>) = db.query_row(
            "SELECT key_id,network_id FROM network_departures WHERE departure_record_id=?",
            [departure.as_bytes().as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(
            db.query_row(
                "SELECT storage_status FROM network_keys WHERE key_id=?",
                [&key],
                |r| r.get::<_, String>(0)
            )? == "present",
            "Old key is unavailable"
        );
        let mut q = db.prepare("SELECT selection_id FROM network_selections WHERE network_id=?")?;
        let ids: Vec<String> = q
            .query_map([network], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in ids {
            let selection = validation::selection(&db, &id, self.limits)?;
            if selection.history().record(departure).is_some() {
                return Ok(
                    match prepare_departure_rebase(
                        selection.history(),
                        departure,
                        recipient,
                        self.limits,
                    )? {
                        PreparedDeparture::Absent {
                            membership_id,
                            history_id,
                        } => PreparedDepartureResult::Absent {
                            membership_id,
                            history_id,
                        },
                        PreparedDeparture::Sign(record) => PreparedDepartureResult::Signed(
                            Box::new(KeyFiles::new(&self.state).sign_record(&key, record)?),
                        ),
                    },
                );
            }
        }
        anyhow::bail!("Original departure history unavailable")
    }

    pub fn confirm_departure(
        &self,
        ack: &DepartureAck,
        recipient: &VerifiedHistory,
    ) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let body=&ack.body;
            let (public,member,status):(Vec<u8>,Vec<u8>,String)=tx.query_row("SELECT t.recipient_public_key,d.membership_id,t.status FROM network_departure_tasks t JOIN network_departures d USING(departure_record_id) WHERE t.departure_record_id=?1 AND t.recipient_membership_id=?2",params![body.departure_record_id.as_bytes().as_slice(),body.recipient_membership_id.as_bytes().as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            ensure!(body.protocol_version==1 && recipient.network_id()==body.network_id && recipient.snapshot().history_id==body.history_id && body.membership_id.as_bytes().as_slice()==member,"Wrong departure acknowledgement context");
            let recipient_member=recipient.member(body.recipient_membership_id).ok_or_else(||anyhow::anyhow!("Recipient generation absent"))?;
            ensure!(recipient_member.public_key.as_bytes().as_slice()==public,"Replacement recipient cannot acknowledge");
            ensure!((body.status=="absent" && !recipient.is_active(body.membership_id)) || (body.status=="recipientInactive" && !recipient.is_active(body.recipient_membership_id)),"Acknowledgement does not establish absence");
            let mut signed=b"dewbow.network.departureAck.v1\0".to_vec();signed.extend(serde_jcs::to_vec(body)?);
            VerifyingKey::from_bytes(recipient_member.public_key.as_bytes())?.verify_strict(&signed,&ed25519_dalek::Signature::from_bytes(ack.signature.as_bytes()))?;
            if status=="confirmed" {return Ok(());}
            ensure!(status=="pending","Departure task was abandoned");
            tx.execute("UPDATE network_departure_tasks SET status='confirmed',acknowledgement_json=?1,next_attempt_at=NULL WHERE departure_record_id=?2 AND recipient_membership_id=?3",params![serde_jcs::to_string(ack)?,body.departure_record_id.as_bytes().as_slice(),body.recipient_membership_id.as_bytes().as_slice()])?;Ok(())
        })
    }

    /// Construct only a control acknowledgement from retained local authority.
    /// Foreign departure proof remains transient and cannot select local history.
    pub fn sign_departure_ack(
        &self,
        selection_id: &str,
        departure: RecordId,
        withdrawn: &VerifiedHistory,
    ) -> anyhow::Result<DepartureAck> {
        let db = self.db.lock().unwrap();
        let selected = validation::selection(&db, selection_id, self.limits)?;
        let record = withdrawn
            .record(departure)
            .ok_or_else(|| anyhow::anyhow!("Departure proof missing"))?;
        let RecordBody::LeaveNetwork {
            network_id,
            author_membership_id,
            ..
        } = record.body()
        else {
            anyhow::bail!("Not a self departure");
        };
        ensure!(
            *network_id == selected.history().network_id() && withdrawn.network_id() == *network_id,
            "Foreign departure Network"
        );
        let status = if selected.status() != SelectionStatus::Active {
            "recipientInactive"
        } else {
            ensure!(
                !selected.history().is_active(*author_membership_id),
                "Departure is not established locally"
            );
            "absent"
        };
        let key: String = db.query_row(
            "SELECT key_id FROM network_selections WHERE selection_id=?",
            [selection_id],
            |r| r.get(0),
        )?;
        ensure!(
            db.query_row(
                "SELECT storage_status FROM network_keys WHERE key_id=?",
                [&key],
                |r| r.get::<_, String>(0)
            )? == "present",
            "Acknowledgement key unavailable"
        );
        let public = selected
            .history()
            .member(selected.local_member())
            .unwrap()
            .public_key;
        KeyFiles::new(&self.state).sign_ack(
            &key,
            public,
            DepartureAckBody {
                protocol_version: 1,
                network_id: *network_id,
                departure_record_id: departure,
                membership_id: *author_membership_id,
                recipient_membership_id: selected.local_member(),
                history_id: selected.history().snapshot().history_id,
                status: status.into(),
            },
        )
    }
}

pub enum PreparedDepartureResult {
    Absent {
        membership_id: MembershipId,
        history_id: HistoryId,
    },
    Signed(Box<SignedRecord>),
}

fn issuer_terminal(
    db: &rusqlite::Connection,
    proof: &JoinProof,
) -> anyhow::Result<Option<IssuerJoinResult>> {
    let row:Option<(String,Vec<u8>,Option<Vec<u8>>)>=db.query_row("SELECT status,fingerprint,result_record_id FROM network_join_attempts WHERE role='issuer' AND issuer_membership_id=?1 AND join_attempt_id=?2",params![proof.body.issuer_membership_id.as_bytes().as_slice(),proof.body.join_attempt_id.as_bytes().as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((status, fingerprint, result)) = row {
        ensure!(
            fingerprint == Sha256::digest(serde_jcs::to_vec(proof)?).as_slice(),
            "REQUEST_CONFLICT: changed join attempt"
        );
        if status == "denied" {
            return Ok(Some(IssuerJoinResult::Denied));
        }
        ensure!(status == "admitted", "Invalid issuer result");
        let encoded: String = db.query_row(
            "SELECT envelope_json FROM network_records WHERE record_id=?",
            [result.unwrap()],
            |r| r.get(0),
        )?;
        return Ok(Some(IssuerJoinResult::Admitted(Box::new(decode_record(
            encoded.as_bytes(),
        )?))));
    }
    Ok(None)
}
fn retain_issuer_retry(
    tx: &rusqlite::Transaction<'_>,
    intent: &Intent,
    proof: &JoinProof,
    admission: Option<RecordId>,
) -> anyhow::Result<()> {
    let result = if let Some(id) = admission {
        json!({"recordId":id,"joinAttemptId":proof.body.join_attempt_id,"issuerMembershipId":proof.body.issuer_membership_id})
    } else {
        json!({"code":"DENIED","joinAttemptId":proof.body.join_attempt_id,"issuerMembershipId":proof.body.issuer_membership_id})
    };
    if let Some(old) = intent_result(tx, intent)? {
        ensure!(old == result, "REQUEST_CONFLICT: management result changed");
        return Ok(());
    }
    insert_intent(tx, intent)?;
    finish_intent(tx, &intent.request_id, "succeeded", &result)
}
fn insert_issuer_attempt(
    tx: &rusqlite::Transaction<'_>,
    intent: &Intent,
    proof: &JoinProof,
    invitation: &PublicInvitation,
    status: &str,
    result: Option<RecordId>,
) -> anyhow::Result<()> {
    tx.execute("INSERT INTO network_join_attempts VALUES('issuer',?1,?2,?3,?4,?5,?6,NULL,?7,NULL,?8,?9,?10,?11,?12)",params![proof.body.issuer_membership_id.as_bytes().as_slice(),proof.body.join_attempt_id.as_bytes().as_slice(),proof.body.invitation_id.as_bytes().as_slice(),intent.request_id,proof.body.host_id.to_string(),proof.body.public_key.as_bytes().as_slice(),serde_jcs::to_string(invitation)?,Sha256::digest(serde_jcs::to_vec(proof)?).as_slice(),serde_jcs::to_string(proof)?,status,result.map(|id|id.as_bytes().to_vec()),dewbow_protocol::now()])?;
    Ok(())
}
