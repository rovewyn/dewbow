//! Network management storage and authenticated peer integration.
//! CLI membership and typed native business operations share this management store.
pub(crate) mod business;
mod keys;
pub mod lifecycle;
pub(crate) mod migration;
mod operations;
pub mod peer;
mod peer_store;
mod repository;
pub(crate) mod schema;
mod types;
mod validation;
pub use operations::{InvitationResult, IssuerJoinResult, PreparedDepartureResult};
pub use peer_store::{Contact, PeerSettings};
pub use repository::Repository;
pub use types::*;
#[cfg(test)]
mod tests;

pub(crate) fn environment(
    state: &std::path::Path,
) -> anyhow::Result<(
    Option<dewbow_protocol::network::HostId>,
    dewbow_protocol::network::Limits,
)> {
    use dewbow_protocol::network::{HostId, Limits};
    let host = if state.join("config.json").exists() {
        Some(HostId::parse(&crate::config::load(state)?.host_id)?)
    } else {
        None
    };
    let working_bytes = match std::env::var("DEWBOW_NETWORK_WORKING_BYTES") {
        Ok(value) => {
            let value: usize = value.parse()?;
            anyhow::ensure!(value > 0, "Invalid Network working budget");
            value
        }
        Err(std::env::VarError::NotPresent) => Limits::default().working_bytes,
        Err(error) => return Err(error.into()),
    };
    Ok((
        host,
        Limits {
            working_bytes,
            ..Limits::default()
        },
    ))
}
pub(crate) fn validate_connection(
    db: &rusqlite::Connection,
    state: &std::path::Path,
) -> anyhow::Result<()> {
    let (host, limits) = environment(state)?;
    validation::validate(db, state, host, limits)
}

/// Read-only inventory for a stopped, checkpointed management snapshot.
pub fn snapshot_keys(
    state: &std::path::Path,
) -> anyhow::Result<(i64, std::collections::BTreeMap<String, String>)> {
    use sha2::{Digest, Sha256};
    let path = state.join("daemon.sqlite");
    if !path.exists() {
        return Ok((0, Default::default()));
    }
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version = schema::inspect(&db)?;
    let mut result = std::collections::BTreeMap::new();
    if version == 2 {
        validate_connection(&db, state)?;
        let mut q=db.prepare("SELECT key_id,public_key,storage_status FROM network_keys WHERE storage_status<>'deleted'")?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, public, status) = row?;
            let path = state.join("network-keys").join(format!("{id}.pk8"));
            dewbow_sdk::private::no_links(&path)?;
            if status == "deletePending" && !path.exists() {
                continue;
            }
            keys::KeyFiles::new(state).validate(
                &id,
                dewbow_protocol::network::PublicKey::from_bytes(
                    public
                        .try_into()
                        .map_err(|_| anyhow::anyhow!(crate::store::INVALID_STATE))?,
                ),
            )?;
            let hash = Sha256::digest(std::fs::read(path)?)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            result.insert(id, hash);
        }
    }
    Ok((version, result))
}
