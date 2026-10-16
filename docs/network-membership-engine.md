# Network membership engine

The Rust `dewbow_protocol::network` module implements the record, history and local-selection rules of [Network protocol v1](network-protocol.md). It computes candidate transitions independently of storage, clocks, private key files, connections and native Codex. The caller owns committed state. A successful calculation is not a durable adoption or a remote permission grant.

The implementation favors reviewable rules and simple ordered indexes. It retains the complete accepted membership history without compaction. It does not implement enrollment commands, daemon networking, database writes, key protection, operator confirmation, receipt recovery or departure delivery. Those integrations must use this validator rather than introduce another membership authority. The module contains management records only, never conversation content.

## Trust and input boundaries

Use `decode_record` and `decode_join_proof` on raw untrusted bytes before constructing ordinary JSON values. The strict decoder rejects duplicate properties at every depth, unknown fields, invalid Unicode, floats, unsafe integers, noncanonical IDs and malformed schemas. A record envelope is bounded to 256 KiB and JSON containers to 16 levels. Unsupported versions and operations fail explicitly. A joining proof is also bounded before allocation; an admission still must fit its complete record envelope.

Hash and signature inputs use the protocol's fixed domain separators and JCS canonical bytes. The engine uses SHA-256, `serde_jcs` and pure Ed25519 through `ed25519-dalek`, strict verification, canonical point round trips and weak-key rejection. Preserve strings without Unicode normalization. ID comparisons use decoded bytes. Rust ID types distinguish Network, record, membership, history and intent/attempt values; protocol strings serialize as canonical unpadded base64url, while host identity retains its canonical UUID form.

`SignedRecord` is parsed input, not established membership. Its fields cannot be mutated through the public interface. `VerifiedHistory` can only be constructed by complete independent verification or a compatible proposal. It verifies retained ancestry without an online founder, issuer, invitation secret or current wall clock. Neither parsing nor possession of an independently verified foreign history selects that history locally. Do not deserialize standalone peer data directly into the public construction types and bypass the raw decoder.

## Validation and compatible adoption

Each record's author is resolved by its exact admitted generation and key in its own complete causal past. Ordinary operations require an active author; removals require an active target in that same context. Joining proofs bind Network, issuer, host/key, invitation/attempt identities and the reconstructed invitation issuance frontier/history commitment. That complete issuance context must be contained in admission ancestry, with its issuer active. Historical admissions are not retroactively expired using a receiver's clock.

After independent validation, `consider` checks the entire union with current accepted history. Conflict indexes cover author withdrawal against ordinary operations, competing host/key admissions, invitation reuse, join-attempt equivocation and operation equivocation. Ancestors participate even when a supplied tip's author remains active. Membership is the admitted-generation set minus exact-generation withdrawals; it is not produced by reauthorizing an arbitrary replay order.

The first verified conflict is returned in protocol category order, then ascending decoded record-pair order. `ConflictEvidence` includes the category, Network/history commitments, conflicting IDs and necessary foreign ancestry; locally accepted records are referenced rather than copied. The caller maintains the bounded conflict collection and never treats it as accepted history. An invalid history containing its own incompatible context is invalid input, not evidence that the current selection must fork or exit.

Process complete candidates serially. `ready_candidates` orders a single transient batch by decoded record ID when its complete ancestry is available in that batch or current history; it does not validate or reserve those candidates. Recheck each candidate against the latest committed result. Incomplete candidates are discarded without an orphan queue or seen-ID marker. Another reconciliation can discover and submit them later. Later conflicting alternatives never undo an accepted record; there is no automatic global winner or manual branch chooser.

For compatible accepted sets, membership, frontier and `historyId` agree regardless of delivery order. Incompatible first-accepted histories may differ between nodes. `historyId` changes after compatible additions and is not an immutable branch number or business-receipt namespace.

## Caller commit contract

`consider(current, candidate, proof, limits)` returns a duplicate ID, a `Proposal`, verified conflict evidence, or a typed error. A proposal contains its base snapshot, new records and an immutable resulting history. Unrelated supplied proof records are not imported. Already accepted IDs deduplicate using retained records; a duplicate acknowledgement refers to those verified retained bytes, not authority inferred from an untrusted retransmission.

Use this sequence under the daemon's membership-admission serialization boundary:

1. Read the current committed selection/history and authorize the local or peer operation.
2. Calculate the candidate proposal, and use `LocalSelection::after_adoption` when updating a local association.
3. Check `Proposal::ensure_base` against the still-current history. Also check the expected selection UUID, exact local generation, active status and current pointer; a history commitment alone cannot identify a local association.
4. Atomically store every added record with the resulting frontier/commitment and required intent, selection, invitation or departure effects. One candidate and its missing ancestry are one transaction.
5. Only after commit succeeds, publish the new in-memory view and acknowledge durable adoption. A failed write leaves the old view authoritative; if another commit advanced the base, recalculate.

Commit between candidates. A later failure never rolls back an earlier durable adoption. Record iterators are ordered by decoded ID, not topologically; peer transfer must independently enforce ancestor-first ordering. Storage restoration loads one selection's complete frontier closure and checks its stored snapshot against the engine's reconstructed snapshot. Never union every retained selection to reconstruct current authority.

`prepare_change` binds ordinary local records to the entire current frontier. It returns an existing exact result for a matching retained operation ID, and rejects changed input. Already effective removal or exit returns a retained effect without signing again. The storage adapter must first resolve its stable local request/intent binding, including results associated with inactive histories; the engine cannot discover receipts outside its supplied history. Persist the exact signed result before success, so retries after frontier advancement return identical bytes. A valid foreign signer cannot be proven to have disclosed every record it previously knew.

`Limits` supplies configurable working and conflict-evidence budgets, defaulting to 16 MiB each. Checks conservatively account for encoded records and graph/index workspace; they are capacity admission checks, not an OS memory allocator quota. Increase the local budget for larger valid histories. Resource exhaustion is distinct from invalidity and conflict. No total history age/count invalidates authority. The daemon integration additionally owns aggregate worker budgets, cancellation, timeouts and conflict-witness eviction.

## Signing, exit and fresh selection

`prepare_genesis`, `prepare_join` and `prepare_change` produce immutable signing inputs for the external protected key owner. The caller supplies securely generated keys and stable nonces; the engine performs no randomness or file access. `finish` verifies the external signature before producing a record/proof. Invitation credentials, expiry, issuer-local confirmation and consumption remain admission orchestration responsibilities.

`LocalSelection` is a caller-owned value containing selection UUID, exact local membership, status and verified history. `after_adoption` derives inactive status as soon as its resulting history withdraws the local generation. Publish that status with the corresponding durable transaction. `detach_inactive` changes an already removed/left association without a new record or new outbox; retain existing tasks. Ordinary adoption on an inactive association is refused.

`plan_fresh_selection` requires no active previous selection and a fresh active generation/key for the same local host. `ConfirmedLocalAdmission` is a trusted local orchestration assertion, never a peer-deserializable permission token; construct it only after local authorization and issuer confirmation, or authorized local genesis. Receiving a valid admission or retrying an old join is not fresh authorization. The result retains the previous inactive selection separately without unioning its history into the new selection. Old receipts and departure tasks keep their original associations in storage.

`prepare_departure_rebase` accepts the retained original self-departure and an independently verified same-Network recipient history. It constructs only that old generation's withdrawal, derives the stable rebase intent ID and binds the recipient's complete frontier. It never takes a remote body/hash to sign or changes the selected history. The key owner must independently enforce the retained departure's capability and task scope. If the old generation is already absent, `PreparedDeparture::Absent` requests the acknowledgement path; this observation is not a destination's signed acknowledgement and cannot retire a task. New generations remain untouched. TLS identity, acknowledgement validation and retry/outbox lifecycle belong to integration.

## Synthetic validation

Run the focused rule suite:

```sh
cargo test --locked -p dewbow-protocol --test network
```

Tests cover compatible delivery permutations and duplicate withdrawals, concurrent author revocation, three-way removal cycles, inherited conflicts, host/key/invitation/attempt/operation races, invitation-context substitution, missing proofs and budget failures, exact retry bytes, stale commit bases, exit/exclusion/fresh selection, and restricted cross-branch departure construction. Failed commits are modeled by retaining the caller's original immutable view; no real database or peer is used.

Public fixtures in `packages/protocol/rust/tests/fixtures/network-v1.json` contain deterministic synthetic genesis, admission, removal, departure and rebased-departure records, joining proofs, history commitments, Unicode strings, canonical bytes, hashes and signatures. Their independent oracle uses Node.js built-in Ed25519/SHA-256 and the JCS subset for the fixture objects, with no Rust implementation dependency. Regenerate with the repository's pinned Node.js:

```sh
node packages/protocol/rust/tests/fixtures/generate-vectors.mjs
```

The generator uses explicit synthetic seed bytes and emits only public records/signatures. Preserve its source with the vectors. These checks establish local rule behavior and interoperability of these vectors; authenticated multi-node operation, preserving migrations and native execution acceptance remain separate work.
