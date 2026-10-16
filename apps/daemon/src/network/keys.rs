use crate::config;
use anyhow::{Context, ensure};
use dewbow_protocol::network::{PreparedJoin, PreparedRecord, PublicKey, Signature};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

pub(crate) struct KeyFiles {
    directory: PathBuf,
}
impl KeyFiles {
    pub fn sign_ack(
        &self,
        id: &str,
        public: PublicKey,
        body: super::types::DepartureAckBody,
    ) -> anyhow::Result<super::types::DepartureAck> {
        let key = self.load(id, public)?;
        let mut bytes = b"dewbow.network.departureAck.v1\0".to_vec();
        bytes.extend(serde_jcs::to_vec(&body)?);
        Ok(super::types::DepartureAck {
            body,
            signature: Signature::from_bytes(key.sign(&bytes).to_bytes()),
        })
    }
    pub fn sign_invitation(
        &self,
        id: &str,
        body: super::types::InvitationBody,
    ) -> anyhow::Result<super::types::PublicInvitation> {
        let key = self.load(id, body.issuer_public_key)?;
        let mut bytes = b"dewbow.network.invitation.v1\0".to_vec();
        bytes.extend(serde_jcs::to_vec(&body)?);
        let invitation = super::types::PublicInvitation {
            body,
            signature: Signature::from_bytes(key.sign(&bytes).to_bytes()),
        };
        invitation.validate()?;
        Ok(invitation)
    }
    pub fn new(state: &Path) -> Self {
        Self {
            directory: state.join("network-keys"),
        }
    }

    fn path(&self, id: &str) -> anyhow::Result<PathBuf> {
        ensure!(
            uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id),
            "Invalid local key ID"
        );
        dewbow_sdk::private::no_links(&self.directory)?;
        Ok(self.directory.join(format!("{id}.pk8")))
    }

    /// A returned file is not usable until its association commits in SQLite.
    pub fn create(&self) -> anyhow::Result<(String, PublicKey)> {
        config::secure_directory(&self.directory)?;
        crate::maintenance::sync_directory(self.directory.parent().unwrap())?;
        let id = dewbow_protocol::id();
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::fill(seed.as_mut()).context("Cannot obtain secure random key material")?;
        let key = SigningKey::from_bytes(&seed);
        let public = PublicKey::from_bytes(key.verifying_key().to_bytes());
        let encoded = key.to_pkcs8_der().context("Cannot encode private key")?;
        let stage = self.directory.join(format!(".{id}.stage"));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&stage)?;
        file.write_all(encoded.as_bytes())?;
        file.sync_all()?;
        drop(file);
        #[cfg(test)]
        super::migration::checkpoint("keyStaged")?;
        dewbow_sdk::private::private_file(&stage)?;
        dewbow_sdk::private::publish_new(&stage, &self.path(&id)?)?;
        self.load(&id, public)?;
        Ok((id, public))
    }

    fn load(&self, id: &str, expected: PublicKey) -> anyhow::Result<SigningKey> {
        let path = self.path(id)?;
        self.load_path(&path, expected)
    }

    fn load_path(&self, path: &Path, expected: PublicKey) -> anyhow::Result<SigningKey> {
        dewbow_sdk::private::private_file(path)
            .context("RECOVERY_REQUIRED: private key unavailable")?;
        ensure!(
            fs::metadata(path)?.len() <= 1024,
            "RECOVERY_REQUIRED: invalid private key container"
        );
        let bytes = Zeroizing::new(fs::read(path)?);
        let key = SigningKey::from_pkcs8_der(&bytes)
            .context("RECOVERY_REQUIRED: invalid private key container")?;
        ensure!(
            key.verifying_key().to_bytes() == *expected.as_bytes(),
            "RECOVERY_REQUIRED: private key binding mismatch"
        );
        Ok(key)
    }

    pub fn validate(&self, id: &str, expected: PublicKey) -> anyhow::Result<()> {
        self.load(id, expected).map(drop)
    }

    pub fn sign_record(
        &self,
        id: &str,
        prepared: PreparedRecord,
    ) -> anyhow::Result<dewbow_protocol::network::SignedRecord> {
        let key = self.load(id, prepared.public_key())?;
        let signature = Signature::from_bytes(key.sign(prepared.signing_bytes()).to_bytes());
        Ok(prepared.finish(signature)?)
    }

    pub fn sign_join(
        &self,
        id: &str,
        prepared: PreparedJoin,
    ) -> anyhow::Result<dewbow_protocol::network::JoinProof> {
        let key = self.load(id, prepared.body().public_key)?;
        let signature = Signature::from_bytes(key.sign(prepared.signing_bytes()).to_bytes());
        Ok(prepared.finish(signature)?)
    }

    pub fn delete(&self, id: &str, expected: PublicKey) -> anyhow::Result<()> {
        let path = self.path(id)?;
        let tomb = self.directory.join(format!(".{id}.deleted"));
        if path.exists() {
            self.load_path(&path, expected)?;
            dewbow_sdk::private::publish_new(&path, &tomb)?;
        }
        if tomb.exists() {
            self.load_path(&tomb, expected)?;
            fs::remove_file(tomb)?;
            #[cfg(unix)]
            fs::File::open(&self.directory)?.sync_all()?;
        }
        Ok(())
    }
}
