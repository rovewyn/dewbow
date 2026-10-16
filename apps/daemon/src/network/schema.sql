CREATE TABLE network_keys (
    key_id TEXT NOT NULL PRIMARY KEY,
    public_key BLOB NOT NULL UNIQUE CHECK(length(public_key)=32),
    format_version INTEGER NOT NULL CHECK(format_version=1),
    storage_status TEXT NOT NULL CHECK(storage_status IN ('present','deletePending','deleted')),
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE network_records (
    record_id BLOB NOT NULL PRIMARY KEY CHECK(length(record_id)=32),
    network_id BLOB NOT NULL CHECK(length(network_id)=32),
    kind TEXT NOT NULL CHECK(kind IN ('createNetwork','admitMember','removeMember','leaveNetwork')),
    envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json))
) STRICT;
CREATE INDEX network_records_by_network ON network_records(network_id,record_id);
CREATE TABLE network_selections (
    selection_id TEXT NOT NULL PRIMARY KEY,
    network_id BLOB NOT NULL REFERENCES network_records(record_id) CHECK(length(network_id)=32),
    local_membership_id BLOB NOT NULL REFERENCES network_records(record_id) CHECK(length(local_membership_id)=32),
    key_id TEXT NOT NULL REFERENCES network_keys(key_id),
    status TEXT NOT NULL CHECK(status IN ('active','left','removed')),
    frontier_json TEXT NOT NULL CHECK(json_valid(frontier_json)),
    history_id BLOB NOT NULL CHECK(length(history_id)=32),
    record_count INTEGER NOT NULL CHECK(record_count>0),
    created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX network_selections_one_active ON network_selections(status) WHERE status='active';
CREATE INDEX network_selections_by_network ON network_selections(network_id,status);
CREATE TABLE network_settings (
    singleton_id INTEGER NOT NULL PRIMARY KEY CHECK(singleton_id=1),
    current_selection_id TEXT REFERENCES network_selections(selection_id),
    listen_endpoint TEXT,
    advertised_endpoints_json TEXT NOT NULL CHECK(json_valid(advertised_endpoints_json))
) STRICT;
INSERT INTO network_settings VALUES(1,NULL,NULL,'[]');
CREATE TABLE network_requests (
    request_id TEXT NOT NULL PRIMARY KEY,
    operation TEXT NOT NULL CHECK(operation IN ('createNetwork','createInvitation','joinNetwork','confirmNetworkJoin','removeNetworkMember','leaveNetwork','setNetworkPeerAddress')),
    fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
    operation_id BLOB CHECK(operation_id IS NULL OR length(operation_id)=32),
    selection_id TEXT REFERENCES network_selections(selection_id),
    status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
    result_refs_json TEXT NOT NULL CHECK(json_valid(result_refs_json)),
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE network_invitations (
    issuer_membership_id BLOB NOT NULL CHECK(length(issuer_membership_id)=32),
    invitation_id BLOB NOT NULL CHECK(length(invitation_id)=32),
    public_invitation_json TEXT NOT NULL CHECK(json_valid(public_invitation_json)),
    secret BLOB CHECK(secret IS NULL OR length(secret)=32),
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('live','consumed','expired')),
    consumed_attempt_id BLOB CHECK(consumed_attempt_id IS NULL OR length(consumed_attempt_id)=32),
    created_at TEXT NOT NULL,
    PRIMARY KEY(issuer_membership_id,invitation_id),
    CHECK((status='live' AND secret IS NOT NULL AND consumed_attempt_id IS NULL) OR
          (status='consumed' AND secret IS NULL AND consumed_attempt_id IS NOT NULL) OR
          (status='expired' AND secret IS NULL AND consumed_attempt_id IS NULL))
) STRICT;
CREATE INDEX network_invitations_expiry ON network_invitations(status,expires_at);
CREATE TABLE network_join_attempts (
    role TEXT NOT NULL CHECK(role IN ('joiner','issuer')),
    issuer_membership_id BLOB NOT NULL CHECK(length(issuer_membership_id)=32),
    join_attempt_id BLOB NOT NULL CHECK(length(join_attempt_id)=32),
    invitation_id BLOB NOT NULL CHECK(length(invitation_id)=32),
    local_request_id TEXT REFERENCES network_requests(request_id),
    host_id TEXT NOT NULL,
    public_key BLOB NOT NULL CHECK(length(public_key)=32),
    key_id TEXT REFERENCES network_keys(key_id),
    invitation_json TEXT NOT NULL CHECK(json_valid(invitation_json)),
    credential_secret BLOB CHECK(credential_secret IS NULL OR length(credential_secret)=32),
    fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
    join_proof_json TEXT CHECK(join_proof_json IS NULL OR json_valid(join_proof_json)),
    status TEXT NOT NULL CHECK(status IN ('prepared','proofReady','uncertain','admitted','denied','expired')),
    result_record_id BLOB REFERENCES network_records(record_id),
    created_at TEXT NOT NULL,
    PRIMARY KEY(role,issuer_membership_id,join_attempt_id),
    CHECK((role='joiner' AND key_id IS NOT NULL AND local_request_id IS NOT NULL) OR
          (role='issuer' AND status IN ('admitted','denied') AND credential_secret IS NULL AND key_id IS NULL AND local_request_id IS NOT NULL AND join_proof_json IS NOT NULL)),
    CHECK((status='prepared' AND join_proof_json IS NULL) OR status<>'prepared'),
    CHECK(status NOT IN ('proofReady','uncertain','admitted') OR join_proof_json IS NOT NULL),
    CHECK((status='admitted' AND result_record_id IS NOT NULL) OR
          (status<>'admitted' AND result_record_id IS NULL)),
    CHECK(status NOT IN ('admitted','denied','expired') OR credential_secret IS NULL)
) STRICT;
CREATE INDEX network_join_attempts_by_invitation ON network_join_attempts(role,invitation_id,status);
CREATE TABLE network_departures (
    departure_record_id BLOB NOT NULL PRIMARY KEY REFERENCES network_records(record_id),
    network_id BLOB NOT NULL CHECK(length(network_id)=32),
    membership_id BLOB NOT NULL REFERENCES network_records(record_id),
    operation_id BLOB NOT NULL CHECK(length(operation_id)=32),
    key_id TEXT NOT NULL REFERENCES network_keys(key_id),
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE network_departure_tasks (
    departure_record_id BLOB NOT NULL REFERENCES network_departures(departure_record_id),
    recipient_membership_id BLOB NOT NULL REFERENCES network_records(record_id),
    recipient_host_id TEXT NOT NULL,
    recipient_public_key BLOB NOT NULL CHECK(length(recipient_public_key)=32),
    contact_candidates_json TEXT NOT NULL CHECK(json_valid(contact_candidates_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','abandoned')),
    retry_count INTEGER NOT NULL CHECK(retry_count>=0),
    next_attempt_at TEXT,
    acknowledgement_json TEXT CHECK(acknowledgement_json IS NULL OR json_valid(acknowledgement_json)),
    PRIMARY KEY(departure_record_id,recipient_membership_id),
    CHECK(status<>'confirmed' OR acknowledgement_json IS NOT NULL)
) STRICT;
CREATE INDEX network_departure_tasks_retry ON network_departure_tasks(status,next_attempt_at);
CREATE TABLE network_outbound_requests (
    network_id BLOB NOT NULL CHECK(length(network_id)=32),
    source_host_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    target_host_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
    dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('prepared','uncertain','settled')),
    result_ref_json TEXT CHECK(result_ref_json IS NULL OR json_valid(result_ref_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(network_id,source_host_id,request_id)
) STRICT;
CREATE INDEX network_outbound_requests_pending ON network_outbound_requests(dispatch_state);
CREATE TABLE network_request_receipts (
    network_id BLOB NOT NULL CHECK(length(network_id)=32),
    source_host_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    target_host_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
    command_id TEXT NOT NULL UNIQUE,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    recovery_refs_json TEXT CHECK(recovery_refs_json IS NULL OR json_valid(recovery_refs_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(network_id,source_host_id,request_id)
) STRICT;
CREATE TABLE network_contacts (
    network_id BLOB NOT NULL CHECK(length(network_id)=32),
    membership_id BLOB NOT NULL CHECK(length(membership_id)=32),
    endpoint TEXT NOT NULL,
    explicit_seed INTEGER NOT NULL CHECK(explicit_seed IN (0,1)),
    signed_hint_json TEXT CHECK(signed_hint_json IS NULL OR json_valid(signed_hint_json)),
    last_success_at TEXT,
    PRIMARY KEY(network_id,membership_id,endpoint)
) STRICT;
CREATE TABLE network_conflicts (
    witness_id TEXT NOT NULL PRIMARY KEY,
    network_id BLOB NOT NULL CHECK(length(network_id)=32),
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    byte_count INTEGER NOT NULL CHECK(byte_count>=0 AND byte_count<=16777216),
    created_at TEXT NOT NULL
) STRICT;
