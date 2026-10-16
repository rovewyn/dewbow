use super::super::{Repository, peer_store::history_subset};
use super::{Result, unavailable};
use dewbow_protocol::network::{peer::*, *};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

pub(super) struct Shared {
    pub stopped: AtomicBool,
    pub stopping: tokio::sync::watch::Sender<bool>,
    work: AtomicUsize,
    idle: Notify,
    pub changed: Notify,
    pub conflicts: Mutex<BTreeSet<(NetworkId, MembershipId)>>,
    pub connections: Arc<Semaphore>,
    pub workers: Arc<Semaphore>,
    pub memory: Arc<Semaphore>,
    pub proof_budget: Duration,
    pub maintenance: Option<Arc<crate::maintenance::Maintenance>>,
    rates: Mutex<BTreeMap<PublicKey, (Instant, usize)>>,
    leases: Mutex<BTreeMap<(NetworkId, MembershipId, Nonce), Instant>>,
}
impl Default for Shared {
    fn default() -> Self {
        Self {
            stopping: tokio::sync::watch::channel(false).0,
            stopped: AtomicBool::new(false),
            work: AtomicUsize::new(0),
            idle: Notify::new(),
            changed: Notify::new(),
            conflicts: Mutex::new(BTreeSet::new()),
            connections: Arc::new(Semaphore::new(32)),
            workers: Arc::new(Semaphore::new(4)),
            memory: Arc::new(Semaphore::new(64 * 1024 * 1024)),
            proof_budget: Duration::from_secs(300),
            maintenance: None,
            rates: Mutex::new(BTreeMap::new()),
            leases: Mutex::new(BTreeMap::new()),
        }
    }
}
impl Shared {
    pub fn note_hint(&self, hint: &AddressHint) {
        let now = Instant::now();
        let mut leases = self.leases.lock().unwrap();
        leases.retain(|_, until| *until > now);
        let key = (
            hint.body.network_id,
            hint.body.membership_id,
            hint.body.nonce,
        );
        // Full bookkeeping capacity makes new hints stale, never a refreshed grant.
        if leases.len() < 4096 || leases.contains_key(&key) {
            leases
                .entry(key)
                .or_insert(now + Duration::from_secs(hint.body.lease_seconds));
        }
    }
    pub fn hint_is_fresh(&self, network: NetworkId, member: MembershipId, nonce: Nonce) -> bool {
        self.leases
            .lock()
            .unwrap()
            .get(&(network, member, nonce))
            .is_some_and(|until| *until > Instant::now())
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.stopping.send_replace(true);
    }
    pub fn begin_work(self: &Arc<Self>) -> Result<Work> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(PeerError::new("UNAVAILABLE"));
        }
        self.work.fetch_add(1, Ordering::AcqRel);
        let guard = Work(self.clone());
        if self.stopped.load(Ordering::Acquire) {
            drop(guard);
            return Err(PeerError::new("UNAVAILABLE"));
        }
        Ok(guard)
    }
    pub async fn drain(&self) {
        while self.work.load(Ordering::Acquire) > 0 {
            self.idle.notified().await;
        }
    }
    pub fn admission(&self) -> Result<Option<crate::maintenance::Operation<'_>>> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(PeerError::new("UNAVAILABLE"));
        }
        self.maintenance
            .as_ref()
            .map(|gate| {
                gate.admit_cleanup()
                    .ok_or_else(|| PeerError::new("UNAVAILABLE"))
            })
            .transpose()
    }
    pub fn quarantine(
        &self,
        repo: &Repository,
        evidence: &ConflictEvidence,
        peer: MembershipId,
    ) -> Result<()> {
        let _admission = self.admission()?;
        repo.retain_peer_conflict(evidence, peer)
            .map_err(unavailable)?;
        *self.conflicts.lock().unwrap() = repo.peer_conflicts().map_err(unavailable)?;
        Ok(())
    }
    pub fn with_capacity(capacity: PeerCapacity) -> anyhow::Result<Self> {
        anyhow::ensure!(
            capacity.max_connections > 0
                && capacity.max_connections <= Semaphore::MAX_PERMITS
                && capacity.max_proof_workers > 0
                && capacity.max_proof_workers <= Semaphore::MAX_PERMITS
                && capacity.total_working_bytes > 0
                && capacity.total_working_bytes <= Semaphore::MAX_PERMITS
                && !capacity.proof_verification_budget.is_zero(),
            "Invalid Peer capacity"
        );
        Ok(Self {
            connections: Arc::new(Semaphore::new(capacity.max_connections)),
            workers: Arc::new(Semaphore::new(capacity.max_proof_workers)),
            memory: Arc::new(Semaphore::new(capacity.total_working_bytes)),
            proof_budget: capacity.proof_verification_budget,
            ..Self::default()
        })
    }
    fn proof_permit(&self, key: PublicKey) -> Result<OwnedSemaphorePermit> {
        let mut rates = self.rates.lock().unwrap();
        rates.retain(|_, (when, _)| when.elapsed() < Duration::from_secs(60));
        if rates.len() >= 1024 && !rates.contains_key(&key) {
            return Err(PeerError::new("RESOURCE_LIMIT"));
        }
        let (when, count) = rates.entry(key).or_insert((Instant::now(), 0));
        // Burst two; replenish one permit each ten seconds, at most six per minute.
        let allowed = (2 + when.elapsed().as_secs() / 10).min(6) as usize;
        if *count >= allowed {
            return Err(PeerError::new("RESOURCE_LIMIT"));
        }
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?;
        *count += 1;
        Ok(permit)
    }
}
pub(super) struct Work(Arc<Shared>);
impl Drop for Work {
    fn drop(&mut self) {
        if self.0.work.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.idle.notify_one();
        }
    }
}
fn parse<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| PeerError::new("INVALID_INPUT"))
}
#[derive(Clone, Debug)]
pub struct PeerCapacity {
    pub max_connections: usize,
    pub max_proof_workers: usize,
    pub total_working_bytes: usize,
    pub proof_verification_budget: Duration,
}
impl Default for PeerCapacity {
    fn default() -> Self {
        Self {
            max_connections: 32,
            max_proof_workers: 4,
            total_working_bytes: 64 * 1024 * 1024,
            proof_verification_budget: Duration::from_secs(300),
        }
    }
}
fn value(value: impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(unavailable)
}
fn token() -> String {
    uuid::Uuid::new_v4().to_string()
}
const IDLE: Duration = Duration::from_secs(60);
struct Snapshot {
    token: String,
    history: VerifiedHistory,
    touched: Instant,
    last_page: Option<RecordId>,
    complete: bool,
    transfer: Option<Transfer>,
}
struct Transfer {
    request: Vec<RecordId>,
    peer: HistoryId,
    remaining: Vec<RecordId>,
    cursor: Option<String>,
}
struct Upload {
    token: String,
    history: HistorySnapshot,
    ids: Vec<RecordId>,
    complete: bool,
    touched: Instant,
    last: Option<(Option<RecordId>, Vec<RecordId>, bool)>,
}
struct Proof {
    token: String,
    purpose: ProofPurpose,
    member: Option<MembershipId>,
    target: Option<RecordId>,
    records: BTreeMap<RecordId, SignedRecord>,
    readable: Option<VerifiedHistory>,
    verified: bool,
    started: Instant,
    touched: Instant,
    _worker: OwnedSemaphorePermit,
}

pub(super) struct Session {
    pub repo: Repository,
    pub shared: Arc<Shared>,
    pub peer_key: PublicKey,
    pub local_key: PublicKey,
    hello: Option<Hello>,
    provisional: bool,
    snapshot: Option<Snapshot>,
    upload: Option<Upload>,
    proof: Option<Proof>,
    memory: Vec<OwnedSemaphorePermit>,
    charged: usize,
    parts: [usize; 3],
}
impl Session {
    pub fn new(
        repo: Repository,
        shared: Arc<Shared>,
        peer_key: PublicKey,
        local_key: PublicKey,
    ) -> Self {
        Self {
            repo,
            shared,
            peer_key,
            local_key,
            hello: None,
            provisional: false,
            snapshot: None,
            upload: None,
            proof: None,
            memory: Vec::new(),
            charged: 0,
            parts: [0; 3],
        }
    }
    fn charge(&mut self, slot: usize, bytes: usize) -> Result<()> {
        if bytes > self.repo.limits.working_bytes {
            return Err(PeerError::new("RESOURCE_LIMIT"));
        }
        let mut parts = self.parts;
        parts[slot] = bytes;
        let total = parts
            .iter()
            .try_fold(0usize, |sum, value| sum.checked_add(*value))
            .ok_or_else(|| PeerError::new("RESOURCE_LIMIT"))?;
        if total > self.charged {
            self.memory.push(
                self.shared
                    .memory
                    .clone()
                    .try_acquire_many_owned(
                        (total - self.charged)
                            .try_into()
                            .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?,
                    )
                    .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?,
            );
            self.charged = total;
        }
        while self.charged > total {
            let mut permit = self.memory.pop().expect("reserved memory permit");
            let release = (self.charged - total).min(permit.num_permits());
            drop(permit.split(release).expect("bounded memory permit split"));
            self.charged -= release;
            if permit.num_permits() > 0 {
                self.memory.push(permit);
            }
        }
        self.parts = parts;
        Ok(())
    }
    fn selection(&self) -> Result<LocalSelection> {
        if let Some(Hello::Proof { network_id, .. }) = &self.hello {
            return self
                .repo
                .proof_selection(*network_id, self.local_key)
                .map_err(unavailable)?
                .ok_or_else(|| PeerError::new("FORBIDDEN"));
        }
        let selected = self
            .repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
        if self
            .hello
            .as_ref()
            .is_some_and(|h| h.binding().1 != selected.history().network_id())
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        Ok(selected)
    }
    fn authorize(&self) -> Result<LocalSelection> {
        if self.provisional {
            return Err(PeerError::new("FORBIDDEN"));
        }
        let selected = self.selection()?;
        let Some(Hello::Member { membership_id, .. }) = &self.hello else {
            return Err(PeerError::new("FORBIDDEN"));
        };
        if self
            .shared
            .conflicts
            .lock()
            .unwrap()
            .contains(&(selected.history().network_id(), *membership_id))
        {
            return Err(PeerError::new("HISTORY_CONFLICT"));
        }
        let history = selected.history();
        if selected.status() != SelectionStatus::Active
            || !history.is_active(*membership_id)
            || history
                .member(*membership_id)
                .is_none_or(|m| m.public_key != self.peer_key)
            || history
                .member(selected.local_member())
                .is_none_or(|m| m.public_key != self.local_key)
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        Ok(selected)
    }
    fn access(&self) -> Access {
        match (&self.hello, self.authorize()) {
            (Some(Hello::Member { history, .. }), Ok(selected))
                if history == selected.history().snapshot() =>
            {
                Access::Business
            }
            (_, Ok(_)) => Access::Synchronize,
            _ => Access::ProofOnly,
        }
    }
    pub fn revoked(&mut self) -> bool {
        self.expire();
        !self.provisional
            && matches!(&self.hello,Some(Hello::Member { .. }) if self.authorize().is_err())
    }
    fn expire(&mut self) {
        if self
            .snapshot
            .as_ref()
            .is_some_and(|s| s.touched.elapsed() >= IDLE)
        {
            self.snapshot = None;
        }
        if self
            .upload
            .as_ref()
            .is_some_and(|s| s.touched.elapsed() >= IDLE)
        {
            self.upload = None;
        }
        if self.proof.as_ref().is_some_and(|s| {
            s.touched.elapsed() >= IDLE || s.started.elapsed() >= self.shared.proof_budget
        }) {
            self.proof = None;
        }
        if self.snapshot.is_none() && self.upload.is_none() && self.proof.is_none() {
            self.memory.clear();
            self.charged = 0;
            self.parts = [0; 3];
        } else {
            for (slot, absent) in [
                self.snapshot.is_none(),
                self.upload.is_none(),
                self.proof.is_none(),
            ]
            .into_iter()
            .enumerate()
            {
                if absent {
                    let _ = self.charge(slot, 0);
                }
            }
        }
    }
    pub fn dispatch(&mut self, operation: &str, input: Value) -> Result<Value> {
        let shared = self.shared.clone();
        let _admission = shared.admission()?;
        self.expire();
        if operation == "hello" {
            return self.hello(input);
        }
        if self.hello.is_none() {
            return Err(PeerError::new("UNAUTHORIZED"));
        }
        if operation == "submitMembershipProof" {
            return self.proof(input);
        }
        if matches!(
            operation,
            "getInvitationProof"
                | "redeemInvitation"
                | "getJoinResult"
                | "deliverDeparture"
                | "getDepartureStatus"
        ) {
            return Err(PeerError::new("NOT_READY"));
        }
        let selected = self.authorize()?;
        match operation {
            "notifyHistory" => {
                let notification: NotifyHistory = parse(input)?;
                if notification.history.history_id != selected.history().snapshot().history_id {
                    self.shared.changed.notify_one();
                }
                Ok(json!({"received":true}))
            }
            "openHistory" => {
                let request: OpenHistory = parse(input)?;
                let history = match request.frontier {
                    None => selected.history().clone(),
                    Some(frontier) => {
                        history_subset(selected.history(), &frontier, self.repo.limits)?
                    }
                };
                self.charge(0, history.records().map(|r| r.encoded().len() + 512).sum())?;
                let snapshot_token = token();
                let result = HistoryOpened {
                    snapshot_token: snapshot_token.clone(),
                    history_id: history.snapshot().history_id,
                    frontier: history.snapshot().frontier.clone(),
                    record_count: history.snapshot().record_count,
                };
                self.snapshot = Some(Snapshot {
                    token: snapshot_token,
                    history,
                    touched: Instant::now(),
                    last_page: None,
                    complete: false,
                    transfer: None,
                });
                value(result)
            }
            "listHistoryIds" => {
                let request: ListHistoryIds = parse(input)?;
                if !(1..=MAX_MANIFEST_PAGE).contains(&request.limit) {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let s = self
                    .snapshot
                    .as_mut()
                    .filter(|s| s.token == request.snapshot_token)
                    .ok_or_else(|| PeerError::new("SNAPSHOT_EXPIRED"))?;
                if request.after_record_id != s.last_page && request.after_record_id.is_some() {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let all: Vec<_> = s.history.records().map(|r| r.id()).collect();
                let start = request
                    .after_record_id
                    .map_or(0, |id| all.partition_point(|v| *v <= id));
                let ids = all[start..]
                    .iter()
                    .take(request.limit)
                    .copied()
                    .collect::<Vec<_>>();
                let next = if start + ids.len() < all.len() {
                    ids.last().copied()
                } else {
                    None
                };
                s.last_page = next;
                s.complete = next.is_none();
                s.touched = Instant::now();
                value(HistoryIds {
                    history_id: s.history.snapshot().history_id,
                    record_ids: ids,
                    next_after_record_id: next,
                })
            }
            "submitHistoryManifest" => {
                self.manifest(parse(input)?, selected.history().network_id())
            }
            "readHistoryRecords" => self.records(parse(input)?),
            "acknowledgeHistory" => {
                let request: AcknowledgeHistory = parse(input)?;
                if request.record_ids.len() > MAX_MISSING_IDS {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let s = self
                    .snapshot
                    .as_mut()
                    .ok_or_else(|| PeerError::new("SNAPSHOT_EXPIRED"))?;
                if request.history_id != s.history.snapshot().history_id
                    || request
                        .record_ids
                        .iter()
                        .any(|id| s.history.record(*id).is_none())
                {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                s.touched = Instant::now();
                Ok(json!({"received":true}))
            }
            "exchangeAddressHints" => {
                let request: ExchangeAddressHints = parse(input)?;
                if request.hints.len() > 8 {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                for hint in request.hints {
                    if hint.body.network_id != selected.history().network_id()
                        || !selected.history().is_active(hint.body.membership_id)
                    {
                        return Err(PeerError::new("FORBIDDEN"));
                    }
                    hint.verify(
                        selected
                            .history()
                            .member(hint.body.membership_id)
                            .unwrap()
                            .public_key,
                    )?;
                    for address in &hint.body.endpoints {
                        super::transport::validate_remote_hint(address)?;
                    }
                    self.repo.retain_hint(&hint).map_err(unavailable)?;
                    self.shared.note_hint(&hint);
                }
                let hints = self
                    .repo
                    .peer_hints()
                    .map_err(unavailable)?
                    .into_iter()
                    .filter(|hint| {
                        hint.body
                            .endpoints
                            .iter()
                            .all(|e| super::transport::validate_remote_hint(e).is_ok())
                    })
                    .collect::<Vec<_>>();
                value(ExchangeAddressHints { hints })
            }
            "executeOperation"
            | "getRequestReceipt"
            | "readOperation"
            | "subscribeSessionUpdates" => Err(PeerError::new("NOT_READY")),
            _ => Err(PeerError::new("PROTOCOL_UNSUPPORTED")),
        }
    }
    fn hello(&mut self, input: Value) -> Result<Value> {
        if self.hello.is_some() {
            return Err(PeerError::new("INVALID_INPUT"));
        }
        let hello: Hello = parse(input)?;
        let (version, network, member) = hello.binding();
        if version != 1 {
            return Err(PeerError::new("PROTOCOL_UNSUPPORTED"));
        }
        if matches!(hello, Hello::Join { .. } | Hello::JoinRecovery { .. }) {
            return Err(PeerError::new("NOT_READY"));
        }
        let context = if matches!(hello, Hello::Proof { .. }) {
            self.repo
                .proof_selection(network, self.local_key)
                .map_err(unavailable)?
        } else {
            self.repo.current_selection().map_err(unavailable)?
        };
        if let Some(s) = context {
            if s.history().network_id() != network {
                return Err(PeerError::new("FORBIDDEN"));
            }
            if let Some(member) = member
                && s.history()
                    .member(member)
                    .is_some_and(|m| m.public_key != self.peer_key)
            {
                return Err(PeerError::new("UNAUTHORIZED"));
            }
        }
        self.hello = Some(hello);
        self.provisional = self.access() == Access::ProofOnly;
        let selected = self.selection().ok();
        let binding = selected.as_ref().filter(|s| {
            s.history()
                .member(s.local_member())
                .is_some_and(|m| m.public_key == self.local_key)
        });
        value(HelloResult {
            protocol_version: 1,
            network_id: network,
            membership_id: binding.map(|s| s.local_member()),
            history: if self.access() == Access::ProofOnly {
                None
            } else {
                binding.map(|s| s.history().snapshot().clone())
            },
            access: self.access(),
        })
    }
    fn manifest(&mut self, request: SubmitHistoryManifest, network: NetworkId) -> Result<Value> {
        match request {
            SubmitHistoryManifest::Open { history } => {
                if history.record_count == 0
                    || history.frontier.is_empty()
                    || !history.frontier.windows(2).all(|p| p[0] < p[1])
                {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                self.charge(
                    1,
                    history
                        .record_count
                        .checked_mul(128)
                        .ok_or_else(|| PeerError::new("RESOURCE_LIMIT"))?,
                )?;
                let manifest_token = token();
                self.upload = Some(Upload {
                    token: manifest_token.clone(),
                    history,
                    ids: Vec::new(),
                    complete: false,
                    touched: Instant::now(),
                    last: None,
                });
                value(ManifestProgress {
                    manifest_token,
                    next_after_record_id: None,
                    complete: false,
                })
            }
            SubmitHistoryManifest::Write {
                manifest_token,
                after_record_id,
                record_ids,
                done,
            } => {
                let u = self
                    .upload
                    .as_mut()
                    .filter(|u| u.token == manifest_token)
                    .ok_or_else(|| PeerError::new("SNAPSHOT_EXPIRED"))?;
                let retry = u.last.as_ref() == Some(&(after_record_id, record_ids.clone(), done));
                if !retry {
                    if u.complete
                        || after_record_id != u.ids.last().copied()
                        || record_ids.len() > MAX_MANIFEST_PAGE
                        || !record_ids.windows(2).all(|p| p[0] < p[1])
                        || after_record_id
                            .zip(record_ids.first())
                            .is_some_and(|(a, b)| a >= *b)
                        || u.ids.len() + record_ids.len() > u.history.record_count
                        || (!done && record_ids.is_empty())
                    {
                        return Err(PeerError::new("INVALID_INPUT"));
                    }
                    u.ids.extend_from_slice(&record_ids);
                    if done
                        && (u.ids.len() != u.history.record_count
                            || history_id(network, &u.ids)? != u.history.history_id
                            || u.history
                                .frontier
                                .iter()
                                .any(|id| u.ids.binary_search(id).is_err()))
                    {
                        self.upload = None;
                        return Err(PeerError::new("INVALID_PROOF"));
                    }
                    u.complete = done;
                    u.last = Some((after_record_id, record_ids, done));
                }
                u.touched = Instant::now();
                value(ManifestProgress {
                    manifest_token,
                    next_after_record_id: u.ids.last().copied(),
                    complete: u.complete,
                })
            }
        }
    }
    fn records(&mut self, request: ReadHistoryRecords) -> Result<Value> {
        if request.record_ids.is_empty()
            || request.record_ids.len() > MAX_MISSING_IDS
            || !request.record_ids.windows(2).all(|p| p[0] < p[1])
        {
            return Err(PeerError::new("INVALID_INPUT"));
        }
        let u = self
            .upload
            .as_mut()
            .filter(|u| u.complete && u.history.history_id == request.peer_history_id)
            .ok_or_else(|| PeerError::new("SYNC_REQUIRED"))?;
        let s = self
            .snapshot
            .as_mut()
            .filter(|s| s.token == request.snapshot_token && s.complete)
            .ok_or_else(|| PeerError::new("SNAPSHOT_EXPIRED"))?;
        if request.cursor.is_none() {
            let mut needed = BTreeSet::new();
            let mut pending = request.record_ids.clone();
            while let Some(id) = pending.pop() {
                if u.ids.binary_search(&id).is_ok() || !needed.insert(id) {
                    continue;
                }
                let r = s
                    .history
                    .record(id)
                    .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
                pending.extend_from_slice(r.body().parents());
            }
            let mut ordered = Vec::new();
            let mut sent = BTreeSet::new();
            while !needed.is_empty() {
                let id = needed
                    .iter()
                    .copied()
                    .find(|id| {
                        s.history
                            .record(*id)
                            .unwrap()
                            .body()
                            .parents()
                            .iter()
                            .all(|p| sent.contains(p) || u.ids.binary_search(p).is_ok())
                    })
                    .ok_or_else(|| PeerError::new("INVALID_PROOF"))?;
                needed.remove(&id);
                sent.insert(id);
                ordered.push(id);
            }
            s.transfer = Some(Transfer {
                request: request.record_ids.clone(),
                peer: request.peer_history_id,
                remaining: ordered,
                cursor: None,
            });
        }
        let transfer = s
            .transfer
            .as_mut()
            .filter(|t| {
                t.cursor == request.cursor
                    && t.request == request.record_ids
                    && t.peer == request.peer_history_id
            })
            .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
        let mut records = Vec::new();
        let mut bytes = 256;
        for id in transfer.remaining.iter().take(MAX_RECORD_PAGE) {
            let record = s.history.record(*id).unwrap();
            if bytes + record.encoded().len() > MAX_FRAME_BYTES - 1024 {
                break;
            }
            bytes += record.encoded().len();
            records.push(serde_json::from_slice::<Value>(record.encoded()).map_err(unavailable)?);
        }
        transfer.remaining.drain(..records.len());
        let has_more = !transfer.remaining.is_empty();
        transfer.cursor = has_more.then(token);
        s.touched = Instant::now();
        u.touched = Instant::now();
        value(HistoryRecords {
            history_id: s.history.snapshot().history_id,
            records,
            cursor: transfer.cursor.clone(),
            has_more,
        })
    }
    fn proof(&mut self, input: Value) -> Result<Value> {
        let request: SubmitMembershipProof = parse(input)?;
        match request {
            SubmitMembershipProof::Open {
                purpose,
                membership_id,
                record_id,
            } => {
                let hello = self.hello.as_ref().unwrap();
                let bound = hello.binding().2;
                if bound != membership_id
                    || matches!(hello,Hello::Proof{purpose:p,..} if *p!=purpose)
                {
                    return Err(PeerError::new("FORBIDDEN"));
                }
                let worker = self.shared.proof_permit(self.peer_key)?;
                let selected = self.selection()?;
                let known = membership_id
                    .and_then(|id| selected.history().member(id))
                    .is_some_and(|m| m.public_key == self.peer_key);
                let readable = if known && purpose != ProofPurpose::Admission {
                    Some(selected.history().clone())
                } else if record_id.is_none() && (known || membership_id.is_none()) {
                    Some(history_subset(
                        selected.history(),
                        &[RecordId::from_bytes(*selected.local_member().as_bytes())],
                        self.repo.limits,
                    )?)
                } else {
                    None
                };
                if readable.is_none() && purpose != ProofPurpose::Admission {
                    return Err(PeerError::new("FORBIDDEN"));
                }
                let proof_token = token();
                let history = readable.as_ref().map(|h| h.snapshot().clone());
                self.charge(
                    2,
                    readable.as_ref().map_or(0, |h| {
                        h.records()
                            .map(|r| r.encoded().len() + 512)
                            .sum::<usize>()
                            .saturating_mul(2)
                    }),
                )?;
                self.proof = Some(Proof {
                    token: proof_token.clone(),
                    purpose,
                    member: membership_id,
                    target: record_id,
                    records: BTreeMap::new(),
                    readable,
                    verified: known,
                    started: Instant::now(),
                    touched: Instant::now(),
                    _worker: worker,
                });
                Ok(json!({"proofToken":proof_token,"history":history}))
            }
            SubmitMembershipProof::Write {
                proof_token,
                records,
                done,
            } => {
                if records.len() > MAX_RECORD_PAGE {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let selected = self.selection()?;
                let mut proof = self
                    .proof
                    .take()
                    .filter(|p| p.token == proof_token)
                    .ok_or_else(|| PeerError::new("SNAPSHOT_EXPIRED"))?;
                let mut acknowledged = Vec::new();
                for v in records {
                    let record = decode_record(&serde_json::to_vec(&v).map_err(unavailable)?)?;
                    if record.body().parents().iter().any(|p| {
                        !proof.records.contains_key(p) && selected.history().record(*p).is_none()
                    }) {
                        continue;
                    }
                    proof.records.insert(record.id(), record);
                }
                self.charge(
                    2,
                    proof
                        .records
                        .values()
                        .map(|r| r.encoded().len() + 512)
                        .sum::<usize>()
                        .saturating_mul(2),
                )?;
                let mut complete = false;
                let mut summary = None;
                if done {
                    let mut all = proof.records.clone();
                    let mut pending: Vec<_> = all
                        .values()
                        .flat_map(|r| r.body().parents())
                        .copied()
                        .collect();
                    while let Some(id) = pending.pop() {
                        if all.contains_key(&id) {
                            continue;
                        }
                        let r = selected
                            .history()
                            .record(id)
                            .ok_or_else(|| PeerError::new("PROOF_INCOMPLETE"))?;
                        pending.extend_from_slice(r.body().parents());
                        all.insert(id, r.clone());
                    }
                    self.charge(
                        2,
                        all.values()
                            .map(|r| r.encoded().len() + 512)
                            .sum::<usize>()
                            .saturating_mul(4),
                    )?;
                    let verified = verify_history(
                        selected.history().network_id(),
                        &all.values().cloned().collect::<Vec<_>>(),
                        self.repo.limits,
                    )?;
                    let member = proof.member.ok_or_else(|| PeerError::new("FORBIDDEN"))?;
                    if verified
                        .member(member)
                        .is_none_or(|m| m.public_key != self.peer_key)
                    {
                        return Err(PeerError::new("FORBIDDEN"));
                    }
                    if proof.purpose == ProofPurpose::Admission {
                        let target = RecordId::from_bytes(*member.as_bytes());
                        if proof.target != Some(target) || !verified.is_active(member) {
                            return Err(PeerError::new("FORBIDDEN"));
                        }
                        let r = verified
                            .record(target)
                            .ok_or_else(|| PeerError::new("PROOF_INCOMPLETE"))?;
                        self.adopt_admission(
                            member,
                            r,
                            &all.values().cloned().collect::<Vec<_>>(),
                        )?;
                    }
                    acknowledged.extend(all.keys().copied());
                    summary = Some(verified.snapshot().clone());
                    proof.verified = true;
                    proof.readable = Some(verified);
                    complete = true;
                }
                proof.touched = Instant::now();
                self.proof = Some(proof);
                Ok(
                    json!({"proofToken":proof_token,"verifiedRecordIds":acknowledged,"complete":complete,"history":summary}),
                )
            }
            SubmitMembershipProof::Read {
                proof_token,
                cursor,
                limit,
            } => {
                if !(1..=MAX_RECORD_PAGE).contains(&limit) {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let p = self
                    .proof
                    .as_mut()
                    .filter(|p| p.token == proof_token)
                    .ok_or_else(|| PeerError::new("SNAPSHOT_EXPIRED"))?;
                let history = p
                    .readable
                    .as_ref()
                    .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
                let ordered = ancestor_order(history);
                let offset = cursor
                    .as_ref()
                    .map(|s| {
                        s.parse::<usize>()
                            .map_err(|_| PeerError::new("INVALID_INPUT"))
                    })
                    .transpose()?
                    .unwrap_or(0);
                if offset > ordered.len() {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let mut records = Vec::new();
                let mut bytes = 256;
                for r in ordered[offset..].iter().take(limit) {
                    if bytes + r.encoded().len() > MAX_FRAME_BYTES - 1024 {
                        break;
                    }
                    bytes += r.encoded().len();
                    records
                        .push(serde_json::from_slice::<Value>(r.encoded()).map_err(unavailable)?);
                }
                let end = offset + records.len();
                p.touched = Instant::now();
                Ok(
                    json!({"proofToken":proof_token,"records":records,"cursor":(end<ordered.len()).then(||end.to_string()),"hasMore":end<ordered.len(),"history":history.snapshot()}),
                )
            }
        }
    }
    fn adopt_admission(
        &self,
        member: MembershipId,
        record: &SignedRecord,
        proof: &[SignedRecord],
    ) -> Result<()> {
        for _ in 0..3 {
            let selected = self
                .repo
                .current_selection()
                .map_err(unavailable)?
                .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
            if selected.status() != SelectionStatus::Active
                || selected
                    .history()
                    .member(selected.local_member())
                    .is_none_or(|m| m.public_key != self.local_key)
                || self
                    .hello
                    .as_ref()
                    .is_none_or(|h| h.binding().1 != selected.history().network_id())
            {
                return Err(PeerError::new("FORBIDDEN"));
            }
            match consider(selected.history(), record, proof, self.repo.limits)? {
                Decision::Duplicate(_) => return Ok(()),
                Decision::HistoryConflict(evidence) => {
                    self.shared.quarantine(&self.repo, &evidence, member)?;
                    return Err(PeerError::new("HISTORY_CONFLICT"));
                }
                Decision::Proposed(proposal) => {
                    match self
                        .repo
                        .commit_adoption(&selected.selection_id().to_string(), &proposal)
                    {
                        Ok(()) => {
                            self.shared.changed.notify_one();
                            return Ok(());
                        }
                        Err(error) => {
                            let current = self.repo.current_selection().map_err(unavailable)?;
                            if current.as_ref().is_some_and(|s| {
                                s.selection_id() == selected.selection_id()
                                    && s.history().snapshot() != selected.history().snapshot()
                            }) {
                                continue;
                            }
                            return Err(unavailable(error));
                        }
                    }
                }
            }
        }
        Err(PeerError::new("SYNC_REQUIRED"))
    }
}
pub(super) fn ancestor_order(history: &VerifiedHistory) -> Vec<&SignedRecord> {
    let mut remaining: BTreeSet<_> = history.records().map(|r| r.id()).collect();
    let mut sent = BTreeSet::new();
    let mut ordered = Vec::new();
    while let Some(id) = remaining.iter().copied().find(|id| {
        history
            .record(*id)
            .unwrap()
            .body()
            .parents()
            .iter()
            .all(|p| sent.contains(p))
    }) {
        remaining.remove(&id);
        sent.insert(id);
        ordered.push(history.record(id).unwrap());
    }
    ordered
}
