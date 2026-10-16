use super::*;

impl Session {
    fn offer_proof(&mut self, history: VerifiedHistory) -> Result<Value> {
        let worker = match self.proof.take() {
            Some(proof) => proof._worker,
            None => self.shared.proof_permit(self.peer_key)?,
        };
        self.charge(
            2,
            history
                .records()
                .map(|r| r.encoded().len() + 512)
                .sum::<usize>()
                .saturating_mul(2),
        )?;
        let proof_token = token()?;
        let summary = history.snapshot().clone();
        self.proof = Some(Proof {
            verified_claim: None,
            token: proof_token.clone(),
            purpose: ProofPurpose::Admission,
            member: None,
            target: None,
            records: BTreeMap::new(),
            readable: Some(history),
            verified: true,
            started: Instant::now(),
            touched: Instant::now(),
            _worker: worker,
        });
        Ok(json!({"proofToken":proof_token,"history":summary}))
    }

    fn validate_invitation(
        &self,
        text: &str,
    ) -> Result<(crate::network::lifecycle::Invitation, VerifiedHistory)> {
        use rusqlite::OptionalExtension;
        let invitation = crate::network::lifecycle::Invitation::parse(text)
            .map_err(|_| PeerError::new("INVALID_INPUT"))?;
        let body = &invitation.body;
        let Some(Hello::Join {
            network_id,
            issuer_membership_id,
            invitation_id,
            ..
        }) = &self.hello
        else {
            return Err(PeerError::new("FORBIDDEN"));
        };
        if *network_id != body.network_id
            || *issuer_membership_id != body.issuer_membership_id
            || *invitation_id != body.invitation_id
            || self.local_key != body.issuer_public_key
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        let selected = self
            .repo
            .current_selection()
            .map_err(unavailable)?
            .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
        if selected.status() != SelectionStatus::Active
            || selected.local_member() != body.issuer_membership_id
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        let state:Option<(String,String)>=self.repo.db.lock().unwrap().query_row("SELECT public_invitation_json,status FROM network_invitations WHERE issuer_membership_id=? AND invitation_id=?",rusqlite::params![body.issuer_membership_id.as_bytes().as_slice(),body.invitation_id.as_bytes().as_slice()],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(unavailable)?;
        let Some((original, status)) = state else {
            return Err(PeerError::new("FORBIDDEN"));
        };
        if original != serde_jcs::to_string(&invitation.public()).map_err(unavailable)? {
            return Err(PeerError::new("FORBIDDEN"));
        }
        if status == "consumed" {
            return Err(PeerError::new("INVITATION_USED"));
        }
        let now = chrono::Utc::now();
        if status != "live"
            || now < crate::network::types::timestamp(&body.issued_at).map_err(unavailable)?
            || now >= crate::network::types::timestamp(&body.expires_at).map_err(unavailable)?
        {
            return Err(PeerError::new("INVITATION_EXPIRED"));
        }
        let history = history_subset(
            selected.history(),
            &body.invitation_frontier,
            self.repo.limits,
        )?;
        if history.snapshot().history_id != body.history_id {
            return Err(PeerError::new("INVALID_PROOF"));
        }
        Ok((invitation, history))
    }

    fn join_result(&mut self, proof: &JoinProof) -> Result<Option<Value>> {
        decode_join_proof(&serde_json::to_vec(proof).map_err(unavailable)?)?;
        if proof.body.public_key != self.peer_key
            || self.hello.as_ref().unwrap().binding().1 != proof.body.network_id
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        match self.hello.as_ref().unwrap() {
            Hello::Join {
                issuer_membership_id,
                invitation_id,
                join_attempt_id,
                ..
            } if *issuer_membership_id == proof.body.issuer_membership_id
                && *invitation_id == proof.body.invitation_id
                && *join_attempt_id == proof.body.join_attempt_id => {}
            Hello::JoinRecovery { join_proof, .. } if **join_proof == *proof => {}
            _ => return Err(PeerError::new("FORBIDDEN")),
        }
        match self
            .repo
            .issuer_join_result(proof)
            .map_err(|_| PeerError::new("REQUEST_CONFLICT"))?
        {
            Some(crate::network::IssuerJoinResult::Denied) => Ok(Some(json!({"status":"denied"}))),
            Some(crate::network::IssuerJoinResult::Admitted(record)) => {
                let history = self
                    .repo
                    .retained_history(proof.body.network_id, &[record.id()])
                    .map_err(unavailable)?;
                let opened = self.offer_proof(history)?;
                Ok(Some(
                    json!({"status":"admitted","record":serde_json::from_slice::<Value>(record.encoded()).map_err(unavailable)?,"history":opened["history"],"proofToken":opened["proofToken"]}),
                ))
            }
            None => Ok(None),
        }
    }

    pub(super) fn lifecycle(&mut self, operation: &str, input: Value) -> Result<Value> {
        match operation {
            "getInvitationProof" => {
                let request: InvitationRequest = parse(input)?;
                let (_, history) = self.validate_invitation(&request.invitation)?;
                self.offer_proof(history)
            }
            "redeemInvitation" => {
                let request: RedeemInvitation = parse(input)?;
                if let Some(result) = self.join_result(&request.join_proof)? {
                    return Ok(result);
                }
                // The proof token must have been issued on this pinned connection.
                let (invitation, history) = self.validate_invitation(&request.invitation)?;
                if !self.proof.as_ref().is_some_and(|p| {
                    p.readable
                        .as_ref()
                        .is_some_and(|h| h.snapshot() == history.snapshot())
                }) {
                    return Err(PeerError::new("FORBIDDEN"));
                }
                let proof = request.join_proof;
                if proof.body.invitation_history_id != history.snapshot().history_id
                    || proof.body.invitation_frontier != history.snapshot().frontier
                {
                    return Err(PeerError::new("INVALID_PROOF"));
                }
                // Engine validation checks the prospective admission before prompting.
                let selected = self
                    .repo
                    .current_selection()
                    .map_err(unavailable)?
                    .ok_or_else(|| PeerError::new("FORBIDDEN"))?;
                prepare_change(
                    selected.history(),
                    selected.local_member(),
                    crate::network::lifecycle::nonce().map_err(unavailable)?,
                    Change::Admit(Box::new(proof.clone())),
                    self.repo.limits,
                )?;
                let mut pending = self.repo.pending.lock().unwrap();
                pending.retain(|_, p| p.expires > chrono::Utc::now());
                if let Some(old) = pending.get(&proof.body.join_attempt_id) {
                    if old.proof != proof {
                        return Err(PeerError::new("REQUEST_CONFLICT"));
                    }
                } else {
                    if pending.len() >= 128 {
                        return Err(PeerError::new("RESOURCE_LIMIT"));
                    }
                    pending.insert(
                        proof.body.join_attempt_id,
                        crate::network::lifecycle::Pending {
                            proof,
                            expires: crate::network::types::timestamp(&invitation.body.expires_at)
                                .map_err(unavailable)?,
                        },
                    );
                }
                Ok(json!({"status":"awaitingConfirmation"}))
            }
            "getJoinResult" => {
                let r: GetJoinResult = parse(input)?;
                if let Some(result) = self.join_result(&r.join_proof)? {
                    return Ok(result);
                }
                if matches!(self.hello, Some(Hello::JoinRecovery { .. })) {
                    return Err(PeerError::new("UNAVAILABLE"));
                }
                Ok(json!({"status":"awaitingConfirmation"}))
            }
            "deliverDeparture" => {
                let r: DeliverDeparture = parse(input)?;
                let record = decode_record(&serde_json::to_vec(&r.record).map_err(unavailable)?)?;
                let selected = self.departure_context()?;
                let Some(Hello::Proof {
                    membership_id: Some(member),
                    ..
                }) = self.hello
                else {
                    return Err(PeerError::new("FORBIDDEN"));
                };
                if !matches!(record.body(),RecordBody::LeaveNetwork{author_membership_id,..} if *author_membership_id==member)
                {
                    return Err(PeerError::new("FORBIDDEN"));
                }
                let proof = self
                    .proof
                    .as_ref()
                    .filter(|p| p.purpose == ProofPurpose::Departure && p.verified)
                    .and_then(|p| p.verified_claim.as_ref())
                    .ok_or_else(|| PeerError::new("PROOF_INCOMPLETE"))?;
                let mut ancestry = proof.records().cloned().collect::<Vec<_>>();
                ancestry.extend(selected.history().records().cloned());
                if selected.status() == SelectionStatus::Active {
                    match consider(selected.history(), &record, &ancestry, self.repo.limits)? {
                        Decision::Proposed(p) => self
                            .repo
                            .commit_adoption(&selected.selection_id().to_string(), &p)
                            .map_err(unavailable)?,
                        Decision::Duplicate(_) => {}
                        Decision::HistoryConflict(_) => {
                            return Err(PeerError::new("HISTORY_CONFLICT"));
                        }
                    }
                }
                self.departure_ack(r.departure_record_id, member)
            }
            "getDepartureStatus" => {
                let r: GetDepartureStatus = parse(input)?;
                self.departure_ack(r.departure_record_id, r.membership_id)
            }
            _ => Err(PeerError::new("PROTOCOL_UNSUPPORTED")),
        }
    }

    fn departure_context(&self) -> Result<LocalSelection> {
        let Some(Hello::Proof {
            membership_id: Some(member),
            purpose: ProofPurpose::Departure,
            ..
        }) = self.hello
        else {
            return Err(PeerError::new("FORBIDDEN"));
        };
        let selected = self.selection()?;
        if !selected
            .history()
            .member(member)
            .is_some_and(|m| m.public_key == self.peer_key)
            && !self
                .proof
                .as_ref()
                .and_then(|p| p.verified_claim.as_ref())
                .and_then(|h| h.member(member))
                .is_some_and(|m| m.public_key == self.peer_key)
        {
            return Err(PeerError::new("FORBIDDEN"));
        }
        Ok(selected)
    }
    fn departure_ack(&mut self, original: RecordId, member: MembershipId) -> Result<Value> {
        let selected = self.departure_context()?;
        if self.hello.as_ref().unwrap().binding().2 != Some(member) {
            return Err(PeerError::new("FORBIDDEN"));
        }
        if selected.status() == SelectionStatus::Active && selected.history().is_active(member) {
            return Ok(json!({"status":"proofRequired"}));
        }
        let ack = self
            .repo
            .sign_absence_ack(&selected, original, member)
            .map_err(unavailable)?;
        // Refresh the permitted proof view to the actual acknowledged context.
        let opened = self.offer_proof(selected.history().clone())?;
        Ok(
            json!({"acknowledgement":ack,"proofToken":opened["proofToken"],"history":opened["history"]}),
        )
    }
}
