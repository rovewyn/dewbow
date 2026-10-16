//! Untrusted Peer HTTP values. These types never establish membership authority.
use super::{codec, *};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_MANIFEST_PAGE: usize = 256;
pub const MAX_MISSING_IDS: usize = 128;
pub const MAX_RECORD_PAGE: usize = 32;
pub const CHUNK_BYTES: usize = 64 * 1024;

pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_value(codec::bounded_value(bytes, MAX_FRAME_BYTES)?).map_err(|_| Error {
        kind: ErrorKind::InvalidInput,
        message: "Invalid Peer input",
    })
}

pub fn history_id(network_id: NetworkId, record_ids: &[RecordId]) -> Result<HistoryId> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Commitment<'a> {
        protocol_version: u64,
        network_id: NetworkId,
        record_ids: &'a [RecordId],
    }
    if !codec::sorted_unique(record_ids) {
        return invalid("Unordered manifest");
    }
    Ok(HistoryId::from_bytes(codec::digest(
        "history",
        &Commitment {
            protocol_version: 1,
            network_id,
            record_ids,
        },
    )?))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Hello {
    Member {
        protocol_version: u64,
        network_id: NetworkId,
        membership_id: MembershipId,
        history: HistorySnapshot,
    },
    Proof {
        protocol_version: u64,
        network_id: NetworkId,
        membership_id: Option<MembershipId>,
        purpose: ProofPurpose,
    },
    Join {
        protocol_version: u64,
        network_id: NetworkId,
        issuer_membership_id: MembershipId,
        invitation_id: Nonce,
        join_attempt_id: Nonce,
    },
    JoinRecovery {
        protocol_version: u64,
        network_id: NetworkId,
        join_proof: Box<JoinProof>,
    },
}
impl Hello {
    pub fn binding(&self) -> (u64, NetworkId, Option<MembershipId>) {
        match self {
            Self::Member {
                protocol_version,
                network_id,
                membership_id,
                ..
            } => (*protocol_version, *network_id, Some(*membership_id)),
            Self::Proof {
                protocol_version,
                network_id,
                membership_id,
                ..
            } => (*protocol_version, *network_id, *membership_id),
            Self::Join {
                protocol_version,
                network_id,
                ..
            }
            | Self::JoinRecovery {
                protocol_version,
                network_id,
                ..
            } => (*protocol_version, *network_id, None),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProofPurpose {
    Admission,
    Exclusion,
    Departure,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloResult {
    pub protocol_version: u64,
    pub network_id: NetworkId,
    pub membership_id: Option<MembershipId>,
    pub history: Option<HistorySnapshot>,
    pub access: Access,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    ProofOnly,
    Synchronize,
    Business,
}

/// Authenticated routing context, checked against both TLS identities and live history.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessContext {
    pub protocol_version: u64,
    pub network_id: NetworkId,
    pub caller_membership_id: MembershipId,
    pub target_membership_id: MembershipId,
    pub history_id: HistoryId,
    pub source_host_id: HostId,
    pub target_host_id: HostId,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadName {
    ListHosts,
    ListSessions,
    GetSession,
    ReadSessionHistory,
    GetSessionActivity,
    ReadSessionContent,
}
impl ReadName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ListHosts => "listHosts",
            Self::ListSessions => "listSessions",
            Self::GetSession => "getSession",
            Self::ReadSessionHistory => "readSessionHistory",
            Self::GetSessionActivity => "getSessionActivity",
            Self::ReadSessionContent => "readSessionContent",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadOperation {
    #[serde(flatten)]
    pub context: BusinessContext,
    pub operation: ReadName,
    pub input: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribeSessionUpdates {
    #[serde(flatten)]
    pub context: BusinessContext,
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSessionUpdates {
    pub subscription_id: String,
    pub event_id: u64,
    pub network_id: NetworkId,
    pub host_id: HostId,
    pub membership_id: MembershipId,
    pub runtime_id: String,
    pub history_id: HistoryId,
    pub payload: Value,
}

macro_rules! input {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
    }
}
input!(OpenHistory { frontier: Option<Vec<RecordId>> });
input!(HistoryOpened { history_id: HistoryId, frontier: Vec<RecordId>, record_count: usize, snapshot_token: String });
input!(ListHistoryIds { snapshot_token: String, after_record_id: Option<RecordId>, limit: usize });
input!(HistoryIds { history_id: HistoryId, record_ids: Vec<RecordId>, next_after_record_id: Option<RecordId> });
input!(ReadHistoryRecords { snapshot_token: String, peer_history_id: HistoryId, record_ids: Vec<RecordId>, cursor: Option<String> });
input!(HistoryRecords { history_id: HistoryId, records: Vec<Value>, cursor: Option<String>, has_more: bool });
input!(AcknowledgeHistory { history_id: HistoryId, record_ids: Vec<RecordId> });
input!(NotifyHistory {
    history: HistorySnapshot
});
input!(AddressBody { protocol_version: u64, network_id: NetworkId, membership_id: MembershipId, endpoints: Vec<String>, lease_seconds: u64, nonce: Nonce });
input!(AddressHint {
    body: AddressBody,
    signature: Signature
});
input!(ExchangeAddressHints { hints: Vec<AddressHint> });

impl AddressHint {
    pub fn verify(&self, key: PublicKey) -> Result<()> {
        codec::version(self.body.protocol_version)?;
        if !(1..=300).contains(&self.body.lease_seconds) || self.body.endpoints.len() > 8 {
            return invalid("Invalid address hint");
        }
        codec::verify_signature(
            key,
            &codec::signing_bytes("address", &self.body)?,
            self.signature,
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SubmitHistoryManifest {
    Open {
        history: HistorySnapshot,
    },
    Write {
        manifest_token: String,
        after_record_id: Option<RecordId>,
        record_ids: Vec<RecordId>,
        done: bool,
    },
}
input!(ManifestProgress { manifest_token: String, next_after_record_id: Option<RecordId>, complete: bool });

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SubmitMembershipProof {
    Open {
        purpose: ProofPurpose,
        membership_id: Option<MembershipId>,
        record_id: Option<RecordId>,
    },
    Write {
        proof_token: String,
        records: Vec<Value>,
        done: bool,
    },
    Read {
        proof_token: String,
        cursor: Option<String>,
        limit: usize,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
impl PeerError {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.into(),
            message: code.replace('_', " "),
            retryable: matches!(
                code,
                "PROOF_INCOMPLETE"
                    | "SYNC_REQUIRED"
                    | "SNAPSHOT_EXPIRED"
                    | "RESOURCE_LIMIT"
                    | "NOT_READY"
                    | "UNAVAILABLE"
            ),
        }
    }
    pub fn status(&self) -> u16 {
        match self.code.as_str() {
            "UNAUTHORIZED" => 401,
            "FORBIDDEN" => 403,
            "PROOF_INCOMPLETE" | "SYNC_REQUIRED" | "HISTORY_CONFLICT" | "REQUEST_CONFLICT" => 409,
            "SNAPSHOT_EXPIRED" => 410,
            "RESOURCE_LIMIT" => 429,
            "NOT_READY" | "UNAVAILABLE" => 503,
            _ => 400,
        }
    }
}
impl std::fmt::Display for PeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}
impl std::error::Error for PeerError {}
impl From<super::Error> for PeerError {
    fn from(error: super::Error) -> Self {
        Self::new(match error.kind {
            ErrorKind::ProofIncomplete => "PROOF_INCOMPLETE",
            ErrorKind::ProtocolUnsupported => "PROTOCOL_UNSUPPORTED",
            ErrorKind::ResourceLimit => "RESOURCE_LIMIT",
            ErrorKind::StaleBase => "SYNC_REQUIRED",
            _ => "INVALID_PROOF",
        })
    }
}

/// Restricted enrollment and departure surfaces; these values convey no authority.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationRequest {
    pub invitation: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedeemInvitation {
    pub invitation: String,
    pub join_proof: JoinProof,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetJoinResult {
    pub join_proof: JoinProof,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverDeparture {
    pub departure_record_id: RecordId,
    pub record: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetDepartureStatus {
    pub departure_record_id: RecordId,
    pub membership_id: MembershipId,
}
