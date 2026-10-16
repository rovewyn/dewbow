use super::{keys::KeyFiles, types::*, validation};
use crate::store::INVALID_STATE;
use anyhow::ensure;
use dewbow_protocol::network::*;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// Shares the daemon's existing connection and serialization; no second runtime store.
#[derive(Clone)]
pub struct Repository {
    pub(crate) observations: Arc<
        Mutex<std::collections::BTreeMap<(NetworkId, MembershipId), super::lifecycle::Observation>>,
    >,
    pub(crate) pending: Arc<Mutex<std::collections::BTreeMap<Nonce, super::lifecycle::Pending>>>,
    pub(crate) changed: Arc<tokio::sync::Notify>,
    pub(crate) db: Arc<Mutex<Connection>>,
    pub(crate) state: PathBuf,
    pub(crate) host: Option<HostId>,
    pub(crate) limits: Limits,
}
impl Repository {
    pub(crate) fn new(
        db: Arc<Mutex<Connection>>,
        state: &Path,
        host: Option<HostId>,
        limits: Limits,
    ) -> anyhow::Result<Self> {
        let repo = Self {
            observations: Default::default(),
            pending: Default::default(),
            changed: Arc::new(tokio::sync::Notify::new()),
            db,
            state: state.into(),
            host,
            limits,
        };
        repo.validate()?;
        Ok(repo)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        validation::validate(
            &self.db.lock().unwrap(),
            &self.state,
            self.host,
            self.limits,
        )
    }

    pub(crate) fn transaction<T>(
        &self,
        action: impl FnOnce(&Transaction<'_>) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let before: String = tx.query_row("SELECT coalesce(current_selection_id,'') || coalesce(hex(history_id),'') || coalesce(status,'') FROM network_settings LEFT JOIN network_selections ON selection_id=current_selection_id", [], |r|r.get(0))?;
        let result = action(&tx)?;
        validation::validate(&tx, &self.state, self.host, self.limits)?;
        let after: String = tx.query_row("SELECT coalesce(current_selection_id,'') || coalesce(hex(history_id),'') || coalesce(status,'') FROM network_settings LEFT JOIN network_selections ON selection_id=current_selection_id", [], |r|r.get(0))?;
        tx.commit()?;
        if before != after {
            self.changed.notify_waiters();
        }
        Ok(result)
    }

    pub fn current_selection(&self) -> anyhow::Result<Option<LocalSelection>> {
        let db = self.db.lock().unwrap();
        let id: Option<String> = db.query_row(
            "SELECT current_selection_id FROM network_settings",
            [],
            |r| r.get(0),
        )?;
        id.map(|id| validation::selection(&db, &id, self.limits))
            .transpose()
    }

    pub fn request_result(&self, intent: &Intent) -> anyhow::Result<Option<Value>> {
        intent_result(&self.db.lock().unwrap(), intent)
    }

    /// Authorized local orchestration calls this; no CLI/HTTP entry is added by storage.
    pub fn create_network(
        &self,
        intent: &Intent,
        name: String,
        nonce: Nonce,
    ) -> anyhow::Result<Value> {
        ensure!(
            intent.operation == "createNetwork",
            "Wrong management intent"
        );
        if let Some(result) = self.request_result(intent)? {
            return Ok(result);
        }
        let host = self.host.ok_or_else(|| anyhow::anyhow!(INVALID_STATE))?;
        let (key_id, public) = KeyFiles::new(&self.state).create()?;
        #[cfg(test)]
        super::migration::checkpoint("keyPublished")?;
        let genesis = KeyFiles::new(&self.state)
            .sign_record(&key_id, prepare_genesis(nonce, name, host, public)?)?;
        let history = verify_history(
            genesis.id().into(),
            std::slice::from_ref(&genesis),
            self.limits,
        )?;
        self.transaction(|tx| {
            if let Some(result)=intent_result(tx,intent)? { return Ok(result); }
            ensure_no_pending_join(tx)?;
            let previous=current(tx,self.limits)?;
            let plan=plan_fresh_selection(previous.as_ref(),uuid::Uuid::new_v4(),history,ConfirmedLocalAdmission::from_local_confirmation(host,genesis.id().into()))?;
            insert_key(tx,&key_id,public)?;
            insert_intent(tx,intent)?;
            save_selection(tx,&plan.current,&key_id)?;
            let result=json!({"recordId":genesis.id(),"selectionId":plan.current.selection_id().to_string()});
            finish_intent(tx,&intent.request_id,"succeeded",&result)?;
            Ok(result)
        })
    }

    pub fn prepare_join_attempt(
        &self,
        intent: &Intent,
        invitation: &PublicInvitation,
        secret: [u8; 32],
        attempt: Nonce,
    ) -> anyhow::Result<AttemptId> {
        ensure!(intent.operation == "joinNetwork", "Wrong management intent");
        invitation.validate()?;
        ensure!(
            *invitation.body.credential_hash.as_bytes() == <[u8; 32]>::from(Sha256::digest(secret)),
            "Invitation credential mismatch"
        );
        let id = AttemptId {
            issuer: invitation.body.issuer_membership_id,
            attempt,
        };
        let host = self.host.ok_or_else(|| anyhow::anyhow!(INVALID_STATE))?;
        let mut db = self.db.lock().unwrap();
        if let Some(value) = intent_result(&db, intent)? {
            return Ok(AttemptId {
                issuer: MembershipId::parse(
                    value["issuerMembershipId"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!(INVALID_STATE))?,
                )?,
                attempt: Nonce::parse(
                    value["joinAttemptId"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!(INVALID_STATE))?,
                )?,
            });
        }
        let now = chrono::Utc::now();
        ensure!(
            now >= timestamp(&invitation.body.issued_at)?
                && now < timestamp(&invitation.body.expires_at)?,
            "Invitation is not currently usable"
        );
        ensure_no_pending_join(&db)?;
        ensure!(
            current(&db, self.limits)?.is_none_or(|s| s.status() != SelectionStatus::Active),
            "Leave the active Network before joining"
        );
        let (key_id, public) = KeyFiles::new(&self.state).create()?;
        let tx = db.transaction()?;
        insert_key(&tx, &key_id, public)?;
        insert_intent(&tx, intent)?;
        let result = json!({"joinAttemptId":attempt,"issuerMembershipId":id.issuer});
        tx.execute(
            "UPDATE network_requests SET result_refs_json=? WHERE request_id=?",
            params![result.to_string(), intent.request_id],
        )?;
        tx.execute("INSERT INTO network_join_attempts VALUES('joiner',?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,'prepared',NULL,?11)",params![id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice(),invitation.body.invitation_id.as_bytes().as_slice(),intent.request_id,host.to_string(),public.as_bytes().as_slice(),key_id,serde_jcs::to_string(invitation)?,secret.as_slice(),intent.fingerprint.as_slice(),dewbow_protocol::now()])?;
        validation::validate(&tx, &self.state, self.host, self.limits)?;
        tx.commit()?;
        Ok(id)
    }

    pub fn prepare_join_proof(
        &self,
        id: AttemptId,
        issuance: &VerifiedHistory,
    ) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let row=join_row(tx,id)?;
            ensure!(matches!(row.status.as_str(),"prepared"|"proofReady"), "Attempt cannot prepare a proof");
            ensure!(issuance.network_id()==row.invitation.body.network_id && issuance.snapshot().history_id==row.invitation.body.history_id && issuance.snapshot().frontier==row.invitation.body.invitation_frontier,"Invitation history mismatch");
            let prepared=prepare_join(issuance,id.issuer,row.invitation.body.invitation_id,id.attempt,HostId::parse(&row.host)?,row.public)?;
            let proof=KeyFiles::new(&self.state).sign_join(&row.key,prepared)?;
            let encoded=serde_jcs::to_string(&proof)?;
            if row.status=="proofReady" { ensure!(row.proof.as_deref()==Some(&encoded),"Join proof retry changed"); }
            tx.execute("UPDATE network_join_attempts SET join_proof_json=?1,status='proofReady' WHERE role='joiner' AND issuer_membership_id=?2 AND join_attempt_id=?3",params![encoded,id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice()])?;
            Ok(())
        })
    }

    /// The proof cannot leave this repository until uncertainty is durably committed.
    pub fn begin_redemption(&self, id: AttemptId) -> anyhow::Result<JoinProof> {
        self.transaction(|tx| {
            let row=join_row(tx,id)?;
            ensure!(matches!(row.status.as_str(),"proofReady"|"uncertain"),"Attempt cannot redeem");
            if row.status=="proofReady" { ensure!(chrono::Utc::now()<timestamp(&row.invitation.body.expires_at)?,"Invitation expired before submission"); }
            KeyFiles::new(&self.state).validate(&row.key,row.public)?;
            let proof=decode_join_proof(row.proof.as_deref().ok_or_else(||anyhow::anyhow!(INVALID_STATE))?.as_bytes())?;
            tx.execute("UPDATE network_join_attempts SET status='uncertain' WHERE role='joiner' AND issuer_membership_id=?1 AND join_attempt_id=?2",params![id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice()])?;
            Ok(proof)
        })
    }

    pub fn expire_join(
        &self,
        id: AttemptId,
        now: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<bool> {
        self.transaction(|tx| {
            let row=join_row(tx,id)?;
            if row.status=="expired" { return Ok(true); }
            if !matches!(row.status.as_str(),"prepared"|"proofReady") || now<timestamp(&row.invitation.body.expires_at)? {return Ok(false);}
            tx.execute("UPDATE network_join_attempts SET status='expired',credential_secret=NULL WHERE role='joiner' AND issuer_membership_id=?1 AND join_attempt_id=?2",params![id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice()])?;
            finish_intent(tx,&row.request,"failed",&json!({"joinAttemptId":id.attempt,"issuerMembershipId":id.issuer,"code":"INVITATION_EXPIRED"}))?;
            Ok(true)
        })
    }

    pub fn finish_join(
        &self,
        id: AttemptId,
        history: VerifiedHistory,
        admission: RecordId,
    ) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let row=join_row(tx,id)?;
            if row.status=="admitted" { ensure!(row.result.as_deref()==Some(admission.as_bytes().as_slice()),"Join result changed"); return Ok(()); }
            ensure!(row.status=="uncertain", "Join was not submitted");
            let record=history.record(admission).ok_or_else(||anyhow::anyhow!(INVALID_STATE))?;
            let proof=decode_join_proof(row.proof.as_ref().unwrap().as_bytes())?;
            ensure!(matches!(record.body(),RecordBody::AdmitMember {payload,..} if *payload.join_proof==proof),"Original admission proof mismatch");
            let previous=current(tx,self.limits)?;
            let plan=plan_fresh_selection(previous.as_ref(),uuid::Uuid::new_v4(),history,ConfirmedLocalAdmission::from_local_confirmation(HostId::parse(&row.host)?,admission.into()))?;
            save_selection(tx,&plan.current,&row.key)?;
            tx.execute("UPDATE network_join_attempts SET status='admitted',result_record_id=?1,credential_secret=NULL WHERE role='joiner' AND issuer_membership_id=?2 AND join_attempt_id=?3",params![admission.as_bytes().as_slice(),id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice()])?;
            finish_intent(tx,&row.request,"succeeded",&json!({"joinAttemptId":id.attempt,"issuerMembershipId":id.issuer,"recordId":admission}))?;
            Ok(())
        })
    }

    pub fn commit_adoption(&self, selection_id: &str, proposal: &Proposal) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let old = validation::selection(tx, selection_id, self.limits)?;
            ensure!(
                current_id(tx)?.as_deref() == Some(selection_id),
                "Selection is no longer current"
            );
            let next = old.after_adoption(proposal)?;
            let key: String = tx.query_row(
                "SELECT key_id FROM network_selections WHERE selection_id=?",
                [selection_id],
                |r| r.get(0),
            )?;
            save_selection(tx, &next, &key)?;
            Ok(())
        })
    }

    pub fn detach_inactive(&self, intent: &Intent) -> anyhow::Result<Value> {
        ensure!(
            matches!(
                intent.operation.as_str(),
                "leaveNetwork" | "removeNetworkMember"
            ),
            "Wrong inactive exit intent"
        );
        self.transaction(|tx| {
            if let Some(value) = intent_result(tx, intent)? {
                return Ok(value);
            }
            let selected =
                current(tx, self.limits)?.ok_or_else(|| anyhow::anyhow!("No selected Network"))?;
            let next = selected.detach_inactive()?;
            let key: String = tx.query_row(
                "SELECT key_id FROM network_selections WHERE selection_id=?",
                [selected.selection_id().to_string()],
                |r| r.get(0),
            )?;
            insert_intent(tx, intent)?;
            save_selection(tx, &next, &key)?;
            let result =
                json!({"selectionId":next.selection_id().to_string(),"code":"ALREADY_INACTIVE"});
            finish_intent(tx, &intent.request_id, "succeeded", &result)?;
            Ok(result)
        })
    }

    /// Only the peer adapter's authenticated original issuer result may call this.
    /// Local expiry or transport failure is never an issuer denial.
    pub fn finish_join_denied(&self, id: AttemptId) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let row=join_row(tx,id)?;
            if row.status=="denied" {return Ok(());}
            ensure!(row.status=="uncertain", "Join result is not awaiting its issuer");
            tx.execute("UPDATE network_join_attempts SET status='denied',credential_secret=NULL WHERE role='joiner' AND issuer_membership_id=?1 AND join_attempt_id=?2",params![id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice()])?;
            finish_intent(tx,&row.request,"failed",&json!({"joinAttemptId":id.attempt,"issuerMembershipId":id.issuer,"code":"DENIED"}))?;
            Ok(())
        })
    }

    pub fn commit_local_change(
        &self,
        intent: &Intent,
        proposal: &Proposal,
        record_id: RecordId,
    ) -> anyhow::Result<Value> {
        self.transaction(|tx| {
            if let Some(value)=intent_result(tx,intent)? {return Ok(value);}
            let old=current(tx,self.limits)?.ok_or_else(||anyhow::anyhow!("No active selection"))?;
            let record=proposal.result().record(record_id).ok_or_else(||anyhow::anyhow!(INVALID_STATE))?;
            ensure!(record.body().author()==Some(old.local_member()) && record.body().operation_id()==intent.operation_id,"Local change intent mismatch");
            ensure!(matches!((intent.operation.as_str(),record.body()),("removeNetworkMember",RecordBody::RemoveMember{..})|("leaveNetwork",RecordBody::LeaveNetwork{..})|("removeNetworkMember",RecordBody::LeaveNetwork{..})),"Wrong local change kind");
            let next=old.after_adoption(proposal)?;
            let key:String=tx.query_row("SELECT key_id FROM network_selections WHERE selection_id=?",[old.selection_id().to_string()],|r|r.get(0))?;
            insert_intent(tx,intent)?;
            save_selection(tx,&next,&key)?;
            if matches!(record.body(),RecordBody::LeaveNetwork{..}) {
                tx.execute("INSERT INTO network_departures VALUES(?1,?2,?3,?4,?5,?6)",params![record_id.as_bytes().as_slice(),old.history().network_id().as_bytes().as_slice(),old.local_member().as_bytes().as_slice(),record.body().operation_id().unwrap().as_bytes().as_slice(),key,dewbow_protocol::now()])?;
                for recipient in old.history().active_members().filter(|m|m.membership_id!=old.local_member()) {
                    let endpoints:Vec<String>={let mut q=tx.prepare("SELECT endpoint FROM network_contacts WHERE network_id=? AND membership_id=? ORDER BY endpoint LIMIT 8")?;q.query_map(params![old.history().network_id().as_bytes().as_slice(),recipient.membership_id.as_bytes().as_slice()],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?};
                    tx.execute("INSERT INTO network_departure_tasks VALUES(?1,?2,?3,?4,?5,'pending',0,NULL,NULL)",params![record_id.as_bytes().as_slice(),recipient.membership_id.as_bytes().as_slice(),recipient.host_id.to_string(),recipient.public_key.as_bytes().as_slice(),serde_json::to_string(&endpoints)?])?;
                }
            }
            let result=json!({"recordId":record_id});
            finish_intent(tx,&intent.request_id,"succeeded",&result)?;
            Ok(result)
        })
    }

    pub fn sign_active_change(
        &self,
        selection_id: &str,
        operation_id: Nonce,
        change: Change,
    ) -> anyhow::Result<SignedRecord> {
        let db = self.db.lock().unwrap();
        let selected = validation::selection(&db, selection_id, self.limits)?;
        ensure!(
            selected.status() == SelectionStatus::Active
                && current_id(&db)?.as_deref() == Some(selection_id),
            "Inactive signer"
        );
        match prepare_change(
            selected.history(),
            selected.local_member(),
            operation_id,
            change,
            self.limits,
        )? {
            PreparedChange::Existing(record) => Ok(record),
            PreparedChange::Sign(prepared) => {
                let key: String = db.query_row(
                    "SELECT key_id FROM network_selections WHERE selection_id=?",
                    [selection_id],
                    |r| r.get(0),
                )?;
                KeyFiles::new(&self.state).sign_record(&key, prepared)
            }
        }
    }

    pub fn cleanup_key(&self, key_id: &str) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let needed:i64=tx.query_row("SELECT (SELECT count(*) FROM network_selections WHERE key_id=?1 AND status='active')+(SELECT count(*) FROM network_join_attempts WHERE key_id=?1 AND status IN ('prepared','proofReady','uncertain'))+(SELECT count(*) FROM network_departures d JOIN network_departure_tasks t USING(departure_record_id) WHERE d.key_id=?1 AND t.status='pending')",[key_id],|r|r.get(0))?;
            ensure!(needed==0,"Key is required by membership or unresolved recovery");
            tx.execute("UPDATE network_keys SET storage_status='deletePending' WHERE key_id=? AND storage_status='present'",[key_id])?;
            Ok(())
        })?;
        #[cfg(test)]
        super::migration::checkpoint("keyDeletePending")?;
        self.finish_key_deletion(key_id)
    }

    fn finish_key_deletion(&self, key_id: &str) -> anyhow::Result<()> {
        let mut db = self.db.lock().unwrap();
        let status: String = db.query_row(
            "SELECT storage_status FROM network_keys WHERE key_id=?",
            [key_id],
            |r| r.get(0),
        )?;
        if status == "deleted" {
            return Ok(());
        }
        ensure!(status == "deletePending", "Key deletion not authorized");
        let public: Vec<u8> = db.query_row(
            "SELECT public_key FROM network_keys WHERE key_id=?",
            [key_id],
            |r| r.get(0),
        )?;
        KeyFiles::new(&self.state).delete(
            key_id,
            PublicKey::from_bytes(
                public
                    .try_into()
                    .map_err(|_| anyhow::anyhow!(INVALID_STATE))?,
            ),
        )?;
        #[cfg(test)]
        super::migration::checkpoint("keyFileDeleted")?;
        let tx = db.transaction()?;
        tx.execute(
            "UPDATE network_keys SET storage_status='deleted' WHERE key_id=?",
            [key_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn resume_key_deletions(&self) -> anyhow::Result<()> {
        let ids: Vec<String> = {
            let db = self.db.lock().unwrap();
            let mut q =
                db.prepare("SELECT key_id FROM network_keys WHERE storage_status='deletePending'")?;
            q.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut failed = false;
        for key in ids {
            failed |= self.finish_key_deletion(&key).is_err();
        }
        failed |= self.quarantine_unreferenced_keys().is_err();
        ensure!(
            !failed,
            "RECOVERY_REQUIRED: private Network key cleanup remains pending"
        );
        Ok(())
    }

    fn quarantine_unreferenced_keys(&self) -> anyhow::Result<()> {
        use std::fs;
        let directory = self.state.join("network-keys");
        dewbow_sdk::private::no_links(&directory)?;
        if !directory.exists() {
            return Ok(());
        }
        let db = self.db.lock().unwrap();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".pk8").or_else(|| {
                name.strip_prefix('.')
                    .and_then(|v| v.strip_suffix(".stage"))
            });
            let Some(id) =
                id.filter(|id| uuid::Uuid::parse_str(id).is_ok_and(|v| v.to_string() == *id))
            else {
                continue;
            };
            if db.query_row(
                "SELECT EXISTS(SELECT 1 FROM network_keys WHERE key_id=?)",
                [id],
                |r| r.get::<_, bool>(0),
            )? {
                continue;
            }
            dewbow_sdk::private::private_file(&entry.path())?;
            let quarantine = directory.join("quarantine");
            crate::config::secure_directory(&quarantine)?;
            crate::maintenance::sync_directory(&directory)?;
            dewbow_sdk::private::publish_new(&entry.path(), &quarantine.join(name))?;
        }
        Ok(())
    }
}

pub(crate) fn current_id(db: &Connection) -> anyhow::Result<Option<String>> {
    Ok(db.query_row(
        "SELECT current_selection_id FROM network_settings",
        [],
        |r| r.get(0),
    )?)
}
pub(crate) fn current(db: &Connection, limits: Limits) -> anyhow::Result<Option<LocalSelection>> {
    current_id(db)?
        .map(|id| validation::selection(db, &id, limits))
        .transpose()
}
pub(crate) fn intent_result(db: &Connection, intent: &Intent) -> anyhow::Result<Option<Value>> {
    let row:Option<(String,Vec<u8>,String)>=db.query_row("SELECT operation,fingerprint,result_refs_json FROM network_requests WHERE request_id=?",[&intent.request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(operation, fingerprint, result)| {
        ensure!(
            operation == intent.operation && fingerprint == intent.fingerprint,
            "REQUEST_CONFLICT: changed management intent"
        );
        Ok(serde_json::from_str(&result)?)
    })
    .transpose()
}
pub(crate) fn insert_intent(tx: &Transaction<'_>, intent: &Intent) -> anyhow::Result<()> {
    ensure!(
        !intent.request_id.trim().is_empty(),
        "Empty management request ID"
    );
    tx.execute(
        "INSERT INTO network_requests VALUES(?1,?2,?3,?4,NULL,'pending','{}',?5)",
        params![
            intent.request_id,
            intent.operation,
            intent.fingerprint.as_slice(),
            intent.operation_id.map(|id| id.as_bytes().to_vec()),
            dewbow_protocol::now()
        ],
    )?;
    Ok(())
}
pub(crate) fn finish_intent(
    tx: &Transaction<'_>,
    request: &str,
    status: &str,
    result: &Value,
) -> anyhow::Result<()> {
    ensure!(
        tx.execute(
            "UPDATE network_requests SET status=?,result_refs_json=? WHERE request_id=?",
            params![status, result.to_string(), request]
        )? == 1,
        INVALID_STATE
    );
    Ok(())
}
fn insert_key(tx: &Transaction<'_>, key: &str, public: PublicKey) -> anyhow::Result<()> {
    tx.execute(
        "INSERT INTO network_keys VALUES(?1,?2,1,'present',?3)",
        params![key, public.as_bytes().as_slice(), dewbow_protocol::now()],
    )?;
    Ok(())
}
fn ensure_no_pending_join(db: &Connection) -> anyhow::Result<()> {
    let count:i64=db.query_row("SELECT count(*) FROM network_join_attempts WHERE role='joiner' AND status IN ('prepared','proofReady','uncertain')",[],|r|r.get(0))?;
    ensure!(
        count == 0,
        "Recover the existing join attempt before starting another"
    );
    Ok(())
}

pub(crate) fn save_selection(
    tx: &Transaction<'_>,
    selection: &LocalSelection,
    key: &str,
) -> anyhow::Result<()> {
    for record in selection.history().records() {
        let value: Value = serde_json::from_slice(record.encoded())?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT envelope_json FROM network_records WHERE record_id=?",
                [record.id().as_bytes().as_slice()],
                |r| r.get(0),
            )
            .optional()?;
        let encoded = String::from_utf8(record.encoded().to_vec())?;
        if let Some(old) = existing {
            ensure!(old == encoded, "Immutable record mismatch");
        } else {
            tx.execute(
                "INSERT INTO network_records VALUES(?1,?2,?3,?4)",
                params![
                    record.id().as_bytes().as_slice(),
                    selection.history().network_id().as_bytes().as_slice(),
                    value["body"]["kind"].as_str().unwrap(),
                    encoded
                ],
            )?;
        }
    }
    let status = match selection.status() {
        SelectionStatus::Active => "active",
        SelectionStatus::Left => "left",
        SelectionStatus::Removed => "removed",
    };
    let snapshot = selection.history().snapshot();
    tx.execute("INSERT INTO network_selections VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(selection_id) DO UPDATE SET status=excluded.status,frontier_json=excluded.frontier_json,history_id=excluded.history_id,record_count=excluded.record_count",params![selection.selection_id().to_string(),selection.history().network_id().as_bytes().as_slice(),selection.local_member().as_bytes().as_slice(),key,status,serde_json::to_string(&snapshot.frontier)?,snapshot.history_id.as_bytes().as_slice(),snapshot.record_count as i64,dewbow_protocol::now()])?;
    tx.execute(
        "UPDATE network_settings SET current_selection_id=? WHERE singleton_id=1",
        [selection.selection_id().to_string()],
    )?;
    Ok(())
}

pub(crate) struct JoinRow {
    pub status: String,
    pub key: String,
    pub public: PublicKey,
    pub host: String,
    pub proof: Option<String>,
    pub invitation: PublicInvitation,
    pub request: String,
    pub result: Option<Vec<u8>>,
}
pub(crate) fn join_row(db: &Connection, id: AttemptId) -> anyhow::Result<JoinRow> {
    type StoredJoin = (
        String,
        String,
        Vec<u8>,
        String,
        Option<String>,
        String,
        String,
        Option<Vec<u8>>,
    );
    let row:StoredJoin=db.query_row("SELECT status,key_id,public_key,host_id,join_proof_json,invitation_json,local_request_id,result_record_id FROM network_join_attempts WHERE role='joiner' AND issuer_membership_id=?1 AND join_attempt_id=?2",params![id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)))?;
    Ok(JoinRow {
        status: row.0,
        key: row.1,
        public: PublicKey::from_bytes(
            row.2
                .try_into()
                .map_err(|_| anyhow::anyhow!(INVALID_STATE))?,
        ),
        host: row.3,
        proof: row.4,
        invitation: serde_json::from_str(&row.5)?,
        request: row.6,
        result: row.7,
    })
}
