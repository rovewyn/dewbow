//! Proof-only recovery never treats an address or TLS pin failure as authority.
use super::super::Repository;
use super::{
    PeerClient, Result,
    session::{Shared, ancestor_order},
    unavailable,
};
use dewbow_protocol::network::{peer::*, *};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
#[derive(Clone)]
pub(super) struct ProofView {
    history: VerifiedHistory,
    _lease: Arc<ProofLease>,
}
struct ProofLease {
    _worker: tokio::sync::OwnedSemaphorePermit,
    _memory: Vec<tokio::sync::OwnedSemaphorePermit>,
}
impl std::ops::Deref for ProofView {
    type Target = VerifiedHistory;
    fn deref(&self) -> &VerifiedHistory {
        &self.history
    }
}

impl PeerClient {
    pub(super) async fn read_proof(
        &mut self,
        repo: &Repository,
        open: SubmitMembershipProof,
    ) -> Result<ProofView> {
        let worker = self
            .shared
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?;
        let opened: Value = self.request("submitMembershipProof", &open).await?;
        self.read_opened_proof(repo, opened, worker).await
    }
    pub(super) async fn read_opened_proof(
        &mut self,
        repo: &Repository,
        opened: Value,
        worker: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<ProofView> {
        let token = opened["proofToken"]
            .as_str()
            .ok_or_else(|| PeerError::new("INVALID_PROOF"))?
            .to_string();
        let summary: HistorySnapshot = serde_json::from_value(opened["history"].clone())
            .map_err(|_| PeerError::new("INVALID_PROOF"))?;
        if summary
            .record_count
            .checked_mul(512)
            .is_none_or(|n| n > repo.limits.working_bytes)
        {
            return Err(PeerError::new("RESOURCE_LIMIT"));
        }
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        let mut records = BTreeMap::new();
        let mut bytes = 0usize;
        let mut memory = Vec::new();
        loop {
            let page: Value = self
                .request(
                    "submitMembershipProof",
                    &SubmitMembershipProof::Read {
                        proof_token: token.clone(),
                        cursor: cursor.clone(),
                        limit: MAX_RECORD_PAGE,
                    },
                )
                .await?;
            let page_summary: HistorySnapshot = serde_json::from_value(page["history"].clone())
                .map_err(|_| PeerError::new("INVALID_PROOF"))?;
            let values = page["records"]
                .as_array()
                .ok_or_else(|| PeerError::new("INVALID_PROOF"))?;
            if page["proofToken"] != token
                || page_summary != summary
                || values.len() > MAX_RECORD_PAGE
            {
                return Err(PeerError::new("INVALID_PROOF"));
            }
            for value in values {
                let record = decode_record(&serde_json::to_vec(value).map_err(unavailable)?)?;
                // Missing children are discarded. They never reserve identity or priority.
                if record
                    .body()
                    .parents()
                    .iter()
                    .any(|p| !records.contains_key(p))
                {
                    continue;
                }
                if records.contains_key(&record.id()) {
                    return Err(PeerError::new("INVALID_PROOF"));
                }
                let weight = (record.encoded().len() + 512).saturating_mul(4);
                bytes = bytes
                    .checked_add(weight)
                    .ok_or_else(|| PeerError::new("RESOURCE_LIMIT"))?;
                if bytes > repo.limits.working_bytes || records.len() >= summary.record_count {
                    return Err(PeerError::new("RESOURCE_LIMIT"));
                }
                memory.push(
                    self.shared
                        .memory
                        .clone()
                        .try_acquire_many_owned(
                            weight
                                .try_into()
                                .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?,
                        )
                        .map_err(|_| PeerError::new("RESOURCE_LIMIT"))?,
                );
                records.insert(record.id(), record);
            }
            let more = page["hasMore"]
                .as_bool()
                .ok_or_else(|| PeerError::new("INVALID_PROOF"))?;
            cursor = page["cursor"].as_str().map(str::to_string);
            if !more {
                if cursor.is_some() {
                    return Err(PeerError::new("INVALID_PROOF"));
                }
                break;
            }
            if values.is_empty() || cursor.as_ref().is_none_or(|c| !seen.insert(c.clone())) {
                return Err(PeerError::new("INVALID_PROOF"));
            }
        }
        let network = self.hello.network_id;
        let limits = repo.limits;
        let work = self.shared.begin_work()?;
        tokio::task::spawn_blocking(move || {
            let _work = work;
            let lease = Arc::new(ProofLease {
                _worker: worker,
                _memory: memory,
            });
            let history =
                verify_history(network, &records.into_values().collect::<Vec<_>>(), limits)?;
            if history.snapshot() != &summary {
                return Err(PeerError::new("INVALID_PROOF"));
            }
            Ok(ProofView {
                history,
                _lease: lease,
            })
        })
        .await
        .map_err(unavailable)?
    }
    pub(super) async fn adopt_proof(
        repo: &Repository,
        shared: &Arc<Shared>,
        peer: MembershipId,
        history: &ProofView,
    ) -> Result<()> {
        let repo = repo.clone();
        let shared = shared.clone();
        let history = history.clone();
        let work = shared.begin_work()?;
        tokio::task::spawn_blocking(move || {
            let _work = work;
            Self::adopt_proof_blocking(&repo, &shared, peer, &history)
        })
        .await
        .map_err(unavailable)?
    }
    fn adopt_proof_blocking(
        repo: &Repository,
        shared: &Arc<Shared>,
        peer: MembershipId,
        history: &VerifiedHistory,
    ) -> Result<()> {
        let _admission = shared.admission()?;
        for record in ancestor_order(history) {
            for attempt in 0..3 {
                let current = repo
                    .current_selection()
                    .map_err(unavailable)?
                    .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
                if current.status() != SelectionStatus::Active {
                    return Ok(());
                }
                match consider(current.history(), record, &[], repo.limits)? {
                    Decision::Duplicate(_) => break,
                    Decision::HistoryConflict(evidence) => {
                        shared.quarantine(repo, &evidence, peer)?;
                        return Err(PeerError::new("HISTORY_CONFLICT"));
                    }
                    Decision::Proposed(proposal) => {
                        match repo.commit_adoption(&current.selection_id().to_string(), &proposal) {
                            Ok(()) => {
                                shared.changed.notify_one();
                                break;
                            }
                            Err(error) => {
                                let latest = repo.current_selection().map_err(unavailable)?;
                                if latest.as_ref().is_some_and(|s| {
                                    s.selection_id() == current.selection_id()
                                        && s.history().snapshot() != current.history().snapshot()
                                }) && attempt < 2
                                {
                                    continue;
                                }
                                return Err(unavailable(error));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) async fn recover_identity(
        repo: &Repository,
        address: &str,
        original: MembershipId,
        explicit: bool,
        shared: &Arc<Shared>,
    ) -> Result<MembershipId> {
        let selected = repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("NOT_READY"))?;
        let expected = selected
            .history()
            .member(original)
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?
            .clone();
        if shared
            .conflicts
            .lock()
            .unwrap()
            .contains(&(selected.history().network_id(), original))
        {
            return Err(PeerError::new("HISTORY_CONFLICT"));
        }
        let mut proof = Self::open_transport(repo, address, None, explicit, shared).await?;
        proof.hello = proof
            .request(
                "hello",
                &Hello::Proof {
                    protocol_version: 1,
                    network_id: selected.history().network_id(),
                    membership_id: None,
                    purpose: ProofPurpose::Admission,
                },
            )
            .await?;
        if proof.hello.network_id != selected.history().network_id()
            || proof.hello.protocol_version != 1
            || proof.hello.access != Access::ProofOnly
        {
            return Err(PeerError::new("INVALID_PROOF"));
        }
        let history = proof
            .read_proof(
                repo,
                SubmitMembershipProof::Open {
                    purpose: ProofPurpose::Admission,
                    membership_id: None,
                    record_id: None,
                },
            )
            .await?;
        let id = proof
            .hello
            .membership_id
            .ok_or_else(|| PeerError::new("INVALID_PROOF"))?;
        let actual = history
            .member(id)
            .filter(|_| history.is_active(id))
            .ok_or_else(|| PeerError::new("INVALID_PROOF"))?;
        if actual.host_id != expected.host_id || actual.public_key != proof.remote_key {
            return Err(PeerError::new("UNAUTHORIZED"));
        }
        // Only normal compatible adoption can change the selected history.
        Self::adopt_proof(repo, shared, original, &history).await?;
        let current = repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
        if current.status() != SelectionStatus::Active || !current.history().is_active(id) {
            return Err(PeerError::new("FORBIDDEN"));
        }
        Ok(id)
    }
}
