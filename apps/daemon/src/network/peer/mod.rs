//! Direct authenticated peer transport with native read and mutation adapters.
mod bootstrap;
mod business;
pub mod framing;
mod lifecycle;
mod reconcile;
mod session;
mod tls;
mod transport;
pub(crate) use business::{RemoteStream, connect_target};
use dewbow_protocol::network::peer::PeerError;
pub use session::PeerCapacity;
pub(crate) use transport::PeerConnector;
pub use transport::{PeerClient, PeerRuntime};
pub(super) type Result<T> = std::result::Result<T, PeerError>;
pub(super) fn unavailable(_: impl std::fmt::Display) -> PeerError {
    PeerError::new("UNAVAILABLE")
}
#[cfg(test)]
mod tests;
