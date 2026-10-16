//! Transactional business admission; no native calls or content are retained here.
use super::{ReceiptScope, RecoveryRefs, Repository, repository::current};
use anyhow::ensure;
use dewbow_protocol::{
    error,
    network::{peer::BusinessContext, *},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub(crate) struct BusinessIdentity {
    pub caller: MembershipId,
    pub target: MembershipId,
    pub caller_key: PublicKey,
    pub target_key: PublicKey,
}

impl Repository {
    pub(crate) fn reject_local_redirect(&self, request: &str) -> anyhow::Result<()> {
        let bound:bool=self.db.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM network_outbound_requests WHERE request_id=?1 AND target_host_id<>source_host_id)",[request],|r|r.get(0))?;
        ensure!(
            !bound,
            error(
                "REQUEST_CONFLICT",
                "Request is bound to its original remote target."
            )
        );
        Ok(())
    }
    fn check_business(
        &self,
        db: &Connection,
        context: &BusinessContext,
        identity: BusinessIdentity,
    ) -> anyhow::Result<()> {
        ensure!(
            context.protocol_version == 1,
            error("PROTOCOL_UNSUPPORTED", "Unsupported peer version.")
        );
        let selected =
            current(db, self.limits)?.ok_or_else(|| error("FORBIDDEN", "No active Network."))?;
        let history = selected.history();
        ensure!(
            selected.status() == SelectionStatus::Active
                && context.network_id == history.network_id()
                && context.caller_membership_id == identity.caller
                && context.target_membership_id == identity.target
                && selected.local_member() == identity.target
                && Some(context.target_host_id) == self.host
                && history.is_active(identity.caller)
                && history.is_active(identity.target)
                && history
                    .member(identity.caller)
                    .is_some_and(|m| m.public_key == identity.caller_key
                        && m.host_id == context.source_host_id)
                && history
                    .member(identity.target)
                    .is_some_and(|m| m.public_key == identity.target_key
                        && m.host_id == context.target_host_id),
            error("FORBIDDEN", "Current member and TLS identities must match.")
        );
        let conflict: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM network_conflicts WHERE network_id=?1 AND substr(reason,-length(?2))=?2)",
            params![
                context.network_id.as_bytes().as_slice(),
                format!(":peer:{}", identity.caller)
            ],
            |r| r.get(0),
        )?;
        ensure!(
            !conflict,
            error("HISTORY_CONFLICT", "Peer history is incompatible.")
        );
        ensure!(
            context.history_id == history.snapshot().history_id,
            error("SYNC_REQUIRED", "Reconcile membership before admission.")
        );
        Ok(())
    }

    /// Membership writes and first receipt insertion share this database transaction.
    pub(crate) fn admit_business(
        &self,
        context: &BusinessContext,
        identity: BusinessIdentity,
        scope: &ReceiptScope,
        fingerprint: [u8; 32],
        receipt: &Value,
    ) -> anyhow::Result<Value> {
        let mut durable = receipt.clone();
        durable.as_object_mut().unwrap().remove("authority");
        self.transaction(|tx| {
            self.check_business(tx, context, identity)?;
            if let Some((saved, encoded)) = tx.query_row("SELECT fingerprint,receipt_json FROM network_request_receipts WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3", params![scope.network_id.as_bytes().as_slice(), scope.source_host_id.to_string(), scope.request_id], |r| Ok((r.get::<_,Vec<u8>>(0)?, r.get::<_,String>(1)?))).optional()? {
                ensure!(saved == fingerprint, error("REQUEST_CONFLICT", "Original operation or input changed."));
                return Ok(serde_json::from_str(&encoded)?);
            }
            crate::store::validate_record("operation", &scope.request_id, &durable)?;
            let refs = RecoveryRefs { session_id: receipt["sessionId"].as_str().unwrap().into(), turn_id: receipt["turnId"].as_str().map(str::to_owned), codex_turn_id: None };
            tx.execute("INSERT INTO network_request_receipts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![scope.network_id.as_bytes().as_slice(), scope.source_host_id.to_string(), scope.request_id, context.target_host_id.to_string(), receipt["operation"].as_str(), fingerprint.as_slice(), receipt["commandId"].as_str(), durable.to_string(), serde_json::to_string(&refs)?, receipt["createdAt"].as_str()])?;
            Ok(receipt.clone())
        })
    }

    pub(crate) fn read_business_receipt(
        &self,
        context: &BusinessContext,
        identity: BusinessIdentity,
        scope: &ReceiptScope,
    ) -> anyhow::Result<Option<Value>> {
        let db = self.db.lock().unwrap();
        self.check_business(&db, context, identity)?;
        let encoded: Option<String> = db.query_row("SELECT receipt_json FROM network_request_receipts WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3", params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id], |r|r.get(0)).optional()?;
        encoded
            .map(|v| serde_json::from_str(&v).map_err(Into::into))
            .transpose()
    }

    pub(crate) fn business_receipts(&self) -> anyhow::Result<Vec<(ReceiptScope, Value)>> {
        let db = self.db.lock().unwrap();
        let mut q = db.prepare("SELECT network_id,source_host_id,request_id,receipt_json FROM network_request_receipts")?;
        q.query_map([], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .map(|row| {
            let (network, source, request, encoded) = row?;
            Ok((
                ReceiptScope {
                    network_id: NetworkId::from_bytes(
                        network
                            .try_into()
                            .map_err(|_| anyhow::anyhow!("Invalid Network ID"))?,
                    ),
                    source_host_id: HostId::parse(&source)?,
                    request_id: request,
                },
                serde_json::from_str(&encoded)?,
            ))
        })
        .collect()
    }

    pub(crate) fn receipt_scope_for_command(
        &self,
        command: &str,
    ) -> anyhow::Result<Option<ReceiptScope>> {
        let db = self.db.lock().unwrap();
        let row:Option<(Vec<u8>,String,String)>=db.query_row("SELECT network_id,source_host_id,request_id FROM network_request_receipts WHERE command_id=?1",[command],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        row.map(|(network, source, request)| {
            Ok(ReceiptScope {
                network_id: NetworkId::from_bytes(
                    network
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("Invalid Network ID"))?,
                ),
                source_host_id: HostId::parse(&source)?,
                request_id: request,
            })
        })
        .transpose()
    }

    pub(crate) fn outbound_network_for_command(
        &self,
        command: &str,
    ) -> anyhow::Result<Option<NetworkId>> {
        let row:Option<Vec<u8>>=self.db.lock().unwrap().query_row("SELECT network_id FROM network_outbound_requests WHERE json_extract(result_ref_json,'$.commandId')=?1",[command],|r|r.get(0)).optional()?;
        row.map(|bytes| {
            Ok(NetworkId::from_bytes(
                bytes
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("Invalid Network ID"))?,
            ))
        })
        .transpose()
    }

    pub(crate) fn outbound_uncertain(&self, scope: &ReceiptScope) -> anyhow::Result<bool> {
        Ok(self.db.lock().unwrap().query_row("SELECT dispatch_state<>'prepared' FROM network_outbound_requests WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id],|r|r.get(0)).optional()?.unwrap_or(false))
    }

    pub(crate) fn reset_unadmitted(&self, scope: &ReceiptScope) -> anyhow::Result<()> {
        self.transaction(|tx| {tx.execute("UPDATE network_outbound_requests SET dispatch_state='prepared' WHERE network_id=?1 AND source_host_id=?2 AND request_id=?3",params![scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id])?;Ok(())})
    }

    pub(crate) fn settle_outbound(
        &self,
        scope: &ReceiptScope,
        receipt: &Value,
    ) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let settled = matches!(receipt["status"].as_str(),Some("delivered"|"error"));
            tx.execute("UPDATE network_outbound_requests SET dispatch_state=?1,result_ref_json=?2 WHERE network_id=?3 AND source_host_id=?4 AND request_id=?5",params![if settled {"settled"} else {"uncertain"},json!({"commandId":receipt["commandId"],"sessionId":receipt["sessionId"],"turnId":receipt["turnId"]}).to_string(),scope.network_id.as_bytes().as_slice(),scope.source_host_id.to_string(),scope.request_id])?;
            Ok(())
        })
    }
}
