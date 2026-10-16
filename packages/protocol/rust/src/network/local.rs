use super::{codec::*, *};
use serde::Serialize;

/// Signing is performed by the protected key owner, outside this engine.
#[derive(Clone, Debug)]
pub struct PreparedRecord {
    body: RecordBody,
    key: PublicKey,
    bytes: Vec<u8>,
}
impl PreparedRecord {
    fn new(body: RecordBody, key: PublicKey) -> Result<Self> {
        // Account for the final envelope before asking the key owner to sign.
        assemble(body.clone(), Signature::from_bytes([0; 64]))?;
        let bytes = signing_bytes(body.label(), &body)?;
        Ok(Self { body, key, bytes })
    }
    pub fn body(&self) -> &RecordBody {
        &self.body
    }
    pub fn public_key(&self) -> PublicKey {
        self.key
    }
    pub fn signing_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn finish(self, signature: Signature) -> Result<SignedRecord> {
        verify_signature(self.key, &self.bytes, signature)?;
        assemble(self.body, signature)
    }
}

#[derive(Clone, Debug)]
pub struct PreparedJoin {
    body: JoinBody,
    bytes: Vec<u8>,
}
impl PreparedJoin {
    pub fn body(&self) -> &JoinBody {
        &self.body
    }
    pub fn signing_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn finish(self, signature: Signature) -> Result<JoinProof> {
        let proof = JoinProof {
            body: self.body,
            signature,
        };
        check_join(&proof)?;
        Ok(proof)
    }
}

pub fn prepare_genesis(
    nonce: Nonce,
    name: String,
    host_id: HostId,
    key: PublicKey,
) -> Result<PreparedRecord> {
    let body = RecordBody::CreateNetwork {
        protocol_version: 1,
        nonce,
        network_name: name,
        host_id,
        public_key: key,
    };
    PreparedRecord::new(body, key)
}

pub fn prepare_join(
    issuance: &VerifiedHistory,
    issuer: MembershipId,
    invitation_id: Nonce,
    join_attempt_id: Nonce,
    host_id: HostId,
    key: PublicKey,
) -> Result<PreparedJoin> {
    public_key(key)?;
    if !issuance.is_active(issuer) {
        return invalid("Invitation issuer is not active");
    }
    if issuance.active_members().any(|m| m.host_id == host_id)
        || issuance.records().any(|r| match r.body() {
            RecordBody::CreateNetwork { public_key, .. } => *public_key == key,
            _ => r.body().join().is_some_and(|j| j.public_key == key),
        })
    {
        return invalid("Join requires a fresh host generation and key");
    }
    let body = JoinBody {
        protocol_version: 1,
        network_id: issuance.network_id(),
        issuer_membership_id: issuer,
        invitation_id,
        invitation_history_id: issuance.snapshot().history_id,
        invitation_frontier: issuance.snapshot().frontier.clone(),
        join_attempt_id,
        host_id,
        public_key: key,
    };
    let bytes = signing_bytes("join", &body)?;
    Ok(PreparedJoin { body, bytes })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Admit(Box<JoinProof>),
    Remove(MembershipId),
    Leave,
}

#[derive(Clone, Debug)]
pub enum PreparedChange {
    /// Exact retained result; do not sign again or create new departure tasks.
    Existing(SignedRecord),
    Sign(PreparedRecord),
}

fn same_change(body: &RecordBody, author: MembershipId, change: &Change) -> bool {
    match (body, change) {
        (RecordBody::AdmitMember { payload, .. }, Change::Admit(proof)) => {
            payload.join_proof == *proof
        }
        (RecordBody::RemoveMember { payload, .. }, Change::Remove(target)) => {
            payload.membership_id == *target
        }
        (RecordBody::LeaveNetwork { payload, .. }, Change::Leave) => {
            payload.membership_id == author
        }
        _ => false,
    }
}
pub fn prepare_change(
    history: &VerifiedHistory,
    author: MembershipId,
    operation_id: Nonce,
    change: Change,
    limits: Limits,
) -> Result<PreparedChange> {
    if let Some(old) = history.records().find(|r| {
        r.body().author() == Some(author) && r.body().operation_id() == Some(operation_id)
    }) {
        if !same_change(old.body(), author, &change) {
            return invalid("Retried intent has changed input");
        }
        return Ok(PreparedChange::Existing(old.clone()));
    }
    let target = match &change {
        Change::Leave => Some(author),
        Change::Remove(id) => Some(*id),
        _ => None,
    };
    if !matches!(change, Change::Leave) && !history.is_active(author) {
        return invalid("Local author is inactive");
    }
    if let Some(target) = target {
        if matches!(change, Change::Remove(_)) && target == author {
            return invalid("Use self-departure for local removal");
        }
        if !history.is_active(target) {
            if let Some(old) = history
                .records()
                .find(|r| r.body().withdrawal() == Some(target))
            {
                return Ok(PreparedChange::Existing(old.clone()));
            }
            return invalid("Unknown withdrawal target");
        }
    }
    let network_id = history.network_id();
    let parents = history.snapshot().frontier.clone();
    let body = match change {
        Change::Admit(join_proof) => RecordBody::AdmitMember {
            protocol_version: 1,
            network_id,
            operation_id,
            author_membership_id: author,
            parents,
            payload: AdmissionPayload { join_proof },
        },
        Change::Remove(membership_id) => RecordBody::RemoveMember {
            protocol_version: 1,
            network_id,
            operation_id,
            author_membership_id: author,
            parents,
            payload: WithdrawalPayload { membership_id },
        },
        Change::Leave => RecordBody::LeaveNetwork {
            protocol_version: 1,
            network_id,
            operation_id,
            author_membership_id: author,
            parents,
            payload: WithdrawalPayload {
                membership_id: author,
            },
        },
    };
    let key = super::history::validate_change(&body, history, limits)?;
    Ok(PreparedChange::Sign(PreparedRecord::new(body, key)?))
}

#[derive(Clone, Debug)]
pub enum PreparedDeparture {
    /// This verified observation is not a signed destination acknowledgement.
    /// It cannot itself complete a retained departure task.
    Absent {
        membership_id: MembershipId,
        history_id: HistoryId,
    },
    Sign(PreparedRecord),
}

/// The only old-key management signing path. The caller must obtain this intent
/// from retained departure state and check key-store capability before signing.
/// A remote peer supplies a verified context, never a body or hash to sign.
pub fn prepare_departure_rebase(
    original_history: &VerifiedHistory,
    original_departure: RecordId,
    recipient_history: &VerifiedHistory,
    limits: Limits,
) -> Result<PreparedDeparture> {
    let original = original_history.record(original_departure).ok_or(Error {
        kind: ErrorKind::InvalidInput,
        message: "Missing retained original departure",
    })?;
    let RecordBody::LeaveNetwork {
        author_membership_id,
        operation_id,
        ..
    } = original.body()
    else {
        return invalid("Rebase requires an original self-departure");
    };
    if original_history.network_id() != recipient_history.network_id() {
        return invalid("Foreign departure context");
    }
    let member = original_history.member(*author_membership_id).unwrap();
    if recipient_history
        .member(*author_membership_id)
        .is_some_and(|m| m != member)
    {
        return invalid("Recipient does not bind the exact departing generation");
    }
    if !recipient_history.is_active(*author_membership_id) {
        return Ok(PreparedDeparture::Absent {
            membership_id: *author_membership_id,
            history_id: recipient_history.snapshot().history_id,
        });
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Rebase {
        network_id: NetworkId,
        membership_id: MembershipId,
        operation_id: Nonce,
        history_id: HistoryId,
    }
    let intent = Rebase {
        network_id: original_history.network_id(),
        membership_id: *author_membership_id,
        operation_id: *operation_id,
        history_id: recipient_history.snapshot().history_id,
    };
    let operation_id = Nonce::from_bytes(digest("departureRebase", &intent)?);
    match prepare_change(
        recipient_history,
        *author_membership_id,
        operation_id,
        Change::Leave,
        limits,
    )? {
        PreparedChange::Sign(record) => Ok(PreparedDeparture::Sign(record)),
        PreparedChange::Existing(_) => invalid("Unexpected rebased departure result"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionStatus {
    Active,
    Left,
    Removed,
}

/// Caller-owned committed association. Contains no process, key or DB handle.
#[derive(Clone, Debug)]
pub struct LocalSelection {
    selection_id: uuid::Uuid,
    local_member: MembershipId,
    status: SelectionStatus,
    history: VerifiedHistory,
}
impl LocalSelection {
    /// Rebuild a retained association; the storage adapter also verifies its key
    /// binding, current pointer, and the one-active-selection invariant.
    pub fn restore(
        selection_id: uuid::Uuid,
        local_member: MembershipId,
        status: SelectionStatus,
        history: VerifiedHistory,
    ) -> Result<Self> {
        if history.member(local_member).is_none()
            || (status == SelectionStatus::Active) != history.is_active(local_member)
        {
            return invalid("Selection status does not match its verified history");
        }
        Ok(Self {
            selection_id,
            local_member,
            status,
            history,
        })
    }
    pub fn selection_id(&self) -> uuid::Uuid {
        self.selection_id
    }
    pub fn local_member(&self) -> MembershipId {
        self.local_member
    }
    pub fn status(&self) -> SelectionStatus {
        self.status
    }
    pub fn history(&self) -> &VerifiedHistory {
        &self.history
    }
    /// Calculate, do not publish. The adapter commits this association with the
    /// proposal and any existing intent/outbox effects in one transaction.
    pub fn after_adoption(&self, proposal: &Proposal) -> Result<Self> {
        if self.status != SelectionStatus::Active {
            return invalid("Inactive selections cannot ordinarily adopt");
        }
        proposal.ensure_base(&self.history)?;
        let history = proposal.result().clone();
        let status = if history.is_active(self.local_member) { SelectionStatus::Active }
            else if history.records().any(|r| matches!(r.body(), RecordBody::LeaveNetwork { author_membership_id, .. } if *author_membership_id == self.local_member)) { SelectionStatus::Left }
            else { SelectionStatus::Removed };
        Ok(Self {
            history,
            status,
            ..self.clone()
        })
    }
    /// Already excluded/left: no record, signature, or new outbox is produced.
    pub fn detach_inactive(&self) -> Result<Self> {
        if self.status == SelectionStatus::Active {
            return invalid("Active exit requires a signed departure");
        }
        Ok(Self {
            status: SelectionStatus::Left,
            ..self.clone()
        })
    }
}

/// Trusted local orchestration assertion, never deserializable from peer data.
/// Construct only after local authorization and issuer confirmation (or local
/// genesis authorization). This type cannot authenticate the human operator.
#[derive(Clone, Debug)]
pub struct ConfirmedLocalAdmission {
    host: HostId,
    membership: MembershipId,
}
impl ConfirmedLocalAdmission {
    pub fn from_local_confirmation(host: HostId, membership: MembershipId) -> Self {
        Self { host, membership }
    }
}

#[derive(Clone, Debug)]
pub struct FreshSelectionPlan {
    /// Keep inactive records, receipt bindings and departure tasks associated
    /// with this selection. Selecting current never deletes or unions them.
    pub previous: Option<LocalSelection>,
    pub current: LocalSelection,
}
pub fn plan_fresh_selection(
    previous: Option<&LocalSelection>,
    selection_id: uuid::Uuid,
    history: VerifiedHistory,
    confirmed: ConfirmedLocalAdmission,
) -> Result<FreshSelectionPlan> {
    let member = history.member(confirmed.membership).ok_or(Error {
        kind: ErrorKind::InvalidInput,
        message: "Confirmed membership absent from admission history",
    })?;
    if !history.is_active(confirmed.membership) || member.host_id != confirmed.host {
        return invalid("Confirmed host is not an active admitted member");
    }
    if let Some(old) = previous {
        if old.status == SelectionStatus::Active {
            return invalid("Exit or adopt exclusion before fresh selection");
        }
        let old_member = old.history.member(old.local_member).unwrap();
        if old.selection_id == selection_id
            || old_member.host_id != confirmed.host
            || old_member.public_key == member.public_key
            || (old.history.network_id() == history.network_id()
                && old.local_member == confirmed.membership)
        {
            return invalid("Fresh selection requires a new local generation and key");
        }
    }
    let current = LocalSelection::restore(
        selection_id,
        confirmed.membership,
        SelectionStatus::Active,
        history,
    )?;
    Ok(FreshSelectionPlan {
        previous: previous.cloned(),
        current,
    })
}
