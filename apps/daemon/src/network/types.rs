use anyhow::ensure;
use dewbow_protocol::network::*;
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct Intent {
    pub request_id: String,
    pub operation: String,
    pub fingerprint: [u8; 32],
    pub operation_id: Option<Nonce>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationBody {
    pub protocol_version: u64,
    pub network_id: NetworkId,
    pub issuer_membership_id: MembershipId,
    pub issuer_public_key: PublicKey,
    pub history_id: HistoryId,
    pub invitation_frontier: Vec<RecordId>,
    pub invitation_id: Nonce,
    pub issued_at: String,
    pub expires_at: String,
    pub credential_hash: Nonce,
    pub endpoints: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicInvitation {
    pub body: InvitationBody,
    pub signature: Signature,
}
impl PublicInvitation {
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            self.body.protocol_version == 1,
            "Unsupported invitation protocol"
        );
        let issued = timestamp(&self.body.issued_at)?;
        ensure!(
            timestamp(&self.body.expires_at)? > issued,
            "Invalid invitation interval"
        );
        ensure!(
            !self.body.invitation_frontier.is_empty()
                && self
                    .body
                    .invitation_frontier
                    .windows(2)
                    .all(|p| p[0] < p[1]),
            "Invalid invitation frontier"
        );
        ensure!(
            self.body.endpoints.len() <= 8,
            "Too many invitation endpoints"
        );
        for value in &self.body.endpoints {
            endpoint(value)?;
        }
        let key = VerifyingKey::from_bytes(self.body.issuer_public_key.as_bytes())?;
        ensure!(!key.is_weak(), "Weak invitation key");
        let mut bytes = b"dewbow.network.invitation.v1\0".to_vec();
        bytes.extend(serde_jcs::to_vec(&self.body)?);
        key.verify_strict(
            &bytes,
            &ed25519_dalek::Signature::from_bytes(self.signature.as_bytes()),
        )?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AttemptId {
    pub issuer: MembershipId,
    pub attempt: Nonce,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptScope {
    pub network_id: NetworkId,
    pub source_host_id: HostId,
    pub request_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRefs {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub codex_turn_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepartureAckBody {
    pub protocol_version: u64,
    pub network_id: NetworkId,
    pub departure_record_id: RecordId,
    pub membership_id: MembershipId,
    pub recipient_membership_id: MembershipId,
    pub history_id: HistoryId,
    pub status: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepartureAck {
    pub body: DepartureAckBody,
    pub signature: Signature,
}
impl DepartureAck {
    pub(crate) fn validate(&self, public: PublicKey) -> anyhow::Result<()> {
        ensure!(
            self.body.protocol_version == 1
                && matches!(self.body.status.as_str(), "absent" | "recipientInactive"),
            "Invalid departure acknowledgement"
        );
        let mut bytes = b"dewbow.network.departureAck.v1\0".to_vec();
        bytes.extend(serde_jcs::to_vec(&self.body)?);
        let key = VerifyingKey::from_bytes(public.as_bytes())?;
        ensure!(!key.is_weak(), "Weak acknowledgement key");
        key.verify_strict(
            &bytes,
            &ed25519_dalek::Signature::from_bytes(self.signature.as_bytes()),
        )?;
        Ok(())
    }
}

pub(crate) fn timestamp(value: &str) -> anyhow::Result<chrono::DateTime<chrono::Utc>> {
    let date = chrono::DateTime::parse_from_rfc3339(value)?.to_utc();
    ensure!(
        date.format("%Y-%m-%dT%H:%M:%SZ").to_string() == value,
        "Invalid protocol timestamp"
    );
    Ok(date)
}
pub(crate) fn local_timestamp(value: &str) -> anyhow::Result<chrono::DateTime<chrono::Utc>> {
    let date = chrono::DateTime::parse_from_rfc3339(value)?;
    ensure!(
        date.offset().local_minus_utc() == 0,
        "Invalid local UTC timestamp"
    );
    Ok(date.to_utc())
}
pub(crate) fn endpoint(value: &str) -> anyhow::Result<()> {
    let uri: axum::http::Uri = value.parse()?;
    ensure!(
        uri.scheme_str() == Some("https")
            && uri
                .authority()
                .is_some_and(|a| a.port_u16().is_some() && !a.as_str().contains('@'))
            && matches!(
                uri.path_and_query().map(|p| p.as_str()),
                None | Some("/") | Some("")
            ),
        "Invalid peer endpoint"
    );
    Ok(())
}
