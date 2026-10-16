//! Direct authenticated peer transport. No native business operations are registered.
mod bootstrap;
pub mod framing;
mod reconcile;
mod session;
mod tls;
mod transport;
use dewbow_protocol::network::peer::PeerError;
pub use session::PeerCapacity;
pub use transport::{PeerClient, PeerRuntime};
pub(super) type Result<T> = std::result::Result<T, PeerError>;
pub(super) fn unavailable(_: impl std::fmt::Display) -> PeerError {
    PeerError::new("UNAVAILABLE")
}
#[cfg(test)]
mod tests;
