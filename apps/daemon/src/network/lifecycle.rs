//! Local operator orchestration. Peer callers cannot invoke these operations.
use super::{repository::*, types::*, *};
use anyhow::ensure;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use dewbow_protocol::network::*;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub(crate) struct Pending {
    pub proof: JoinProof,
    pub expires: chrono::DateTime<chrono::Utc>,
}
#[derive(Default)]
pub(crate) struct Observation {
    pub seen: Option<std::time::Instant>,
    pub acknowledged: Option<HistoryId>,
}
#[derive(Clone)]
pub(crate) struct DepartureTask {
    pub record: RecordId,
    pub network: NetworkId,
    pub member: MembershipId,
    pub recipient: MembershipId,
    pub public: PublicKey,
    pub endpoints: Vec<String>,
    pub retries: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Invitation {
    pub body: InvitationBody,
    pub signature: Signature,
    pub secret: Nonce,
}
impl Invitation {
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        ensure!(text.len() <= 32768, "INVALID_INPUT: invitation too large");
        let encoded = text
            .strip_prefix("dewbow-network-v1.")
            .ok_or_else(|| anyhow::anyhow!("INVALID_INPUT: invalid invitation"))?;
        let bytes = URL_SAFE_NO_PAD.decode(encoded)?;
        let value: Self = dewbow_protocol::network::peer::decode(&bytes)?;
        ensure!(
            URL_SAFE_NO_PAD.encode(serde_jcs::to_vec(&value)?) == encoded,
            "INVALID_INPUT: noncanonical invitation"
        );
        value.public().validate()?;
        ensure!(
            *value.body.credential_hash.as_bytes()
                == <[u8; 32]>::from(Sha256::digest(value.secret.as_bytes())),
            "INVALID_INPUT: invalid invitation credential"
        );
        Ok(value)
    }
    pub fn public(&self) -> PublicInvitation {
        PublicInvitation {
            body: self.body.clone(),
            signature: self.signature,
        }
    }
    pub fn encoded(&self) -> anyhow::Result<String> {
        Ok(format!(
            "dewbow-network-v1.{}",
            URL_SAFE_NO_PAD.encode(serde_jcs::to_vec(self)?)
        ))
    }
}

pub(crate) fn nonce() -> anyhow::Result<Nonce> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes)?;
    Ok(Nonce::from_bytes(bytes))
}

pub(crate) fn intent(operation: &str, input: &Value) -> anyhow::Result<Intent> {
    let request = input["requestId"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 256)
        .ok_or_else(|| anyhow::anyhow!("INVALID_INPUT: requestId required"))?;
    Ok(Intent {
        request_id: request.into(),
        operation: operation.into(),
        fingerprint: Sha256::digest(serde_jcs::to_vec(
            &json!({"operation":operation,"input":input}),
        )?)
        .into(),
        operation_id: Some(nonce()?),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    network_name: String,
    request_id: String,
    listen_endpoint: Option<String>,
    #[serde(default)]
    advertised_endpoints: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestInput {
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemberInput {
    membership_id: MembershipId,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmInput {
    join_attempt_id: Nonce,
    public_key: PublicKey,
    decision: String,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddressInput {
    membership_id: MembershipId,
    endpoint: String,
    request_id: String,
}

fn parse<T: serde::de::DeserializeOwned>(input: &Value) -> anyhow::Result<T> {
    serde_json::from_value(input.clone())
        .map_err(|_| anyhow::anyhow!("INVALID_INPUT: invalid Network input"))
}

impl Repository {
    pub(crate) fn sign_absence_ack(
        &self,
        selected: &LocalSelection,
        original: RecordId,
        member: MembershipId,
    ) -> anyhow::Result<DepartureAck> {
        self.transaction(|tx| {
            let actual = super::validation::selection(
                tx,
                &selected.selection_id().to_string(),
                self.limits,
            )?;
            ensure!(
                actual.history().snapshot() == selected.history().snapshot(),
                "SYNC_REQUIRED"
            );
            ensure!(
                actual.status() != SelectionStatus::Active || !actual.history().is_active(member),
                "FORBIDDEN"
            );
            let key: String = tx.query_row(
                "SELECT key_id FROM network_selections WHERE selection_id=?",
                [actual.selection_id().to_string()],
                |r| r.get(0),
            )?;
            let public = actual
                .history()
                .member(actual.local_member())
                .unwrap()
                .public_key;
            super::keys::KeyFiles::new(&self.state).sign_ack(
                &key,
                public,
                DepartureAckBody {
                    protocol_version: 1,
                    network_id: actual.history().network_id(),
                    departure_record_id: original,
                    membership_id: member,
                    recipient_membership_id: actual.local_member(),
                    history_id: actual.history().snapshot().history_id,
                    status: if actual.status() == SelectionStatus::Active {
                        "absent"
                    } else {
                        "recipientInactive"
                    }
                    .into(),
                },
            )
        })
    }
    pub(crate) fn pending_attempts(&self) -> anyhow::Result<Vec<AttemptId>> {
        let db = self.db.lock().unwrap();
        let mut q=db.prepare("SELECT issuer_membership_id,join_attempt_id FROM network_join_attempts WHERE role='joiner' AND status IN ('prepared','proofReady','uncertain')")?;
        Ok(q.query_map([], |r| {
            Ok(AttemptId {
                issuer: MembershipId::from_bytes(r.get::<_, Vec<u8>>(0)?.try_into().unwrap()),
                attempt: Nonce::from_bytes(r.get::<_, Vec<u8>>(1)?.try_into().unwrap()),
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
    }
    pub(crate) fn join_material(
        &self,
        id: AttemptId,
    ) -> anyhow::Result<(super::repository::JoinRow, Option<Nonce>)> {
        let db = self.db.lock().unwrap();
        let row = join_row(&db, id)?;
        let secret:Option<Vec<u8>>=db.query_row("SELECT credential_secret FROM network_join_attempts WHERE role='joiner' AND issuer_membership_id=? AND join_attempt_id=?",params![id.issuer.as_bytes().as_slice(),id.attempt.as_bytes().as_slice()],|r|r.get(0))?;
        Ok((
            row,
            secret.map(|s| Nonce::from_bytes(s.try_into().unwrap())),
        ))
    }
    pub fn start_network_join(&self, input: &Value) -> anyhow::Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Input {
            invitation: String,
            request_id: String,
            listen_endpoint: Option<String>,
            #[serde(default)]
            advertised_endpoints: Vec<String>,
        }
        let parsed: Input = parse(input)?;
        let _ = (
            &parsed.request_id,
            &parsed.listen_endpoint,
            &parsed.advertised_endpoints,
        );
        let invitation = Invitation::parse(&parsed.invitation)?;
        let intent = intent("joinNetwork", input)?;
        let id = self.prepare_join_attempt(
            &intent,
            &invitation.public(),
            *invitation.secret.as_bytes(),
            nonce()?,
        )?;
        let (row, _) = self.join_material(id)?;
        Ok(
            json!({"joinAttemptId":id.attempt,"issuerMembershipId":id.issuer,"status":row.status,"publicKey":row.public,"hostId":row.host,"publicKeyFingerprint":format!("sha256:{}",URL_SAFE_NO_PAD.encode(Sha256::digest(row.public.as_bytes()))),"network":self.network_status()?}),
        )
    }
    pub(crate) fn departure_tasks(&self) -> anyhow::Result<Vec<DepartureTask>> {
        let db = self.db.lock().unwrap();
        let mut q=db.prepare("SELECT d.departure_record_id,d.network_id,d.membership_id,t.recipient_membership_id,t.recipient_public_key,t.contact_candidates_json,t.retry_count FROM network_departures d JOIN network_departure_tasks t USING(departure_record_id) WHERE t.status='pending' AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=?1) ORDER BY coalesce(t.next_attempt_at,''),d.created_at LIMIT 32")?;
        Ok(q.query_map([dewbow_protocol::now()], |r| {
            Ok(DepartureTask {
                record: RecordId::from_bytes(r.get::<_, Vec<u8>>(0)?.try_into().unwrap()),
                network: NetworkId::from_bytes(r.get::<_, Vec<u8>>(1)?.try_into().unwrap()),
                member: MembershipId::from_bytes(r.get::<_, Vec<u8>>(2)?.try_into().unwrap()),
                recipient: MembershipId::from_bytes(r.get::<_, Vec<u8>>(3)?.try_into().unwrap()),
                public: PublicKey::from_bytes(r.get::<_, Vec<u8>>(4)?.try_into().unwrap()),
                endpoints: serde_json::from_str(&r.get::<_, String>(5)?).unwrap(),
                retries: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
    }
    pub(crate) fn retry_departure(&self, t: &DepartureTask) -> anyhow::Result<()> {
        self.transaction(|tx|{let delay=2_i64.pow(t.retries.min(8)+1);let next=(chrono::Utc::now()+chrono::Duration::seconds(delay)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true);tx.execute("UPDATE network_departure_tasks SET retry_count=retry_count+1,next_attempt_at=? WHERE departure_record_id=? AND recipient_membership_id=? AND status='pending'",params![next,t.record.as_bytes().as_slice(),t.recipient.as_bytes().as_slice()])?;Ok(())})
    }
    pub(crate) fn retained_history(
        &self,
        network: NetworkId,
        frontier: &[RecordId],
    ) -> anyhow::Result<VerifiedHistory> {
        let db = self.db.lock().unwrap();
        let mut pending = frontier.to_vec();
        let mut records = std::collections::BTreeMap::new();
        let mut weight = 0;
        while let Some(id) = pending.pop() {
            if records.contains_key(&id) {
                continue;
            }
            let encoded: String = db.query_row(
                "SELECT envelope_json FROM network_records WHERE record_id=? AND network_id=?",
                params![id.as_bytes().as_slice(), network.as_bytes().as_slice()],
                |r| r.get(0),
            )?;
            weight += encoded.len() + 512;
            ensure!(weight <= self.limits.working_bytes, "RESOURCE_LIMIT");
            let record = decode_record(encoded.as_bytes())?;
            pending.extend_from_slice(record.body().parents());
            records.insert(id, record);
        }
        Ok(verify_history(
            network,
            &records.into_values().collect::<Vec<_>>(),
            self.limits,
        )?)
    }
    pub fn network_status(&self) -> anyhow::Result<Value> {
        let selected = self.current_selection()?;
        let db = self.db.lock().unwrap();
        let joining: Option<(String,Vec<u8>,String,Vec<u8>)> = db.query_row("SELECT local_request_id,join_attempt_id,status,public_key FROM network_join_attempts WHERE role='joiner' AND status IN ('prepared','proofReady','uncertain')", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let pending = joining.is_some();
        let mut result = json!({"networkId":null,"membershipId":null,"historyId":null,"networkName":null,
            "localStatus":if pending {"joining"} else {"none"},"dissemination":[],"joinRequestId":joining.as_ref().map(|r|&r.0),"joinAttemptId":joining.as_ref().map(|r|Nonce::from_bytes(r.1.clone().try_into().unwrap())),"joinStatus":joining.as_ref().map(|r|&r.2),"joiningHostId":if pending {self.host}else{None},"joiningPublicKey":joining.as_ref().map(|r|PublicKey::from_bytes(r.3.clone().try_into().unwrap()))});
        if let Some(s) = selected.as_ref() {
            result["networkId"] = json!(s.history().network_id());
            result["membershipId"] = json!(s.local_member());
            result["historyId"] = json!(s.history().snapshot().history_id);
            if let RecordBody::CreateNetwork { network_name, .. } = s
                .history()
                .record(s.history().network_id().into())
                .unwrap()
                .body()
            {
                result["networkName"] = json!(network_name);
            }
            if !pending {
                result["localStatus"] = json!(match s.status() {
                    SelectionStatus::Active => "active",
                    SelectionStatus::Left => "left",
                    SelectionStatus::Removed => "removed",
                });
            }
        }
        let mut q = db.prepare("SELECT t.departure_record_id,t.recipient_membership_id,t.status,d.network_id FROM network_departure_tasks t JOIN network_departures d USING(departure_record_id) ORDER BY t.departure_record_id,t.recipient_membership_id")?;
        result["dissemination"] = json!(q.query_map([], |r| Ok(json!({"kind":"departure","networkId":NetworkId::from_bytes(r.get::<_,Vec<u8>>(3)?.try_into().unwrap()),"departureRecordId":RecordId::from_bytes(r.get::<_,Vec<u8>>(0)?.try_into().unwrap()),"membershipId":MembershipId::from_bytes(r.get::<_,Vec<u8>>(1)?.try_into().unwrap()),"status":r.get::<_,String>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?);
        if let Some(s) = selected
            .as_ref()
            .filter(|s| s.status() == SelectionStatus::Active)
        {
            let observed = self.observations.lock().unwrap();
            for m in s
                .history()
                .active_members()
                .filter(|m| m.membership_id != s.local_member())
            {
                let acknowledged = observed
                    .get(&(s.history().network_id(), m.membership_id))
                    .and_then(|o| o.acknowledged);
                result["dissemination"].as_array_mut().unwrap().push(json!({"kind":"membership","networkId":s.history().network_id(),"membershipId":m.membership_id,"historyId":s.history().snapshot().history_id,"status":if acknowledged==Some(s.history().snapshot().history_id){"confirmed"}else{"pending"}}));
            }
        }
        Ok(result)
    }

    pub fn network_members(&self) -> anyhow::Result<Value> {
        let Some(s) = self.current_selection()? else {
            return Ok(json!({"members":[]}));
        };
        let contacts = self.peer_contacts(s.history().network_id())?;
        let observed = self.observations.lock().unwrap();
        Ok(
            json!({"members":s.history().active_members().map(|m|json!({"hostId":m.host_id,"membershipId":m.membership_id,"publicKey":m.public_key,"isSelf":m.membership_id==s.local_member(),"reachability":if m.membership_id==s.local_member(){"local"}else if observed.get(&(s.history().network_id(),m.membership_id)).and_then(|o|o.seen).is_some_and(|t|t.elapsed()<std::time::Duration::from_secs(60)){"reachable"}else{"unknown"},"endpoints":contacts.iter().filter(|c|c.membership_id==m.membership_id).map(|c|c.endpoint.clone()).collect::<Vec<_>>()})).collect::<Vec<_>>()}),
        )
    }

    /// Validate explicit settings before any membership operation or listener restart.
    pub fn lifecycle_settings(&self, input: &Value) -> anyhow::Result<PeerSettings> {
        let mut settings = self.peer_settings()?;
        if let Some(value) = input.get("listenEndpoint").and_then(Value::as_str) {
            settings.listen_endpoint = Some(value.into());
        }
        if let Some(values) = input
            .get("advertisedEndpoints")
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty())
        {
            settings.advertised_endpoints = values
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| anyhow::anyhow!("INVALID_INPUT"))
                })
                .collect::<anyhow::Result<_>>()?;
        }
        ensure!(
            settings.listen_endpoint.is_some()
                && !settings.advertised_endpoints.is_empty()
                && settings.advertised_endpoints.len() <= 8,
            "INVALID_INPUT: explicit listenEndpoint and advertisedEndpoints required on first use"
        );
        for e in settings
            .listen_endpoint
            .iter()
            .chain(&settings.advertised_endpoints)
        {
            endpoint(e)?;
        }
        ensure!(
            settings.listen_endpoint.as_ref().is_some_and(|e| e
                .parse::<axum::http::Uri>()
                .is_ok_and(|u| u.port_u16() != Some(0)))
                && settings.advertised_endpoints.iter().all(|e| e
                    .parse::<axum::http::Uri>()
                    .is_ok_and(|u| u.port_u16() != Some(0))),
            "INVALID_INPUT: CLI endpoints require explicit nonzero ports"
        );
        Ok(settings)
    }

    pub fn local_network_operation(&self, operation: &str, input: &Value) -> anyhow::Result<Value> {
        match operation {
            "getNetwork" | "listNetworkMembers" | "listNetworkJoins" => {
                ensure!(
                    input.as_object().is_some_and(|v| v.is_empty()),
                    "INVALID_INPUT: expected empty input"
                );
                return match operation {
                    "getNetwork" => self.network_status(),
                    "listNetworkMembers" => self.network_members(),
                    _ => self.pending_joins(),
                };
            }
            _ => {}
        }
        let intent = intent(operation, input)?;
        match operation {
            "createNetwork" => {
                let parsed: CreateInput = parse(input)?;
                let _ = (
                    &parsed.request_id,
                    &parsed.listen_endpoint,
                    &parsed.advertised_endpoints,
                );
                let result = self.create_network(&intent, parsed.network_name, nonce()?)?;
                Ok(json!({"operation":result,"network":self.network_status()?}))
            }
            "createInvitation" => {
                let parsed: RequestInput = parse(input)?;
                let _ = parsed.request_id;
                let result =
                    self.create_invitation(&intent, self.peer_settings()?.advertised_endpoints)?;
                let text = result
                    .secret
                    .as_ref()
                    .map(|s| {
                        Invitation {
                            body: result.invitation.body.clone(),
                            signature: result.invitation.signature,
                            secret: Nonce::from_bytes(**s),
                        }
                        .encoded()
                    })
                    .transpose()?;
                Ok(
                    json!({"invitationId":result.invitation.body.invitation_id,"invitation":text,"expiresAt":result.invitation.body.expires_at,"status":result.status}),
                )
            }
            "confirmNetworkJoin" => {
                let parsed: ConfirmInput = parse(input)?;
                let _ = parsed.request_id;
                ensure!(
                    matches!(parsed.decision.as_str(), "allow" | "deny"),
                    "INVALID_INPUT: invalid decision"
                );
                if let Some(result) = self.request_result(&intent)? {
                    return Ok(result);
                }
                let pending = self
                    .pending
                    .lock()
                    .unwrap()
                    .get(&parsed.join_attempt_id)
                    .cloned()
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "INVALID_INPUT: pending join unavailable; resubmit the original join"
                        )
                    })?;
                ensure!(
                    pending.proof.body.public_key == parsed.public_key,
                    "INVALID_INPUT: pending key changed"
                );
                if parsed.decision == "deny" {
                    self.record_join_denial(&intent, &pending.proof)?;
                } else {
                    // A stale proposal is retried with the complete latest context.
                    let mut committed = false;
                    for _ in 0..3 {
                        let s = self
                            .current_selection()?
                            .ok_or_else(|| anyhow::anyhow!("FORBIDDEN"))?;
                        let record = self.sign_active_change(
                            &s.selection_id().to_string(),
                            intent.operation_id.unwrap(),
                            Change::Admit(Box::new(pending.proof.clone())),
                        )?;
                        if let Decision::Proposed(proposal) =
                            consider(s.history(), &record, &[], self.limits)?
                        {
                            match self.commit_confirmed_admission(
                                &intent,
                                &pending.proof,
                                &proposal,
                                record.id(),
                            ) {
                                Ok(_) => {
                                    committed = true;
                                    break;
                                }
                                Err(e) => {
                                    if self.current_selection()?.is_some_and(|n| {
                                        n.history().snapshot() != s.history().snapshot()
                                    }) {
                                        continue;
                                    }
                                    return Err(e);
                                }
                            }
                        }
                    }
                    ensure!(committed, "SYNC_REQUIRED: admission context changed");
                }
                self.pending.lock().unwrap().remove(&parsed.join_attempt_id);
                Ok(self.request_result(&intent)?.unwrap())
            }
            "removeNetworkMember" | "leaveNetwork" => {
                let target = if operation == "removeNetworkMember" {
                    let p: MemberInput = parse(input)?;
                    let _ = p.request_id;
                    Some(p.membership_id)
                } else {
                    let p: RequestInput = parse(input)?;
                    let _ = p.request_id;
                    None
                };
                if let Some(result) = self.request_result(&intent)? {
                    return Ok(json!({"operation":result,"network":self.network_status()?}));
                }
                for _ in 0..3 {
                    let s = self
                        .current_selection()?
                        .ok_or_else(|| anyhow::anyhow!("FORBIDDEN: no selected Network"))?;
                    let member = target.unwrap_or(s.local_member());
                    if member == s.local_member() && s.status() != SelectionStatus::Active {
                        let result = self.detach_inactive(&intent)?;
                        return Ok(json!({"operation":result,"network":self.network_status()?}));
                    }
                    let change = if member == s.local_member() {
                        Change::Leave
                    } else {
                        Change::Remove(member)
                    };
                    let record = self.sign_active_change(
                        &s.selection_id().to_string(),
                        intent.operation_id.unwrap(),
                        change,
                    )?;
                    let decision = consider(s.history(), &record, &[], self.limits)?;
                    if let Decision::Proposed(proposal) = decision {
                        match self.commit_local_change(&intent, &proposal, record.id()) {
                            Ok(result) => {
                                return Ok(
                                    json!({"operation":result,"network":self.network_status()?}),
                                );
                            }
                            Err(e) => {
                                if self.current_selection()?.is_some_and(|n| {
                                    n.history().snapshot() != s.history().snapshot()
                                }) {
                                    continue;
                                }
                                return Err(e);
                            }
                        }
                    } else {
                        ensure!(
                            matches!(decision, Decision::Duplicate(_)),
                            "HISTORY_CONFLICT: local withdrawal cannot be adopted"
                        );
                        // An already effective withdrawal has an existing immutable result.
                        let result = json!({"recordId":record.id()});
                        self.transaction(|tx| {
                            insert_intent(tx, &intent)?;
                            finish_intent(tx, &intent.request_id, "succeeded", &result)
                        })?;
                        return Ok(json!({"operation":result,"network":self.network_status()?}));
                    }
                }
                anyhow::bail!("SYNC_REQUIRED: removal context changed")
            }
            "setNetworkPeerAddress" => {
                let p: AddressInput = parse(input)?;
                let _ = p.request_id;
                if let Some(v) = self.request_result(&intent)? {
                    return Ok(v);
                }
                endpoint(&p.endpoint)?;
                self.transaction(|tx|{
                    let s=current(tx,self.limits)?.ok_or_else(||anyhow::anyhow!("FORBIDDEN"))?;
                    ensure!(s.status()==SelectionStatus::Active && s.history().is_active(p.membership_id),"FORBIDDEN: inactive member");
                    tx.execute("INSERT INTO network_contacts VALUES(?1,?2,?3,1,NULL,NULL) ON CONFLICT(network_id,membership_id,endpoint) DO UPDATE SET explicit_seed=1",params![s.history().network_id().as_bytes().as_slice(),p.membership_id.as_bytes().as_slice(),p.endpoint])?;
                    tx.execute("DELETE FROM network_contacts WHERE rowid IN (SELECT rowid FROM network_contacts WHERE network_id=?1 AND membership_id=?2 ORDER BY (endpoint=?3) DESC,explicit_seed DESC,last_success_at DESC,endpoint LIMIT -1 OFFSET 8)",params![s.history().network_id().as_bytes().as_slice(),p.membership_id.as_bytes().as_slice(),p.endpoint])?;
                    insert_intent(tx,&intent)?;let result=json!({"code":"ADDRESS_UPDATED"});finish_intent(tx,&intent.request_id,"succeeded",&result)?;Ok(result)
                })
            }
            _ => anyhow::bail!("INVALID_INPUT: unknown Network operation"),
        }
    }

    pub(crate) fn join_details(&self, input: &Value) -> anyhow::Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Input {
            join_attempt_id: Nonce,
        }
        let id = parse::<Input>(input)?.join_attempt_id;
        if let Some(p) = self
            .pending
            .lock()
            .unwrap()
            .get(&id)
            .filter(|p| p.expires > chrono::Utc::now())
        {
            return Ok(json!({"publicKey":p.proof.body.public_key}));
        }
        let db = self.db.lock().unwrap();
        let public:Vec<u8>=db.query_row("SELECT public_key FROM network_join_attempts WHERE role='issuer' AND join_attempt_id=?",[id.as_bytes().as_slice()],|r|r.get(0))?;
        Ok(json!({"publicKey":PublicKey::from_bytes(public.try_into().unwrap())}))
    }
    pub(crate) fn expire_invitations(&self) -> anyhow::Result<()> {
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let count: i64 = self.db.lock().unwrap().query_row(
            "SELECT count(*) FROM network_invitations WHERE status='live' AND expires_at<=?",
            [&now],
            |r| r.get(0),
        )?;
        if count > 0 {
            self.transaction(|tx|{tx.execute("UPDATE network_invitations SET status='expired',secret=NULL WHERE status='live' AND expires_at<=?",[now])?;Ok(())})?;
        }
        Ok(())
    }
    pub(crate) fn pending_joins(&self) -> anyhow::Result<Value> {
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.expires > chrono::Utc::now());
        Ok(
            json!({"joins":pending.values().map(|p|json!({"joinAttemptId":p.proof.body.join_attempt_id,"hostId":p.proof.body.host_id,"publicKey":p.proof.body.public_key,"publicKeyFingerprint":format!("sha256:{}",URL_SAFE_NO_PAD.encode(Sha256::digest(p.proof.body.public_key.as_bytes())))})).collect::<Vec<_>>()}),
        )
    }
}
