use super::{types::*, *};
use ed25519_dalek::{Signature as EdSignature, VerifyingKey};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::fmt;

pub(crate) fn canonical<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_jcs::to_vec(value).map_err(|_| Error {
        kind: ErrorKind::InvalidInput,
        message: "Cannot canonicalize object",
    })
}
pub(crate) fn signing_bytes<T: Serialize>(label: &'static str, value: &T) -> Result<Vec<u8>> {
    let mut bytes = format!("dewbow.network.{label}.v1\0").into_bytes();
    bytes.extend(canonical(value)?);
    Ok(bytes)
}
pub(crate) fn digest<T: Serialize>(label: &'static str, value: &T) -> Result<[u8; 32]> {
    Ok(Sha256::digest(signing_bytes(label, value)?).into())
}

pub(crate) fn public_key(key: PublicKey) -> Result<VerifyingKey> {
    let parsed = VerifyingKey::from_bytes(key.as_bytes()).map_err(|_| Error {
        kind: ErrorKind::InvalidInput,
        message: "Invalid Ed25519 point",
    })?;
    if parsed.is_weak() || parsed.to_edwards().compress().to_bytes() != *key.as_bytes() {
        return invalid("Weak or noncanonical Ed25519 key");
    }
    Ok(parsed)
}
pub(crate) fn verify_signature(key: PublicKey, bytes: &[u8], signature: Signature) -> Result<()> {
    let key = public_key(key)?;
    // Strict verification rejects weak points/scalars; round-trip R as well to
    // enforce canonical point encodings independently of library acceptance.
    let r: [u8; 32] = signature.as_bytes()[..32].try_into().unwrap();
    public_key(PublicKey::from_bytes(r))?;
    key.verify_strict(bytes, &EdSignature::from_bytes(signature.as_bytes()))
        .map_err(|_| Error {
            kind: ErrorKind::InvalidInput,
            message: "Invalid Ed25519 signature",
        })
}
pub(crate) fn sorted_unique<T: Ord>(values: &[T]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}
pub(crate) fn version(version: u64) -> Result<()> {
    if version != 1 {
        fail(
            ErrorKind::ProtocolUnsupported,
            "Unsupported Network protocol",
        )
    } else {
        Ok(())
    }
}
pub(crate) fn check_join(proof: &JoinProof) -> Result<()> {
    version(proof.body.protocol_version)?;
    if proof.body.invitation_frontier.is_empty() || !sorted_unique(&proof.body.invitation_frontier)
    {
        return invalid("Invalid invitation frontier");
    }
    verify_signature(
        proof.body.public_key,
        &signing_bytes("join", &proof.body)?,
        proof.signature,
    )
}
pub(crate) fn check_body(body: &RecordBody) -> Result<()> {
    version(body.version())?;
    match body {
        RecordBody::CreateNetwork {
            network_name,
            public_key: key,
            ..
        } => {
            if network_name.is_empty() || network_name.len() > 256 {
                return invalid("Invalid Network name");
            }
            public_key(*key)?;
        }
        _ => {
            if body.parents().is_empty() || !sorted_unique(body.parents()) {
                return invalid("Invalid parent set");
            }
            if let RecordBody::AdmitMember { payload, .. } = body {
                check_join(&payload.join_proof)?;
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    record_id: RecordId,
    body: RecordBody,
    signature: Signature,
}

pub(crate) fn assemble(body: RecordBody, signature: Signature) -> Result<SignedRecord> {
    check_body(&body)?;
    let record_id = RecordId::from_bytes(digest(body.label(), &body)?);
    let encoded = canonical(&Envelope {
        record_id,
        body: body.clone(),
        signature,
    })?;
    if encoded.len() > MAX_RECORD_BYTES {
        return fail(ErrorKind::ResourceLimit, "Record exceeds v1 envelope bound");
    }
    Ok(SignedRecord {
        record_id,
        body,
        signature,
        encoded,
    })
}

/// Parse untrusted bytes before using serde_json::Value (which otherwise erases
/// duplicate properties). Parsing never establishes signature or member trust.
pub fn decode_record(bytes: &[u8]) -> Result<SignedRecord> {
    decode_envelope(strict_value(bytes)?)
}

/// Signature verification does not establish issuance/admission authority.
pub fn decode_join_proof(bytes: &[u8]) -> Result<JoinProof> {
    let value = strict_value(bytes)?;
    if let Some(v) = value
        .pointer("/body/protocolVersion")
        .and_then(Value::as_u64)
    {
        version(v)?;
    }
    let proof: JoinProof = serde_json::from_value(value).map_err(|_| Error {
        kind: ErrorKind::InvalidInput,
        message: "Invalid joining proof schema",
    })?;
    check_join(&proof)?;
    Ok(proof)
}

fn strict_value(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_RECORD_BYTES {
        return fail(ErrorKind::ResourceLimit, "Record exceeds v1 envelope bound");
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = StrictValue(0)
        .deserialize(&mut decoder)
        .map_err(|_| Error {
            kind: ErrorKind::InvalidInput,
            message: "Malformed, duplicate, too deep or unsupported JSON value",
        })?;
    decoder.end().map_err(|_| Error {
        kind: ErrorKind::InvalidInput,
        message: "Trailing JSON data",
    })?;
    Ok(value)
}

fn decode_envelope(value: Value) -> Result<SignedRecord> {
    if let Some(body) = value.get("body") {
        if let Some(v) = body.get("protocolVersion").and_then(Value::as_u64) {
            version(v)?;
        }
        if let Some(kind) = body.get("kind").and_then(Value::as_str)
            && !matches!(
                kind,
                "createNetwork" | "admitMember" | "removeMember" | "leaveNetwork"
            )
        {
            return fail(
                ErrorKind::ProtocolUnsupported,
                "Unsupported membership operation",
            );
        }
        if let Some(v) = body
            .pointer("/payload/joinProof/body/protocolVersion")
            .and_then(Value::as_u64)
        {
            version(v)?;
        }
    }
    let envelope: Envelope = serde_json::from_value(value).map_err(|_| Error {
        kind: ErrorKind::InvalidInput,
        message: "Invalid membership record schema",
    })?;
    let record = assemble(envelope.body, envelope.signature)?;
    if record.id() != envelope.record_id {
        return invalid("Record digest mismatch");
    }
    Ok(record)
}

struct StrictValue(usize);
impl<'de> DeserializeSeed<'de> for StrictValue {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        if self.0 > MAX_JSON_DEPTH {
            return Err(de::Error::custom("JSON nesting limit"));
        }
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for StrictValue {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("strict Network JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        if v > MAX_SAFE_INTEGER {
            return Err(E::custom("Unsafe integer"));
        }
        Ok(Value::Number(Number::from(v)))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        let v = u64::try_from(v).map_err(|_| E::custom("Negative integer"))?;
        self.visit_u64(v)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> std::result::Result<Value, E> {
        Err(E::custom("Float in control object"))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        if self.0 >= MAX_JSON_DEPTH {
            return Err(de::Error::custom("JSON nesting limit"));
        }
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(StrictValue(self.0 + 1))? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        if self.0 >= MAX_JSON_DEPTH {
            return Err(de::Error::custom("JSON nesting limit"));
        }
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("Duplicate property"));
            }
            values.insert(key, map.next_value_seed(StrictValue(self.0 + 1))?);
        }
        Ok(Value::Object(values))
    }
}
