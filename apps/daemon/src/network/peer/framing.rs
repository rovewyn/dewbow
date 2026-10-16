//! Volatile, bounded result/update framing shared by native read adapters.
use super::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use dewbow_protocol::network::{Nonce, peer::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;

pub const DEFAULT_TRANSFER_BYTES: usize = 64 * 1024 * 1024;
struct Bounded {
    bytes: Vec<u8>,
    bound: usize,
}
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.bound.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("Transfer budget exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub fn bounded_json(value: &impl Serialize, bound: usize) -> Result<Vec<u8>> {
    let mut writer = Bounded {
        bytes: Vec::new(),
        bound,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| PeerError::new("RESOURCE_LIMIT"))?;
    Ok(writer.bytes)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Frame {
    Start {
        transfer_id: String,
        event_type: String,
    },
    Chunk {
        transfer_id: String,
        index: usize,
        bytes: String,
    },
    End {
        transfer_id: String,
        chunk_count: usize,
        byte_length: usize,
        sha256: Nonce,
    },
}
pub struct Transfer {
    bytes: Vec<u8>,
    id: String,
    event_type: String,
    next: usize,
}
impl Transfer {
    pub fn new(value: &impl Serialize, event_type: &str, budget: usize) -> Result<Self> {
        if !matches!(event_type, "result" | "snapshot" | "update") {
            return Err(PeerError::new("INVALID_INPUT"));
        }
        Ok(Self {
            bytes: bounded_json(value, budget)?,
            id: uuid::Uuid::new_v4().to_string(),
            event_type: event_type.into(),
            next: 0,
        })
    }
    pub(super) fn from_bytes(bytes: Vec<u8>, event_type: &str) -> Self {
        Self {
            bytes,
            id: uuid::Uuid::new_v4().to_string(),
            event_type: event_type.into(),
            next: 0,
        }
    }
}
impl Iterator for Transfer {
    type Item = Frame;
    fn next(&mut self) -> Option<Frame> {
        let chunks = self.bytes.len().div_ceil(CHUNK_BYTES);
        let next = self.next;
        self.next += 1;
        if next == 0 {
            return Some(Frame::Start {
                transfer_id: self.id.clone(),
                event_type: self.event_type.clone(),
            });
        }
        if next <= chunks {
            return Some(Frame::Chunk {
                transfer_id: self.id.clone(),
                index: next - 1,
                bytes: URL_SAFE_NO_PAD.encode(
                    &self.bytes
                        [(next - 1) * CHUNK_BYTES..(next * CHUNK_BYTES).min(self.bytes.len())],
                ),
            });
        }
        if next == chunks + 1 {
            return Some(Frame::End {
                transfer_id: self.id.clone(),
                chunk_count: chunks,
                byte_length: self.bytes.len(),
                sha256: Nonce::from_bytes(Sha256::digest(&self.bytes).into()),
            });
        }
        None
    }
}
pub fn encode_line(frame: &Frame, sse: bool) -> Result<Vec<u8>> {
    let bytes = bounded_json(frame, MAX_FRAME_BYTES)?;
    if !sse {
        let mut line = bytes;
        line.push(b'\n');
        return Ok(line);
    }
    let name = match frame {
        Frame::Start { .. } => "start",
        Frame::Chunk { .. } => "chunk",
        Frame::End { .. } => "end",
    };
    let mut line = format!("event: {name}\ndata: ").into_bytes();
    line.extend(bytes);
    line.extend(b"\n\n");
    Ok(line)
}
pub struct Receiver {
    budget: usize,
    active: Option<(String, String, usize, Vec<u8>)>,
}

/// Incremental NDJSON/SSE decoder. Only complete validated events are returned.
pub struct StreamReceiver {
    receiver: Receiver,
    sse: bool,
    line: Vec<u8>,
    event: Option<String>,
    data: Option<Vec<u8>>,
}
impl StreamReceiver {
    pub fn new(sse: bool, budget: usize) -> Self {
        Self {
            receiver: Receiver::new(budget),
            sse,
            line: Vec::new(),
            event: None,
            data: None,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<(String, Value)>> {
        let result = self.push_inner(bytes);
        if result.is_err() {
            self.cancel();
        }
        result
    }
    fn push_inner(&mut self, bytes: &[u8]) -> Result<Vec<(String, Value)>> {
        let mut completed = Vec::new();
        for part in bytes.split_inclusive(|b| *b == b'\n') {
            if self.line.len() + part.len() > MAX_FRAME_BYTES {
                return Err(PeerError::new("RESOURCE_LIMIT"));
            }
            self.line.extend_from_slice(part);
            if !self.line.ends_with(b"\n") {
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if !self.sse {
                let frame: Frame = decode(&line)?;
                if let Some(event) = self.receiver.accept(frame)? {
                    completed.push(event);
                }
                continue;
            }
            if line.starts_with(b":") {
                continue;
            }
            if let Some(event) = line.strip_prefix(b"event: ") {
                if self.event.is_some() {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                self.event = Some(
                    String::from_utf8(event.to_vec())
                        .map_err(|_| PeerError::new("INVALID_INPUT"))?,
                );
            } else if let Some(data) = line.strip_prefix(b"data: ") {
                if self.data.is_some() {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                self.data = Some(data.to_vec());
            } else if line.is_empty() {
                if self.event.is_none() && self.data.is_none() {
                    continue;
                }
                let kind = self
                    .event
                    .take()
                    .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
                let data = self
                    .data
                    .take()
                    .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
                if kind == "streamError" {
                    self.receiver.cancel();
                    return Err(decode::<PeerError>(&data)?);
                }
                let frame: Frame = decode(&data)?;
                if !matches!(
                    (&*kind, &frame),
                    ("start", Frame::Start { .. })
                        | ("chunk", Frame::Chunk { .. })
                        | ("end", Frame::End { .. })
                ) {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                if let Some(event) = self.receiver.accept(frame)? {
                    completed.push(event);
                }
            } else {
                return Err(PeerError::new("INVALID_INPUT"));
            }
        }
        Ok(completed)
    }
    pub fn finish(&mut self) -> Result<()> {
        if !self.line.is_empty() || self.data.is_some() || self.event.is_some() {
            self.cancel();
            return Err(PeerError::new("DELIVERY_UNCERTAIN"));
        }
        self.receiver.finish()
    }
    pub fn cancel(&mut self) {
        self.receiver.cancel();
        self.line.clear();
        self.data = None;
        self.event = None;
    }
}
impl Receiver {
    pub fn new(budget: usize) -> Self {
        Self {
            budget,
            active: None,
        }
    }
    pub fn accept(&mut self, frame: Frame) -> Result<Option<(String, Value)>> {
        let result = self.accept_inner(frame);
        if result.is_err() {
            self.active = None;
        }
        result
    }
    fn accept_inner(&mut self, frame: Frame) -> Result<Option<(String, Value)>> {
        match frame {
            Frame::Start {
                transfer_id,
                event_type,
            } => {
                if self.active.is_some()
                    || uuid::Uuid::parse_str(&transfer_id).is_err()
                    || !matches!(event_type.as_str(), "result" | "snapshot" | "update")
                {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                self.active = Some((transfer_id, event_type, 0, Vec::new()));
                Ok(None)
            }
            Frame::Chunk {
                transfer_id,
                index,
                bytes,
            } => {
                let (id, _, next, buffer) = self
                    .active
                    .as_mut()
                    .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
                if *id != transfer_id || *next != index || bytes.len() > CHUNK_BYTES.div_ceil(3) * 4
                {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let decoded = URL_SAFE_NO_PAD
                    .decode(&bytes)
                    .map_err(|_| PeerError::new("INVALID_INPUT"))?;
                if decoded.is_empty()
                    || decoded.len() > CHUNK_BYTES
                    || URL_SAFE_NO_PAD.encode(&decoded) != bytes
                {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                if decoded.len() > self.budget.saturating_sub(buffer.len()) {
                    return Err(PeerError::new("RESOURCE_LIMIT"));
                }
                buffer.extend(decoded);
                *next += 1;
                Ok(None)
            }
            Frame::End {
                transfer_id,
                chunk_count,
                byte_length,
                sha256,
            } => {
                let (id, kind, count, buffer) = self
                    .active
                    .take()
                    .ok_or_else(|| PeerError::new("INVALID_INPUT"))?;
                if id != transfer_id
                    || count != chunk_count
                    || buffer.len() != byte_length
                    || Nonce::from_bytes(Sha256::digest(&buffer).into()) != sha256
                {
                    return Err(PeerError::new("INVALID_INPUT"));
                }
                let value =
                    serde_json::from_slice(&buffer).map_err(|_| PeerError::new("INVALID_INPUT"))?;
                Ok(Some((kind, value)))
            }
        }
    }
    pub fn finish(&mut self) -> Result<()> {
        if self.active.take().is_some() {
            Err(PeerError::new("DELIVERY_UNCERTAIN"))
        } else {
            Ok(())
        }
    }
    /// EOF, cancellation and streamError discard the incomplete logical event.
    pub fn cancel(&mut self) {
        self.active = None;
    }
}
