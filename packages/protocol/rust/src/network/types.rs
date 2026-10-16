use super::{Error, ErrorKind, Result, invalid};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

pub const MAX_RECORD_BYTES: usize = 256 * 1024;
pub const MAX_JSON_DEPTH: usize = 16;
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

macro_rules! bytes_type {
    ($name:ident, $size:expr) => {
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; $size]);
        impl $name {
            pub const fn from_bytes(bytes: [u8; $size]) -> Self {
                Self(bytes)
            }
            pub const fn as_bytes(&self) -> &[u8; $size] {
                &self.0
            }
            pub fn parse(text: &str) -> Result<Self> {
                if text.len() != ($size as usize * 8).div_ceil(6) {
                    return invalid("Incorrect encoded length");
                }
                let mut bytes = [0; $size];
                let len = URL_SAFE_NO_PAD
                    .decode_slice(text, &mut bytes)
                    .map_err(|_| Error {
                        kind: ErrorKind::InvalidInput,
                        message: "Invalid base64url",
                    })?;
                if len != $size || URL_SAFE_NO_PAD.encode(bytes) != text {
                    return invalid("Noncanonical base64url");
                }
                Ok(Self(bytes))
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&URL_SAFE_NO_PAD.encode(self.0))
            }
        }
        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}({})", stringify!($name), self)
            }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
                s.collect_str(self)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
                Self::parse(&String::deserialize(d)?).map_err(de::Error::custom)
            }
        }
    };
}
bytes_type!(RecordId, 32);
bytes_type!(NetworkId, 32);
bytes_type!(MembershipId, 32);
bytes_type!(HistoryId, 32);
bytes_type!(Nonce, 32);
bytes_type!(PublicKey, 32);
bytes_type!(Signature, 64);

impl From<RecordId> for NetworkId {
    fn from(id: RecordId) -> Self {
        Self::from_bytes(*id.as_bytes())
    }
}
impl From<RecordId> for MembershipId {
    fn from(id: RecordId) -> Self {
        Self::from_bytes(*id.as_bytes())
    }
}
impl From<NetworkId> for RecordId {
    fn from(id: NetworkId) -> Self {
        Self::from_bytes(*id.as_bytes())
    }
}
impl From<MembershipId> for RecordId {
    fn from(id: MembershipId) -> Self {
        Self::from_bytes(*id.as_bytes())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HostId(uuid::Uuid);
impl HostId {
    pub fn parse(text: &str) -> Result<Self> {
        let value = uuid::Uuid::parse_str(text).map_err(|_| Error {
            kind: ErrorKind::InvalidInput,
            message: "Invalid host UUID",
        })?;
        if value.to_string() != text {
            return invalid("Noncanonical host UUID");
        }
        Ok(Self(value))
    }
}
impl std::fmt::Display for HostId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl Serialize for HostId {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for HostId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Self::parse(&String::deserialize(d)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinBody {
    pub protocol_version: u64,
    pub network_id: NetworkId,
    pub issuer_membership_id: MembershipId,
    pub invitation_id: Nonce,
    pub invitation_history_id: HistoryId,
    pub invitation_frontier: Vec<RecordId>,
    pub join_attempt_id: Nonce,
    pub host_id: HostId,
    pub public_key: PublicKey,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinProof {
    pub body: JoinBody,
    pub signature: Signature,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionPayload {
    pub join_proof: Box<JoinProof>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawalPayload {
    pub membership_id: MembershipId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RecordBody {
    CreateNetwork {
        protocol_version: u64,
        nonce: Nonce,
        network_name: String,
        host_id: HostId,
        public_key: PublicKey,
    },
    AdmitMember {
        protocol_version: u64,
        network_id: NetworkId,
        operation_id: Nonce,
        author_membership_id: MembershipId,
        parents: Vec<RecordId>,
        payload: AdmissionPayload,
    },
    RemoveMember {
        protocol_version: u64,
        network_id: NetworkId,
        operation_id: Nonce,
        author_membership_id: MembershipId,
        parents: Vec<RecordId>,
        payload: WithdrawalPayload,
    },
    LeaveNetwork {
        protocol_version: u64,
        network_id: NetworkId,
        operation_id: Nonce,
        author_membership_id: MembershipId,
        parents: Vec<RecordId>,
        payload: WithdrawalPayload,
    },
}
impl RecordBody {
    pub fn parents(&self) -> &[RecordId] {
        match self {
            Self::CreateNetwork { .. } => &[],
            Self::AdmitMember { parents, .. }
            | Self::RemoveMember { parents, .. }
            | Self::LeaveNetwork { parents, .. } => parents,
        }
    }
    pub fn author(&self) -> Option<MembershipId> {
        match self {
            Self::CreateNetwork { .. } => None,
            Self::AdmitMember {
                author_membership_id,
                ..
            }
            | Self::RemoveMember {
                author_membership_id,
                ..
            }
            | Self::LeaveNetwork {
                author_membership_id,
                ..
            } => Some(*author_membership_id),
        }
    }
    pub fn operation_id(&self) -> Option<Nonce> {
        match self {
            Self::CreateNetwork { .. } => None,
            Self::AdmitMember { operation_id, .. }
            | Self::RemoveMember { operation_id, .. }
            | Self::LeaveNetwork { operation_id, .. } => Some(*operation_id),
        }
    }
    pub fn withdrawal(&self) -> Option<MembershipId> {
        match self {
            Self::RemoveMember { payload, .. } | Self::LeaveNetwork { payload, .. } => {
                Some(payload.membership_id)
            }
            _ => None,
        }
    }
    pub fn join(&self) -> Option<&JoinBody> {
        match self {
            Self::AdmitMember { payload, .. } => Some(&payload.join_proof.body),
            _ => None,
        }
    }
    pub fn is_ordinary(&self) -> bool {
        matches!(self, Self::AdmitMember { .. } | Self::RemoveMember { .. })
    }
    pub(crate) fn version(&self) -> u64 {
        match self {
            Self::CreateNetwork {
                protocol_version, ..
            }
            | Self::AdmitMember {
                protocol_version, ..
            }
            | Self::RemoveMember {
                protocol_version, ..
            }
            | Self::LeaveNetwork {
                protocol_version, ..
            } => *protocol_version,
        }
    }
    pub(crate) fn label(&self) -> &'static str {
        if matches!(self, Self::CreateNetwork { .. }) {
            "genesis"
        } else {
            "change"
        }
    }
    pub(crate) fn network(&self) -> Option<NetworkId> {
        match self {
            Self::CreateNetwork { .. } => None,
            Self::AdmitMember { network_id, .. }
            | Self::RemoveMember { network_id, .. }
            | Self::LeaveNetwork { network_id, .. } => Some(*network_id),
        }
    }
}

/// Parsed, not authorized. Only VerifiedHistory establishes membership authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedRecord {
    pub(crate) record_id: RecordId,
    pub(crate) body: RecordBody,
    pub(crate) signature: Signature,
    pub(crate) encoded: Vec<u8>,
}
impl SignedRecord {
    pub fn id(&self) -> RecordId {
        self.record_id
    }
    pub fn body(&self) -> &RecordBody {
        &self.body
    }
    pub fn signature(&self) -> Signature {
        self.signature
    }
    /// Frozen canonical envelope, suitable for exact retained-result reuse.
    pub fn encoded(&self) -> &[u8] {
        &self.encoded
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub history_id: HistoryId,
    pub frontier: Vec<RecordId>,
    pub record_count: usize,
}
