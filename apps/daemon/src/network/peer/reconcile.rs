use super::super::Repository;
use super::{PeerClient, Result, session::Shared, unavailable};
use dewbow_protocol::network::{peer::*, *};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::watch, time::Instant};

fn decode_records(values: Vec<Value>) -> Result<Vec<SignedRecord>> {
    values
        .into_iter()
        .map(|v| {
            Ok(decode_record(
                &serde_json::to_vec(&v).map_err(unavailable)?,
            )?)
        })
        .collect()
}
async fn adopt(
    repo: &Repository,
    shared: &Arc<Shared>,
    peer: MembershipId,
    record: &SignedRecord,
) -> Result<bool> {
    let repo = repo.clone();
    let shared = shared.clone();
    let record = record.clone();
    let work = shared.begin_work()?;
    tokio::task::spawn_blocking(move || {
        let _work = work;
        adopt_blocking(&repo, &shared, peer, &record)
    })
    .await
    .map_err(unavailable)?
}
fn adopt_blocking(
    repo: &Repository,
    shared: &Shared,
    peer: MembershipId,
    record: &SignedRecord,
) -> Result<bool> {
    let _admission = shared.admission()?;
    // Retry a stale proposal against the newest committed selection, never roll back.
    for _ in 0..3 {
        let selected = repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
        if selected.status() != SelectionStatus::Active || !selected.history().is_active(peer) {
            return Err(PeerError::new("FORBIDDEN"));
        }
        match consider(selected.history(), record, &[], repo.limits)? {
            Decision::Duplicate(_) => return Ok(true),
            Decision::Proposed(proposal) => {
                match repo.commit_adoption(&selected.selection_id().to_string(), &proposal) {
                    Ok(()) => {
                        shared.changed.notify_one();
                        return Ok(true);
                    }
                    Err(error) => {
                        let current = repo.current_selection().map_err(unavailable)?;
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
            Decision::HistoryConflict(evidence) => {
                shared.quarantine(repo, &evidence, peer)?;
                return Err(PeerError::new("HISTORY_CONFLICT"));
            }
        }
    }
    Err(PeerError::new("SYNC_REQUIRED"))
}

impl PeerClient {
    /// Pull a fixed complete snapshot; callers run the reverse direction independently.
    pub async fn synchronize(&mut self, repo: &Repository, deadline: Instant) -> Result<()> {
        let shared = self.shared.clone();
        self.synchronize_shared(repo, &shared, deadline).await
    }
    pub(super) async fn synchronize_shared(
        &mut self,
        repo: &Repository,
        shared: &Arc<Shared>,
        deadline: Instant,
    ) -> Result<()> {
        tokio::time::timeout_at(deadline, self.synchronize_inner(repo, shared, deadline))
            .await
            .map_err(|_| PeerError::new("SYNC_REQUIRED"))?
    }
    async fn synchronize_inner(
        &mut self,
        repo: &Repository,
        shared: &Arc<Shared>,
        deadline: Instant,
    ) -> Result<()> {
        let peer = self
            .hello
            .membership_id
            .ok_or_else(|| PeerError::new("UNAUTHORIZED"))?;
        loop {
            if Instant::now() >= deadline {
                return Err(PeerError::new("SYNC_REQUIRED"));
            }
            let selected = repo
                .current_selection()
                .map_err(unavailable)?
                .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
            if selected.status() != SelectionStatus::Active || !selected.history().is_active(peer) {
                return Err(PeerError::new("FORBIDDEN"));
            }
            let opened: HistoryOpened = self
                .request("openHistory", &OpenHistory { frontier: None })
                .await?;
            let remote = HistorySnapshot {
                history_id: opened.history_id,
                frontier: opened.frontier,
                record_count: opened.record_count,
            };
            if remote
                .record_count
                .checked_mul(128)
                .is_none_or(|n| n > repo.limits.working_bytes)
            {
                return Err(PeerError::new("RESOURCE_LIMIT"));
            }
            let _memory = shared
                .memory
                .clone()
                .try_acquire_many_owned(
                    (remote.record_count * 128)
                        .try_into()
                        .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?,
                )
                .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?;
            let mut ids = Vec::new();
            let mut after = None;
            loop {
                let page: HistoryIds = self
                    .request(
                        "listHistoryIds",
                        &ListHistoryIds {
                            snapshot_token: opened.snapshot_token.clone(),
                            after_record_id: after,
                            limit: MAX_MANIFEST_PAGE,
                        },
                    )
                    .await?;
                if page.history_id != remote.history_id
                    || page.record_ids.len() > MAX_MANIFEST_PAGE
                    || !page.record_ids.windows(2).all(|p| p[0] < p[1])
                    || ids
                        .last()
                        .zip(page.record_ids.first())
                        .is_some_and(|(a, b)| a >= b)
                    || ids.len() + page.record_ids.len() > remote.record_count
                {
                    return Err(PeerError::new("INVALID_PROOF"));
                }
                ids.extend(page.record_ids);
                if page.next_after_record_id.is_none() {
                    break;
                }
                if page.next_after_record_id != ids.last().copied()
                    || page.next_after_record_id == after
                {
                    return Err(PeerError::new("INVALID_PROOF"));
                }
                after = page.next_after_record_id;
            }
            if ids.len() != remote.record_count
                || history_id(selected.history().network_id(), &ids)? != remote.history_id
                || remote.frontier.is_empty()
                || !remote.frontier.windows(2).all(|p| p[0] < p[1])
                || remote
                    .frontier
                    .iter()
                    .any(|id| ids.binary_search(id).is_err())
            {
                return Err(PeerError::new("INVALID_PROOF"));
            }
            let local_ids: Vec<_> = selected.history().records().map(|r| r.id()).collect();
            let progress: ManifestProgress = self
                .request(
                    "submitHistoryManifest",
                    &SubmitHistoryManifest::Open {
                        history: selected.history().snapshot().clone(),
                    },
                )
                .await?;
            let mut after = None;
            for (index, chunk) in local_ids.chunks(MAX_MANIFEST_PAGE).enumerate() {
                let done = (index + 1) * MAX_MANIFEST_PAGE >= local_ids.len();
                let result: ManifestProgress = self
                    .request(
                        "submitHistoryManifest",
                        &SubmitHistoryManifest::Write {
                            manifest_token: progress.manifest_token.clone(),
                            after_record_id: after,
                            record_ids: chunk.to_vec(),
                            done,
                        },
                    )
                    .await?;
                if result.manifest_token != progress.manifest_token
                    || result.next_after_record_id != chunk.last().copied()
                    || result.complete != done
                {
                    return Err(PeerError::new("INVALID_PROOF"));
                }
                after = result.next_after_record_id;
            }
            let missing: Vec<_> = ids
                .iter()
                .copied()
                .filter(|id| local_ids.binary_search(id).is_err())
                .collect();
            for targets in missing.chunks(MAX_MISSING_IDS) {
                let mut cursor = None;
                let mut seen = BTreeSet::new();
                loop {
                    if Instant::now() >= deadline {
                        return Err(PeerError::new("SYNC_REQUIRED"));
                    }
                    let page: HistoryRecords = self
                        .request(
                            "readHistoryRecords",
                            &ReadHistoryRecords {
                                snapshot_token: opened.snapshot_token.clone(),
                                peer_history_id: selected.history().snapshot().history_id,
                                record_ids: targets.to_vec(),
                                cursor: cursor.clone(),
                            },
                        )
                        .await?;
                    if page.history_id != remote.history_id
                        || page.records.len() > MAX_RECORD_PAGE
                        || (page.has_more && page.records.is_empty())
                        || page.has_more != page.cursor.is_some()
                    {
                        return Err(PeerError::new("INVALID_PROOF"));
                    }
                    let records = decode_records(page.records)?;
                    let mut accepted = Vec::new();
                    for record in records {
                        if ids.binary_search(&record.id()).is_err() {
                            return Err(PeerError::new("INVALID_PROOF"));
                        }
                        match adopt(repo, shared, peer, &record).await {
                            Ok(true) => accepted.push(record.id()),
                            Err(e) if e.code == "PROOF_INCOMPLETE" => {}
                            Err(e) => return Err(e),
                            _ => {}
                        }
                    }
                    // Adoption may remove either endpoint. Its durable effect precedes access loss.
                    let current = repo.current_selection().map_err(unavailable)?.unwrap();
                    if current.status() != SelectionStatus::Active
                        || !current.history().is_active(peer)
                    {
                        return Err(PeerError::new("FORBIDDEN"));
                    }
                    let _: Value = self
                        .request(
                            "acknowledgeHistory",
                            &AcknowledgeHistory {
                                history_id: remote.history_id,
                                record_ids: accepted,
                            },
                        )
                        .await?;
                    if !page.has_more {
                        break;
                    }
                    if !seen.insert(page.cursor.clone().unwrap()) {
                        return Err(PeerError::new("INVALID_PROOF"));
                    }
                    cursor = page.cursor;
                }
            }
            let hints = repo
                .peer_hints()
                .map_err(unavailable)?
                .into_iter()
                .filter(|h| {
                    h.body
                        .endpoints
                        .iter()
                        .all(|a| super::transport::validate_remote_hint(a).is_ok())
                })
                .collect();
            let returned: ExchangeAddressHints = self
                .request("exchangeAddressHints", &ExchangeAddressHints { hints })
                .await?;
            if returned.hints.len() > 8 {
                return Err(PeerError::new("INVALID_PROOF"));
            }
            for hint in returned.hints {
                for address in &hint.body.endpoints {
                    super::transport::validate_remote_hint(address)?;
                }
                let _work = shared.begin_work()?;
                let _admission = shared.admission()?;
                repo.retain_hint(&hint).map_err(unavailable)?;
                shared.note_hint(&hint);
            }
            let final_remote: HistoryOpened = self
                .request("openHistory", &OpenHistory { frontier: None })
                .await?;
            let current = repo.current_selection().map_err(unavailable)?.unwrap();
            if final_remote.history_id == remote.history_id {
                // The receiver can retain additional compatible local records awaiting reverse pull.
                if ids.iter().all(|id| current.history().record(*id).is_some()) {
                    return Ok(());
                }
            }
        }
    }
}
fn jitter(base: Duration, percent: u32) -> Duration {
    let mut random = [0; 4];
    if getrandom::fill(&mut random).is_err() {
        return base;
    }
    base + base.mul_f64(f64::from(u32::from_le_bytes(random) % percent.max(1)) / 100.0)
}
pub(super) async fn schedule(
    repo: Repository,
    shared: Arc<Shared>,
    mut stop: watch::Receiver<bool>,
) {
    let mut retry: BTreeMap<MembershipId, (Instant, u32, usize)> = BTreeMap::new();
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    let mut next_compare = Instant::now();
    loop {
        tokio::select! {_=stop.changed()=>break,_=repo.changed.notified()=>{next_compare=Instant::now();for item in retry.values_mut(){if item.1==0{item.0=Instant::now();}}},_=shared.changed.notified()=>{next_compare=Instant::now();for item in retry.values_mut(){if item.1==0{item.0=Instant::now();}}},_=interval.tick()=>{}}
        let Ok(Some(selected)) = repo.current_selection() else {
            continue;
        };
        if selected.status() != SelectionStatus::Active {
            retry.clear();
            continue;
        }
        let now = Instant::now();
        let periodic = now >= next_compare;
        if periodic {
            next_compare = now + jitter(Duration::from_secs(30), 10);
        }
        let Ok(contacts) = repo.peer_contacts(selected.history().network_id()) else {
            continue;
        };
        let mut by_member: BTreeMap<MembershipId, Vec<_>> = BTreeMap::new();
        for contact in contacts {
            if contact.membership_id != selected.local_member()
                && selected.history().is_active(contact.membership_id)
            {
                by_member
                    .entry(contact.membership_id)
                    .or_default()
                    .push(contact);
            }
        }
        // Independent bounded tasks keep an unreachable peer from delaying other members.
        let mut jobs = tokio::task::JoinSet::new();
        for (member, contacts) in by_member {
            if shared
                .conflicts
                .lock()
                .unwrap()
                .contains(&(selected.history().network_id(), member))
            {
                continue;
            }
            let item = retry.entry(member).or_insert((now, 0, 0));
            if item.0 > now {
                continue;
            }
            let contact = contacts[item.2 % contacts.len()].clone();
            item.2 += 1;
            let repo = repo.clone();
            let shared = shared.clone();
            jobs.spawn(async move {
                let result = tokio::time::timeout(Duration::from_secs(30), async {
                    let mut peer = PeerClient::connect_shared(
                        &repo,
                        &contact.endpoint,
                        member,
                        contact.explicit_seed,
                        Some(&shared),
                    )
                    .await?;
                    let current = repo
                        .current_selection()
                        .map_err(unavailable)?
                        .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
                    let _: Value = peer
                        .request(
                            "notifyHistory",
                            &NotifyHistory {
                                history: current.history().snapshot().clone(),
                            },
                        )
                        .await?;
                    peer.synchronize_shared(
                        &repo,
                        &shared,
                        Instant::now() + Duration::from_secs(25),
                    )
                    .await?;
                    let _work = shared.begin_work()?;
                    let _admission = shared.admission()?;
                    repo.contact_succeeded(
                        peer.hello.network_id,
                        peer.hello.membership_id.unwrap(),
                        &contact.endpoint,
                    )
                    .map_err(unavailable)?;
                    Ok::<_, PeerError>(())
                })
                .await;
                (member, matches!(result, Ok(Ok(()))))
            });
            // At most sixteen outbound attempts leave room for incoming peers.
            if jobs.len() >= 16 {
                break;
            }
        }
        loop {
            tokio::select! {
                _=stop.changed()=>{jobs.abort_all();while jobs.join_next().await.is_some(){}return;},
                result=jobs.join_next()=>{
                    let Some(result)=result else{break};
                    if let Ok((member,success))=result{let item=retry.get_mut(&member).unwrap();if success{item.1=0;item.0=next_compare;}else{item.1=(item.1+1).min(10);item.0=Instant::now()+jitter(Duration::from_secs((1u64<<(item.1-1)).min(300)),20);}}
                }
            }
        }
    }
}
