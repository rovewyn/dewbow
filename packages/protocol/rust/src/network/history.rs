use super::{codec::*, *};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(crate) type Records = BTreeMap<RecordId, Arc<SignedRecord>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Membership {
    pub membership_id: MembershipId,
    pub host_id: HostId,
    pub public_key: PublicKey,
}

/// Immutable, independently verified compatible history. Construction is private.
/// Possession proves history validity, not that any local selection adopted it.
#[derive(Clone, Debug)]
pub struct VerifiedHistory {
    pub(crate) records: Records,
    network_id: NetworkId,
    snapshot: HistorySnapshot,
    members: BTreeMap<MembershipId, Membership>,
    active: BTreeSet<MembershipId>,
}
impl VerifiedHistory {
    pub fn network_id(&self) -> NetworkId {
        self.network_id
    }
    pub fn snapshot(&self) -> &HistorySnapshot {
        &self.snapshot
    }
    pub fn record(&self, id: RecordId) -> Option<&SignedRecord> {
        self.records.get(&id).map(AsRef::as_ref)
    }
    pub fn records(&self) -> impl Iterator<Item = &SignedRecord> {
        self.records.values().map(AsRef::as_ref)
    }
    pub fn member(&self, id: MembershipId) -> Option<&Membership> {
        self.members.get(&id)
    }
    pub fn is_active(&self, id: MembershipId) -> bool {
        self.active.contains(&id)
    }
    pub fn active_members(&self) -> impl Iterator<Item = &Membership> {
        self.active.iter().map(|id| &self.members[id])
    }
    pub(crate) fn from_verified(records: Records, network_id: NetworkId) -> Result<Self> {
        let snapshot = snapshot(&records, network_id)?;
        let (members, active) = state(&records);
        Ok(Self {
            records,
            network_id,
            snapshot,
            members,
            active,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ConflictKind {
    AuthorWithdrawal,
    CompetingAdmission,
    InvitationReuse,
    JoinEquivocation,
    OperationEquivocation,
}

/// Necessary foreign ancestry plus references to records already accepted locally.
#[derive(Clone, Debug)]
pub struct ConflictEvidence {
    pub kind: ConflictKind,
    pub network_id: NetworkId,
    pub local_history_id: HistoryId,
    pub foreign_history_id: HistoryId,
    pub record_ids: [RecordId; 2],
    pub foreign_records: Vec<SignedRecord>,
}

/// A calculation result. Retain added records/frontier and local intent effects
/// atomically before publishing result() or acknowledging durable adoption.
#[derive(Clone, Debug)]
pub struct Proposal {
    base: HistorySnapshot,
    result: VerifiedHistory,
    added: Vec<RecordId>,
}
impl Proposal {
    pub fn base(&self) -> &HistorySnapshot {
        &self.base
    }
    pub fn result(&self) -> &VerifiedHistory {
        &self.result
    }
    pub fn added_records(&self) -> impl Iterator<Item = &SignedRecord> {
        self.added.iter().map(|id| self.result.records[id].as_ref())
    }
    pub fn ensure_base(&self, current: &VerifiedHistory) -> Result<()> {
        if current.network_id != self.result.network_id || current.snapshot != self.base {
            fail(
                ErrorKind::StaleBase,
                "Recalculate against the current committed history",
            )
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug)]
pub enum Decision {
    Duplicate(RecordId),
    Proposed(Proposal),
    HistoryConflict(ConflictEvidence),
}

fn map_bytes(records: &Records) -> usize {
    records.values().fold(0usize, |n, r| {
        n.saturating_add(r.encoded().len()).saturating_add(256)
    })
}
pub(crate) fn closure(
    records: &Records,
    roots: &[RecordId],
    limits: Limits,
) -> Result<BTreeSet<RecordId>> {
    limits.check(roots.len().saturating_mul(32))?;
    let mut seen = BTreeSet::new();
    let mut pending = roots.to_vec();
    while let Some(id) = pending.pop() {
        if seen.contains(&id) {
            continue;
        }
        let record = records.get(&id).ok_or(Error {
            kind: ErrorKind::ProofIncomplete,
            message: "Missing membership ancestor",
        })?;
        limits.check(
            seen.len()
                .saturating_add(pending.len())
                .saturating_add(record.body().parents().len())
                .saturating_add(1)
                .saturating_mul(128),
        )?;
        seen.insert(id);
        pending.extend(record.body().parents());
    }
    Ok(seen)
}
pub(crate) fn subset(records: &Records, ids: &BTreeSet<RecordId>) -> Records {
    ids.iter().map(|id| (*id, records[id].clone())).collect()
}
pub(crate) fn snapshot(records: &Records, network_id: NetworkId) -> Result<HistorySnapshot> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Commitment {
        protocol_version: u64,
        network_id: NetworkId,
        record_ids: Vec<RecordId>,
    }
    let mut frontier: BTreeSet<_> = records.keys().copied().collect();
    for record in records.values() {
        for parent in record.body().parents() {
            frontier.remove(parent);
        }
    }
    let commitment = Commitment {
        protocol_version: 1,
        network_id,
        record_ids: records.keys().copied().collect(),
    };
    Ok(HistorySnapshot {
        history_id: HistoryId::from_bytes(digest("history", &commitment)?),
        frontier: frontier.into_iter().collect(),
        record_count: records.len(),
    })
}
fn state(records: &Records) -> (BTreeMap<MembershipId, Membership>, BTreeSet<MembershipId>) {
    let mut members = BTreeMap::new();
    let mut removed = BTreeSet::new();
    for (id, record) in records {
        let binding = match record.body() {
            RecordBody::CreateNetwork {
                host_id,
                public_key,
                ..
            } => Some((*host_id, *public_key)),
            RecordBody::AdmitMember { payload, .. } => Some((
                payload.join_proof.body.host_id,
                payload.join_proof.body.public_key,
            )),
            _ => None,
        };
        if let Some((host_id, public_key)) = binding {
            let membership_id = (*id).into();
            members.insert(
                membership_id,
                Membership {
                    membership_id,
                    host_id,
                    public_key,
                },
            );
        }
        if let Some(target) = record.body().withdrawal() {
            removed.insert(target);
        }
    }
    let active = members
        .keys()
        .filter(|id| !removed.contains(id))
        .copied()
        .collect();
    (members, active)
}

#[derive(Default)]
struct Index {
    withdrawals: BTreeMap<MembershipId, Vec<RecordId>>,
    ordinary: BTreeMap<MembershipId, Vec<RecordId>>,
    hosts: BTreeMap<HostId, Vec<RecordId>>,
    keys: BTreeMap<PublicKey, Vec<RecordId>>,
    invitations: BTreeMap<(MembershipId, Nonce), Vec<RecordId>>,
    joins: BTreeMap<(MembershipId, Nonce), Vec<RecordId>>,
    operations: BTreeMap<(MembershipId, Nonce), Vec<RecordId>>,
}
impl Index {
    fn new(records: &Records) -> Self {
        let mut index = Self::default();
        for (id, r) in records {
            if let Some(target) = r.body().withdrawal() {
                index.withdrawals.entry(target).or_default().push(*id);
            }
            if let Some(author) = r.body().author() {
                if r.body().is_ordinary() {
                    index.ordinary.entry(author).or_default().push(*id);
                }
                index
                    .operations
                    .entry((author, r.body().operation_id().unwrap()))
                    .or_default()
                    .push(*id);
            }
            if let Some(join) = r.body().join() {
                index.hosts.entry(join.host_id).or_default().push(*id);
                index.keys.entry(join.public_key).or_default().push(*id);
                index
                    .invitations
                    .entry((join.issuer_membership_id, join.invitation_id))
                    .or_default()
                    .push(*id);
                index
                    .joins
                    .entry((join.issuer_membership_id, join.join_attempt_id))
                    .or_default()
                    .push(*id);
            }
        }
        index
    }
    fn related(&self, r: &SignedRecord, kind: ConflictKind) -> BTreeSet<RecordId> {
        let mut result = BTreeSet::new();
        let mut add = |values: Option<&Vec<RecordId>>| {
            if let Some(values) = values {
                result.extend(values);
            }
        };
        match kind {
            ConflictKind::AuthorWithdrawal => {
                if let Some(target) = r.body().withdrawal() {
                    add(self.ordinary.get(&target));
                }
                if r.body().is_ordinary() {
                    add(self.withdrawals.get(&r.body().author().unwrap()));
                }
            }
            ConflictKind::CompetingAdmission => {
                if let Some(j) = r.body().join() {
                    add(self.hosts.get(&j.host_id));
                    add(self.keys.get(&j.public_key));
                }
            }
            ConflictKind::InvitationReuse => {
                if let Some(j) = r.body().join() {
                    add(self
                        .invitations
                        .get(&(j.issuer_membership_id, j.invitation_id)));
                }
            }
            ConflictKind::JoinEquivocation => {
                if let Some(j) = r.body().join() {
                    add(self.joins.get(&(j.issuer_membership_id, j.join_attempt_id)));
                }
            }
            ConflictKind::OperationEquivocation => {
                if let Some(author) = r.body().author() {
                    add(self
                        .operations
                        .get(&(author, r.body().operation_id().unwrap())));
                }
            }
        }
        result
    }
}
fn first_conflict(
    records: &Records,
    limits: Limits,
) -> Result<Option<(ConflictKind, [RecordId; 2])>> {
    limits.check(map_bytes(records).saturating_add(records.len().saturating_mul(1024)))?;
    let index = Index::new(records);
    for kind in [
        ConflictKind::AuthorWithdrawal,
        ConflictKind::CompetingAdmission,
        ConflictKind::InvitationReuse,
        ConflictKind::JoinEquivocation,
        ConflictKind::OperationEquivocation,
    ] {
        for (id, record) in records {
            let related = index.related(record, kind);
            if related
                .range((std::ops::Bound::Excluded(id), std::ops::Bound::Unbounded))
                .next()
                .is_none()
            {
                continue;
            }
            let past = closure(records, record.body().parents(), limits)?;
            for other in related.range((std::ops::Bound::Excluded(id), std::ops::Bound::Unbounded))
            {
                if !past.contains(other)
                    && !closure(records, records[other].body().parents(), limits)?.contains(id)
                {
                    return Ok(Some((kind, [*id, *other])));
                }
            }
        }
    }
    Ok(None)
}

pub(crate) fn validate_change(
    body: &RecordBody,
    context: &VerifiedHistory,
    limits: Limits,
) -> Result<PublicKey> {
    check_body(body)?;
    if body.network() != Some(context.network_id) {
        return invalid("Foreign Network change");
    }
    let author = body.author().ok_or(Error {
        kind: ErrorKind::InvalidInput,
        message: "Expected a membership change",
    })?;
    if !context.is_active(author) {
        return invalid("Author is not active in its causal context");
    }
    if context.records().any(|r| {
        r.body().author() == Some(author) && r.body().operation_id() == body.operation_id()
    }) {
        return invalid("Operation ID reused in causal past");
    }
    match body {
        RecordBody::AdmitMember { payload, .. } => {
            let join = &payload.join_proof.body;
            if join.network_id != context.network_id || join.issuer_membership_id != author {
                return invalid("Join issuer or Network mismatch");
            }
            if context.active_members().any(|m| m.host_id == join.host_id)
                || context
                    .members
                    .values()
                    .any(|m| m.public_key == join.public_key)
            {
                return invalid("Host already active or membership key reused");
            }
            if context.records().filter_map(|r| r.body().join()).any(|j| {
                j.issuer_membership_id == author
                    && (j.invitation_id == join.invitation_id
                        || j.join_attempt_id == join.join_attempt_id)
            }) {
                return invalid("Invitation or join attempt reused in causal past");
            }
            if join
                .invitation_frontier
                .iter()
                .any(|id| !context.records.contains_key(id))
            {
                return invalid("Invitation context is outside admission ancestry");
            }
            let issuance = subset(
                &context.records,
                &closure(&context.records, &join.invitation_frontier, limits)?,
            );
            let snap = snapshot(&issuance, context.network_id)?;
            if snap.history_id != join.invitation_history_id
                || snap.frontier != join.invitation_frontier
            {
                return invalid("Invitation context commitment mismatch");
            }
            let (_, active) = state(&issuance);
            if !active.contains(&author) {
                return invalid("Issuer absent from invitation context");
            }
        }
        RecordBody::RemoveMember { payload, .. } => {
            if payload.membership_id == author || !context.is_active(payload.membership_id) {
                return invalid("Invalid other-member removal target");
            }
        }
        RecordBody::LeaveNetwork { payload, .. } => {
            if payload.membership_id != author {
                return invalid("Self-departure targets another generation");
            }
        }
        RecordBody::CreateNetwork { .. } => return invalid("Unexpected genesis"),
    }
    Ok(context.members[&author].public_key)
}

fn validate(
    records: Records,
    expected: NetworkId,
    known: Option<&VerifiedHistory>,
    limits: Limits,
) -> Result<VerifiedHistory> {
    limits.check(map_bytes(&records).saturating_mul(2))?;
    let genesis = RecordId::from(expected);
    if !records.contains_key(&genesis) {
        return fail(ErrorKind::ProofIncomplete, "Missing expected genesis");
    }
    let mut degree = BTreeMap::new();
    let mut children: BTreeMap<RecordId, Vec<RecordId>> = BTreeMap::new();
    for (id, record) in &records {
        if let RecordBody::CreateNetwork {
            public_key: key, ..
        } = record.body()
        {
            if *id != genesis {
                return invalid("Multiple or foreign genesis");
            }
            verify_signature(
                *key,
                &signing_bytes("genesis", record.body())?,
                record.signature(),
            )?;
        } else if record.body().network() != Some(expected) {
            return invalid("Foreign Network record");
        }
        degree.insert(*id, record.body().parents().len());
        for parent in record.body().parents() {
            if !records.contains_key(parent) {
                return fail(ErrorKind::ProofIncomplete, "Missing membership ancestor");
            }
            children.entry(*parent).or_default().push(*id);
        }
    }
    if !matches!(records[&genesis].body(), RecordBody::CreateNetwork { .. }) {
        return invalid("Expected genesis record");
    }
    let mut ready: BTreeSet<_> = degree
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut processed = 0;
    while let Some(id) = ready.pop_first() {
        let record = &records[&id];
        if known.is_none_or(|k| !k.records.contains_key(&id)) && id != genesis {
            let past = closure(&records, record.body().parents(), limits)?;
            if !past.contains(&genesis) {
                return invalid("Context has no genesis");
            }
            for parent in record.body().parents() {
                let ancestors = closure(&records, records[parent].body().parents(), limits)?;
                if record
                    .body()
                    .parents()
                    .iter()
                    .any(|p| ancestors.contains(p))
                {
                    return invalid("Redundant ancestor parent");
                }
            }
            let context_records = subset(&records, &past);
            if first_conflict(&context_records, limits)?.is_some() {
                return invalid("Record has incompatible causal context");
            }
            let context = VerifiedHistory::from_verified(context_records, expected)?;
            let key = validate_change(record.body(), &context, limits)?;
            verify_signature(
                key,
                &signing_bytes("change", record.body())?,
                record.signature(),
            )?;
        }
        processed += 1;
        if let Some(next) = children.get(&id) {
            for child in next {
                let n = degree.get_mut(child).unwrap();
                *n -= 1;
                if *n == 0 {
                    ready.insert(*child);
                }
            }
        }
    }
    if processed != records.len() {
        return invalid("Cyclic membership graph");
    }
    if first_conflict(&records, limits)?.is_some() {
        return invalid("Supplied history is not compatible");
    }
    VerifiedHistory::from_verified(records, expected)
}

pub fn verify_history(
    expected: NetworkId,
    records: &[SignedRecord],
    limits: Limits,
) -> Result<VerifiedHistory> {
    let bytes = records.iter().fold(0usize, |n, r| {
        n.saturating_add(r.encoded().len()).saturating_add(512)
    });
    limits.check(bytes.saturating_mul(2))?;
    let records = records
        .iter()
        .map(|r| (r.id(), Arc::new(r.clone())))
        .collect();
    validate(records, expected, None, limits)
}

/// Candidate proof is transient. Unrelated proof records are never adopted.
pub fn consider(
    current: &VerifiedHistory,
    candidate: &SignedRecord,
    proof: &[SignedRecord],
    limits: Limits,
) -> Result<Decision> {
    if current.records.contains_key(&candidate.id()) {
        return Ok(Decision::Duplicate(candidate.id()));
    }
    if candidate
        .body()
        .network()
        .is_some_and(|id| id != current.network_id)
        || matches!(candidate.body(), RecordBody::CreateNetwork { .. })
    {
        return invalid("Candidate belongs to another Network");
    }
    let incoming = proof.iter().chain(std::iter::once(candidate));
    let bytes = incoming.clone().fold(map_bytes(&current.records), |n, r| {
        n.saturating_add(r.encoded().len()).saturating_add(512)
    });
    limits.check(bytes.saturating_mul(2))?;
    let mut available = current.records.clone();
    for record in incoming {
        available
            .entry(record.id())
            .or_insert_with(|| Arc::new(record.clone()));
    }
    let ids = closure(&available, &[candidate.id()], limits)?;
    let foreign = validate(
        subset(&available, &ids),
        current.network_id,
        Some(current),
        limits,
    )?;
    let mut union = current.records.clone();
    for (id, record) in &foreign.records {
        union.entry(*id).or_insert_with(|| record.clone());
    }
    if let Some((kind, record_ids)) = first_conflict(&union, limits)? {
        let needed = closure(&union, &record_ids, limits)?;
        let foreign_ids: Vec<_> = needed
            .iter()
            .filter(|id| !current.records.contains_key(id))
            .copied()
            .collect();
        let bytes = foreign_ids.iter().fold(0usize, |n, id| {
            n.saturating_add(union[id].encoded().len())
                .saturating_add(256)
        });
        if bytes > limits.conflict_bytes {
            return fail(
                ErrorKind::ResourceLimit,
                "Conflict witness exceeds local evidence budget",
            );
        }
        return Ok(Decision::HistoryConflict(ConflictEvidence {
            kind,
            network_id: current.network_id,
            local_history_id: current.snapshot.history_id,
            foreign_history_id: foreign.snapshot.history_id,
            record_ids,
            foreign_records: foreign_ids
                .iter()
                .map(|id| union[id].as_ref().clone())
                .collect(),
        }));
    }
    let added = union
        .keys()
        .filter(|id| !current.records.contains_key(id))
        .copied()
        .collect();
    Ok(Decision::Proposed(Proposal {
        base: current.snapshot.clone(),
        result: VerifiedHistory::from_verified(union, current.network_id)?,
        added,
    }))
}

/// One ephemeral batch only. Missing-proof candidates are not remembered; the
/// caller submits complete candidates serially and commits between decisions.
pub fn ready_candidates(
    current: &VerifiedHistory,
    batch: &[SignedRecord],
    limits: Limits,
) -> Result<Vec<RecordId>> {
    let bytes = batch.iter().fold(map_bytes(&current.records), |n, r| {
        n.saturating_add(r.encoded().len()).saturating_add(512)
    });
    limits.check(bytes.saturating_mul(2))?;
    let mut available = current.records.clone();
    for r in batch {
        available
            .entry(r.id())
            .or_insert_with(|| Arc::new(r.clone()));
    }
    let mut ready = BTreeSet::new();
    for r in batch {
        match closure(&available, &[r.id()], limits) {
            Ok(_) => {
                ready.insert(r.id());
            }
            Err(e) if e.kind == ErrorKind::ProofIncomplete => {}
            Err(e) => return Err(e),
        }
    }
    Ok(ready.into_iter().collect())
}
