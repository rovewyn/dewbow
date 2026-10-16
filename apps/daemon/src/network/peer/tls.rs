use super::super::Repository;
use dewbow_protocol::network::PublicKey;
use ed25519_dalek::pkcs8::DecodePublicKey;
use rustls::{
    DigitallySignedStruct, DistinguishedName, Error, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, verify_tls13_signature},
    pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) fn selector(public: PublicKey) -> String {
    let hex: String = Sha256::digest(public.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("k-{}.{}.dewbow.invalid", &hex[..32], &hex[32..])
}
pub(super) fn public_key(cert: &CertificateDer<'_>) -> std::result::Result<PublicKey, Error> {
    let parsed = rustls::server::ParsedCertificate::try_from(cert)?;
    let key =
        ed25519_dalek::VerifyingKey::from_public_key_der(parsed.subject_public_key_info().as_ref())
            .map_err(|_| Error::General("Expected Ed25519 certificate".into()))?;
    if key.is_weak() || key.to_edwards().compress().to_bytes() != key.to_bytes() {
        return Err(Error::General("Weak or noncanonical key".into()));
    }
    Ok(PublicKey::from_bytes(key.to_bytes()))
}
fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}
#[cfg(test)]
pub(super) fn anonymous_client(expected: PublicKey) -> Arc<rustls::ClientConfig> {
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Verifier {
                expected: Some(expected),
            }))
            .with_no_client_auth(),
    )
}
#[derive(Debug)]
struct Verifier {
    expected: Option<PublicKey>,
}
impl Verifier {
    fn certificate(
        &self,
        cert: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
    ) -> std::result::Result<(), Error> {
        if !chain.is_empty() || cert.len() > 4096 {
            return Err(Error::General("Invalid key container".into()));
        }
        if self
            .expected
            .is_some_and(|key| public_key(cert).ok() != Some(key))
        {
            return Err(Error::General("Peer key pin mismatch".into()));
        }
        public_key(cert)?;
        Ok(())
    }
    fn signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        if dss.scheme != SignatureScheme::ED25519 {
            return Err(Error::General("Expected Ed25519 signature".into()));
        }
        verify_tls13_signature(
            message,
            cert,
            dss,
            &provider().signature_verification_algorithms,
        )
    }
}
impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> std::result::Result<ServerCertVerified, Error> {
        self.certificate(cert, chain)?;
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.3 required".into()))
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        self.signature(m, c, d)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}
impl ClientCertVerifier for Verifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        cert: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> std::result::Result<ClientCertVerified, Error> {
        self.certificate(cert, chain)?;
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.3 required".into()))
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        self.signature(m, c, d)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}
fn certificate(bytes: &[u8]) -> anyhow::Result<Arc<rustls::sign::CertifiedKey>> {
    let key = rcgen::KeyPair::from_pkcs8_der_and_sign_algo(
        &PrivatePkcs8KeyDer::from(bytes),
        &rcgen::PKCS_ED25519,
    )?;
    let cert =
        rcgen::CertificateParams::new(vec!["proof.dewbow.invalid".into()])?.self_signed(&key)?;
    let signing = rustls::crypto::aws_lc_rs::sign::any_supported_type(
        &PrivatePkcs8KeyDer::from(bytes.to_vec()).into(),
    )?;
    let certified = rustls::sign::CertifiedKey::new(vec![cert.der().clone()], signing);
    certified.keys_match()?;
    Ok(Arc::new(certified))
}
struct Resolver {
    certificate: Arc<rustls::sign::CertifiedKey>,
}
impl std::fmt::Debug for Resolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NetworkKeyResolver")
    }
}
impl rustls::server::ResolvesServerCert for Resolver {
    fn resolve(
        &self,
        _: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<rustls::sign::CertifiedKey>> {
        Some(self.certificate.clone())
    }
}
pub(super) struct ServerKeys {
    repo: Repository,
    proof: Arc<rustls::sign::CertifiedKey>,
}
impl ServerKeys {
    /// Select once before completing TLS, retaining that exact key as the HTTP binding.
    pub fn select(&self, name: &str) -> anyhow::Result<(Arc<rustls::ServerConfig>, PublicKey)> {
        let certificate = if name == "proof.dewbow.invalid" {
            let current = self
                .repo
                .current_selection()
                .ok()
                .flatten()
                .and_then(|s| s.history().member(s.local_member()).map(|m| m.public_key));
            self.repo
                .tls_keys()
                .ok()
                .and_then(|keys| {
                    keys.iter()
                        .find(|(key, _)| Some(*key) == current)
                        .or_else(|| keys.first())
                        .and_then(|(_, bytes)| certificate(bytes).ok())
                })
                .unwrap_or_else(|| self.proof.clone())
        } else {
            let keys = self.repo.tls_keys()?;
            let (_, bytes) = keys
                .iter()
                .find(|(key, _)| selector(*key) == name)
                .ok_or_else(|| anyhow::anyhow!("Pinned key unavailable"))?;
            certificate(bytes)?
        };
        let public = public_key(&certificate.cert[0])?;
        let mut config = rustls::ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_client_cert_verifier(Arc::new(Verifier { expected: None }))
            .with_cert_resolver(Arc::new(Resolver { certificate }));
        config.max_early_data_size = 0;
        config.send_tls13_tickets = 0;
        config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok((Arc::new(config), public))
    }
}
pub(super) fn server(repo: Repository) -> anyhow::Result<ServerKeys> {
    let temporary = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519)?;
    let proof = certificate(&temporary.serialize_der())?;
    Ok(ServerKeys { repo, proof })
}
pub(super) fn client(
    repo: &Repository,
    local: PublicKey,
    expected: Option<PublicKey>,
) -> anyhow::Result<Arc<rustls::ClientConfig>> {
    let keys = repo.tls_keys()?;
    let (_, bytes) = keys
        .iter()
        .find(|(key, _)| *key == local)
        .ok_or_else(|| anyhow::anyhow!("Committed private key unavailable"))?;
    let cert = certificate(bytes)?;
    let mut c = rustls::ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Verifier { expected }))
        .with_client_auth_cert(
            cert.cert.clone(),
            PrivatePkcs8KeyDer::from(bytes.to_vec()).into(),
        )?;
    c.resumption = rustls::client::Resumption::disabled();
    c.enable_early_data = false;
    c.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(c))
}
