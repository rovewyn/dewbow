//! Pure Network v1 membership rules. Returned proposals are not durable adoption.
mod codec;
mod history;
mod local;
pub mod peer;
mod types;

pub use codec::{decode_join_proof, decode_record};
pub use history::{
    ConflictEvidence, ConflictKind, Decision, Membership, Proposal, VerifiedHistory, consider,
    ready_candidates, verify_history,
};
pub use local::{
    Change, ConfirmedLocalAdmission, FreshSelectionPlan, LocalSelection, PreparedChange,
    PreparedDeparture, PreparedJoin, PreparedRecord, SelectionStatus, plan_fresh_selection,
    prepare_change, prepare_departure_rebase, prepare_genesis, prepare_join,
};
pub use types::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    InvalidInput,
    ProofIncomplete,
    ProtocolUnsupported,
    ResourceLimit,
    StaleBase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: &'static str,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn fail<T>(kind: ErrorKind, message: &'static str) -> Result<T> {
    Err(Error { kind, message })
}
pub(crate) fn invalid<T>(message: &'static str) -> Result<T> {
    fail(ErrorKind::InvalidInput, message)
}

/// Working capacity is local policy, not a history-validity or age/count cutoff.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub working_bytes: usize,
    pub conflict_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            working_bytes: 16 * 1024 * 1024,
            conflict_bytes: 16 * 1024 * 1024,
        }
    }
}
impl Limits {
    pub(crate) fn check(&self, bytes: usize) -> Result<()> {
        if bytes > self.working_bytes {
            fail(
                ErrorKind::ResourceLimit,
                "Increase the local proof working budget",
            )
        } else {
            Ok(())
        }
    }
}
