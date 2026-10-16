use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod network;

pub const CONTRACT_VERSION: &str = "v1";
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
impl std::fmt::Display for ManagementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for ManagementError {}
pub fn error(code: &str, message: &str) -> ManagementError {
    ManagementError {
        code: code.into(),
        message: message.into(),
        retryable: matches!(code, "DELIVERY_UNCERTAIN" | "UNAVAILABLE"),
    }
}
pub fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, ManagementError> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 100_000)
        .ok_or_else(|| error("INVALID_INPUT", &format!("Invalid {key}.")))
}
pub fn fingerprint(value: &Value) -> String {
    // serde_json's map order is stable without the preserve_order feature.
    value.to_string()
}
pub fn content_ref(id: &str, kind: &str, bytes: usize, complete: bool) -> Value {
    json!({"contentId":id,"kind":kind,"label":if kind == "diff" {"File changes"} else {"Output"},"byteLength":bytes,
        "availability":"available","completeness":if complete {"complete"} else {"partial"},"authority":"operator"})
}
