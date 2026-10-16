use super::{Repository, keys::KeyFiles, types::endpoint};
use anyhow::ensure;
use dewbow_protocol::network::{peer::*, *};
use ed25519_dalek::{Signer, pkcs8::EncodePrivateKey};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use zeroize::Zeroizing;

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSettings {
    pub listen_endpoint: Option<String>,
    pub advertised_endpoints: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct Contact {
    pub membership_id: MembershipId,
    pub endpoint: String,
    pub explicit_seed: bool,
}

impl Repository {
    pub(super) fn peer_conflicts(&self) -> anyhow::Result<BTreeSet<(NetworkId, MembershipId)>> {
        let db = self.db.lock().unwrap();
        let mut q = db.prepare("SELECT network_id,reason FROM network_conflicts")?;
        let mut result = BTreeSet::new();
        for row in q.query_map([], |r| {
            Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, String>(1)?))
        })? {
            let (network, reason) = row?;
            if let Some((_, member)) = reason.rsplit_once(":peer:") {
                result.insert((
                    NetworkId::from_bytes(
                        network
                            .try_into()
                            .map_err(|_| anyhow::anyhow!("Invalid conflict Network"))?,
                    ),
                    MembershipId::parse(member)?,
                ));
            }
        }
        Ok(result)
    }
    pub(super) fn clear_peer_quarantine(
        &self,
        network: NetworkId,
        member: MembershipId,
    ) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let suffix = format!(":peer:{member}");
            let mut q =
                tx.prepare("SELECT witness_id,reason FROM network_conflicts WHERE network_id=?")?;
            let rows = q
                .query_map([network.as_bytes().as_slice()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (id, reason) in rows {
                if let Some(kind) = reason.strip_suffix(&suffix) {
                    tx.execute(
                        "UPDATE network_conflicts SET reason=? WHERE witness_id=?",
                        params![kind, id],
                    )?;
                }
            }
            Ok(())
        })
    }
    pub(super) fn remember_verified_peer(
        &self,
        network: NetworkId,
        member: MembershipId,
        address: &str,
        explicit: bool,
    ) -> anyhow::Result<()> {
        endpoint(address)?;
        self.transaction(|tx|{
            let selected=super::repository::current(tx,self.limits)?.ok_or_else(||anyhow::anyhow!("No selected Network"))?;
            ensure!(selected.status()==SelectionStatus::Active&&selected.history().network_id()==network&&selected.history().is_active(member),"Inactive peer contact");
            tx.execute("INSERT INTO network_contacts VALUES(?1,?2,?3,?4,NULL,?5) ON CONFLICT(network_id,membership_id,endpoint) DO UPDATE SET explicit_seed=max(explicit_seed,excluded.explicit_seed),last_success_at=excluded.last_success_at",params![network.as_bytes().as_slice(),member.as_bytes().as_slice(),address,explicit,dewbow_protocol::now()])?;
            tx.execute("DELETE FROM network_contacts WHERE rowid IN (SELECT rowid FROM network_contacts WHERE network_id=?1 AND membership_id=?2 ORDER BY explicit_seed DESC,last_success_at DESC,endpoint LIMIT -1 OFFSET 8)",params![network.as_bytes().as_slice(),member.as_bytes().as_slice()])?;
            Ok(())
        })
    }
    pub(super) fn proof_selection(
        &self,
        network: NetworkId,
        key: PublicKey,
    ) -> anyhow::Result<Option<LocalSelection>> {
        let db = self.db.lock().unwrap();
        let mut query=db.prepare("SELECT selection_id FROM network_selections JOIN network_keys USING(key_id) WHERE network_id=?1 AND public_key=?2 ORDER BY selection_id=(SELECT current_selection_id FROM network_settings) DESC,network_selections.created_at DESC,selection_id")?;
        let id = query
            .query_map(
                params![network.as_bytes().as_slice(), key.as_bytes().as_slice()],
                |r| r.get::<_, String>(0),
            )?
            .next()
            .transpose()?;
        id.map(|id| super::validation::selection(&db, &id, self.limits))
            .transpose()
    }
    pub(super) fn peer_hints(&self) -> anyhow::Result<Vec<AddressHint>> {
        let Some(selected) = self.current_selection()? else {
            return Ok(Vec::new());
        };
        if selected.status() != SelectionStatus::Active {
            return Ok(Vec::new());
        }
        let mut result = self.sign_address_hint()?.into_iter().collect::<Vec<_>>();
        let mut seen: BTreeSet<_> = result.iter().map(|hint| hint.body.membership_id).collect();
        let db = self.db.lock().unwrap();
        let mut query=db.prepare("SELECT signed_hint_json FROM network_contacts WHERE network_id=? AND signed_hint_json IS NOT NULL ORDER BY last_success_at DESC,membership_id,endpoint")?;
        for row in query.query_map(
            [selected.history().network_id().as_bytes().as_slice()],
            |r| r.get::<_, String>(0),
        )? {
            if result.len() == 8 {
                break;
            }
            let hint: AddressHint = serde_json::from_str(&row?)?;
            if selected.history().is_active(hint.body.membership_id)
                && seen.insert(hint.body.membership_id)
            {
                result.push(hint);
            }
        }
        Ok(result)
    }
    pub fn peer_settings(&self) -> anyhow::Result<PeerSettings> {
        let db = self.db.lock().unwrap();
        let (listen_endpoint, advertised): (Option<String>, String) = db.query_row(
            "SELECT listen_endpoint,advertised_endpoints_json FROM network_settings",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(PeerSettings {
            listen_endpoint,
            advertised_endpoints: serde_json::from_str(&advertised)?,
        })
    }
    /// Local orchestration only; these settings grant no remote authority.
    pub fn configure_peer(&self, settings: &PeerSettings) -> anyhow::Result<()> {
        if let Some(value) = &settings.listen_endpoint {
            endpoint(value)?;
        }
        ensure!(
            settings.advertised_endpoints.len() <= 8,
            "Too many advertised endpoints"
        );
        for value in &settings.advertised_endpoints {
            endpoint(value)?;
        }
        self.transaction(|tx| {
            tx.execute(
                "UPDATE network_settings SET listen_endpoint=?1,advertised_endpoints_json=?2",
                params![
                    settings.listen_endpoint,
                    serde_json::to_string(&settings.advertised_endpoints)?
                ],
            )?;
            Ok(())
        })
    }
    pub fn peer_contacts(&self, network: NetworkId) -> anyhow::Result<Vec<Contact>> {
        let db = self.db.lock().unwrap();
        let mut q = db.prepare("SELECT membership_id,endpoint,explicit_seed FROM network_contacts WHERE network_id=? ORDER BY membership_id,explicit_seed DESC,last_success_at DESC,endpoint")?;
        Ok(q.query_map([network.as_bytes().as_slice()], |r| {
            let bytes: Vec<u8> = r.get(0)?;
            Ok(Contact {
                membership_id: MembershipId::from_bytes(
                    bytes.try_into().expect("validated member ID"),
                ),
                endpoint: r.get(1)?,
                explicit_seed: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
    }
    pub(super) fn tls_keys(&self) -> anyhow::Result<Vec<(PublicKey, Zeroizing<Vec<u8>>)>> {
        let db = self.db.lock().unwrap();
        let mut q = db
            .prepare("SELECT key_id,public_key FROM network_keys WHERE storage_status='present'")?;
        let mut values = Vec::new();
        for row in q.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })? {
            let (id, bytes) = row?;
            let public = PublicKey::from_bytes(
                bytes
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("Invalid retained key"))?,
            );
            let key = KeyFiles::new(&self.state).load(&id, public)?;
            values.push((
                public,
                Zeroizing::new(key.to_pkcs8_der()?.as_bytes().to_vec()),
            ));
        }
        Ok(values)
    }
    pub(super) fn sign_address_hint(&self) -> anyhow::Result<Option<AddressHint>> {
        let Some(selected) = self.current_selection()? else {
            return Ok(None);
        };
        if selected.status() != SelectionStatus::Active {
            return Ok(None);
        }
        let settings = self.peer_settings()?;
        if settings.advertised_endpoints.is_empty() {
            return Ok(None);
        }
        let db = self.db.lock().unwrap();
        let id: String = db.query_row(
            "SELECT key_id FROM network_selections WHERE selection_id=?",
            [selected.selection_id().to_string()],
            |r| r.get(0),
        )?;
        let public = selected
            .history()
            .member(selected.local_member())
            .unwrap()
            .public_key;
        let mut nonce = [0u8; 32];
        getrandom::fill(&mut nonce)?;
        let body = AddressBody {
            protocol_version: 1,
            network_id: selected.history().network_id(),
            membership_id: selected.local_member(),
            endpoints: settings.advertised_endpoints,
            lease_seconds: 300,
            nonce: Nonce::from_bytes(nonce),
        };
        let mut bytes = b"dewbow.network.address.v1\0".to_vec();
        bytes.extend(serde_jcs::to_vec(&body)?);
        Ok(Some(AddressHint {
            signature: Signature::from_bytes(
                KeyFiles::new(&self.state)
                    .load(&id, public)?
                    .sign(&bytes)
                    .to_bytes(),
            ),
            body,
        }))
    }
    pub(super) fn retain_hint(&self, hint: &AddressHint) -> anyhow::Result<()> {
        self.transaction(|tx| {
            let selected = super::repository::current(tx, self.limits)?.ok_or_else(|| anyhow::anyhow!("No current Network"))?;
            let history = selected.history();
            ensure!(selected.status() == SelectionStatus::Active && hint.body.network_id == history.network_id() && history.is_active(hint.body.membership_id), "Inactive hint signer");
            hint.verify(history.member(hint.body.membership_id).unwrap().public_key)?;
            for value in &hint.body.endpoints {
                endpoint(value)?;
                let count: i64 = tx.query_row("SELECT count(*) FROM network_contacts WHERE network_id=?1 AND membership_id=?2", params![history.network_id().as_bytes().as_slice(), hint.body.membership_id.as_bytes().as_slice()], |r| r.get(0))?;
                if count >= 8 { tx.execute("DELETE FROM network_contacts WHERE rowid=(SELECT rowid FROM network_contacts WHERE network_id=?1 AND membership_id=?2 AND explicit_seed=0 ORDER BY last_success_at,endpoint LIMIT 1)", params![history.network_id().as_bytes().as_slice(), hint.body.membership_id.as_bytes().as_slice()])?; }
                let count: i64 = tx.query_row("SELECT count(*) FROM network_contacts WHERE network_id=?1 AND membership_id=?2", params![history.network_id().as_bytes().as_slice(), hint.body.membership_id.as_bytes().as_slice()], |r| r.get(0))?;
                if count < 8 { tx.execute("INSERT INTO network_contacts VALUES(?1,?2,?3,0,?4,NULL) ON CONFLICT(network_id,membership_id,endpoint) DO UPDATE SET signed_hint_json=excluded.signed_hint_json", params![history.network_id().as_bytes().as_slice(), hint.body.membership_id.as_bytes().as_slice(), value, serde_json::to_string(hint)?])?; }
            }
            Ok(())
        })
    }
    pub(super) fn contact_succeeded(
        &self,
        network: NetworkId,
        member: MembershipId,
        address: &str,
    ) -> anyhow::Result<()> {
        self.transaction(|tx| { tx.execute("UPDATE network_contacts SET last_success_at=? WHERE network_id=? AND membership_id=? AND endpoint=?", params![dewbow_protocol::now(), network.as_bytes().as_slice(), member.as_bytes().as_slice(), address])?; Ok(()) })
    }
}

pub(super) fn history_subset(
    history: &VerifiedHistory,
    roots: &[RecordId],
    limits: Limits,
) -> dewbow_protocol::network::Result<VerifiedHistory> {
    let mut seen = BTreeSet::new();
    let mut pending = roots.to_vec();
    let mut records = Vec::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let record = history.record(id).ok_or(dewbow_protocol::network::Error {
            kind: ErrorKind::ProofIncomplete,
            message: "Missing ancestor",
        })?;
        pending.extend_from_slice(record.body().parents());
        records.push(record.clone());
    }
    verify_history(history.network_id(), &records, limits)
}
