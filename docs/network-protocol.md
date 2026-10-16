# Network protocol v1

Status: proposed specification, design only. This is the protocol companion to the [Network design](network-design.md) and the implementation baseline for issue #36. No networking code, endpoint, command, database format or release is delivered by this document. MUST and MUST NOT identify requirements of a future conforming implementation.

## Model and guarantees

A Network is a signed membership DAG for one person's Dewbow instances over a reachable LAN or existing VPN. Every active member can admit or remove any member. There is no leader, quorum, permanent creator privilege, relay service or external owner credential. Membership propagation may cross intermediate members; business requests require a direct connection to their execution node.

Each node selects at most one Network history. It retains all accepted management records, automatically incorporates compatible complete changes and preserves its existing history when an incompatible alternative arrives. First acceptance is a local fact, not global finality. No protocol message proves the absence of undiscovered history or identifies the human owner's preferred fork.

The protocol requires a reachable source retaining and providing necessary history, adequate storage and a sufficient verification budget for catch-up. It provides no Byzantine consensus, universal instantaneous revocation, guaranteed delivery after every copy disappears, or native execution replay. Native Codex remains the only durable conversation/content authority.

## Encodings and identifiers

### Canonical bytes

Signed objects use UTF-8 JSON canonicalized by [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785). Reject duplicate property names, unknown fields, invalid Unicode, non-finite numbers and schema/type violations before canonicalization. Preserve string content without Unicode normalization. Protocol integers are nonnegative safe integers; timestamps are UTC strings of the form `YYYY-MM-DDTHH:mm:ssZ`. No floats appear in signed control objects. Arrays representing sets are sorted and duplicate-free.

Use SHA-256 for identifiers and pure Ed25519 from [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) for signatures, with strict canonical point/scalar verification and rejection of small-order public keys. Keys are raw 32-byte public keys; signatures are raw 64-byte values. Encode keys, hashes, signatures and 32-byte random nonces as unpadded base64url with canonical spelling. Compare IDs by their decoded bytes; lengths are checked before allocation. Existing `hostId` values retain their canonical Dewbow UUID representation.

All new random keys, secrets, intent/attempt IDs and opaque session tokens use a cryptographically secure random generator. Opaque tokens are 32 bytes and scoped to connection/purpose; possession never overrides membership checks. Signed primitive fields are required unless a variant explicitly permits null.

Define `bytes(label, object) = UTF8("dewbow.network." + label + ".v1") || 0x00 || JCS(object)`. Labels are fixed literals below, never caller-selected. Define `digest(label, object) = base64url(SHA256(bytes(label, object)))` and `sign(label, object, key) = base64url(Ed25519.Sign(key, bytes(label, object)))`.

| Object | Label | Signed or hashed material |
| --- | --- | --- |
| Genesis | `genesis` | Complete genesis body |
| Membership change | `change` | Complete change body |
| Joining node proof | `join` | Complete join body |
| Invitation | `invitation` | Public invitation body, including credential hash |
| History commitment | `history` | `{ protocolVersion: 1, networkId, recordIds }` |
| Address hint | `address` | Complete hint body |
| Departure acknowledgement | `departureAck` | Complete acknowledgement body |
| Rebased departure intent | `departureRebase` | Hash of `{ networkId, membershipId, operationId, historyId }`; not a separate signature |

The signed record envelope is exactly `{ recordId, body, signature }`. Its ID is `digest("genesis", body)` for genesis or `digest("change", body)` otherwise; its signature uses the same label/body. The signature and envelope are excluded from the ID. A valid record with an existing ID deduplicates; an invalid signature never poisons that ID's future valid delivery.

### Genesis and history snapshots

Genesis body fields are exactly `protocolVersion: 1`, `kind: "createNetwork"`, `nonce`, `networkName`, `hostId` and `publicKey`. `networkName` is a nonempty display string of at most 256 UTF-8 bytes; it is not an authority identifier and has no rename operation in v1. The creator generates a fresh membership key and signs genesis with it. The genesis ID is both `networkId` and the creator's first `membershipId`. Genesis has no parents, author ID or self-referential network field.

For accepted history H, `recordIds` is every record ID in H, including genesis, sorted by decoded bytes. `historyId = digest("history", { protocolVersion: 1, networkId, recordIds })`. `frontier(H)` is the sorted set of IDs having no descendant in H. A frontier commits transitively to the complete ancestor closure. A snapshot is `{ historyId, frontier, recordCount }`; summaries are checked against reconstructed records before they authorize business.

`historyId` changes after compatible additions. It is not an immutable branch name or a request-deduplication namespace. A fork reference is the common `networkId`, the conflicting record IDs and the two observed history IDs; no globally assigned branch ID exists.

### Change bodies

Every change body has exactly `protocolVersion: 1`, `networkId`, `kind`, `operationId`, `authorMembershipId`, `parents` and `payload`. `operationId` is a retained 32-byte random intent ID, except for the explicitly derived rebased-departure ID below. `parents` is the sorted, duplicate-free frontier of the complete causal context, with no redundant ancestor parent. Its closure must contain genesis. A conforming node constructs ordinary changes from its entire current accepted frontier under the same serialization boundary as local adoption.

| Kind | Exact payload | Meaning |
| --- | --- | --- |
| `admitMember` | `{ joinProof }` | Admit the host/key in a signed join proof; the admission record ID becomes the new `membershipId` |
| `removeMember` | `{ membershipId }` | Withdraw that exact active generation; target differs from author |
| `leaveNetwork` | `{ membershipId }` | Withdraw only the author's own generation; payload target equals `authorMembershipId` |

No arbitrary metadata, timestamps, endpoint leases or business requests enter this log. Another device's removal uses `removeMember`; local self-removal uses `leaveNetwork`. Repeating an already effective local removal returns the existing result, without signing a new record. Persist the exact signed record and intent result before reporting local success; retry returns those bytes even after the frontier advances.

Full-context binding is a local authorship requirement. A receiver cannot prove that a malicious signer disclosed everything it previously knew. Signing an old context can produce a valid conflicting branch, subject to the stated stolen-key boundary.

## Whole-history validation and compatibility

Let `past(e)` be the transitive parent closure excluding e. `e < f` means e belongs to `past(f)`. Two records are concurrent if neither precedes the other. `withdraws(e, m)` holds for a removal or self-departure targeting membership m. `ordinary(e)` holds for admission or removal of another member.

### Independent validity

Validate a supplied history independently of the node's selected branch:

1. Require one expected genesis, supported version, valid encodings, matching IDs/signatures, no cycles and every predecessor. Missing data is `PROOF_INCOMPLETE`; unsupported semantics is `PROTOCOL_UNSUPPORTED`; neither is a fork.
2. In topological order, require each record's complete `past(e)` to be a valid compatible history. Look up signing keys by exact admission ID in that past, never by name, IP or a replacement membership of the same host.
3. For an ordinary record, its author must be active in `state(past(e))`. A removal target must also be active there. An admission verifies the join proof, equal Network and issuer membership, fresh key, absence of another active membership for that host, and unused invitation/join identities in that past. Reconstruct the join proof's issuance context from `invitationFrontier`; require its historyId to match `invitationHistoryId`, its complete closure to be contained in admission past, and the issuer/key to be active in that issuance context.
4. A self-departure must be signed by the key of its exact target generation, active in its own complete causal context, and cannot affect another generation. A new sequential departure whose target is already absent is invalid; answer the repeated request idempotently instead. Self-withdrawal remains compatible with a concurrent withdrawal of its author, unlike ordinary operations.
5. Reuse of `(authorMembershipId, operationId)`, `(issuerMembershipId, invitationId)` or `(issuerMembershipId, joinAttemptId)` for different records already in the causal past is invalid. Identical retry records deduplicate. A membership public key cannot be reused by another admission in its causal past.

The joining proof binds a stable host identity to the fresh key; it cannot prove physical hardware identity or detect a secretly cloned state directory. Only the admitting operator confirms that binding.

### Union predicate

For independently valid histories H and K, let U be their set union. U is compatible exactly when its complete closure has the same genesis and no concurrent pair x, y meets any of these conditions:

| Conflict | Exact condition |
| --- | --- |
| Author withdrawal | x withdraws `authorMembershipId(y)` and y is ordinary, or the symmetric case |
| Competing admission | x and y are different admissions for the same `hostId`, or use the same public key |
| Invitation reuse | Different admissions spend the same `(issuerMembershipId, invitationId)` |
| Join equivocation | Different admissions claim the same `(issuerMembershipId, joinAttemptId)` |
| Operation equivocation | Different records claim the same `(authorMembershipId, operationId)` |

Check these conditions across all records in U, including ancestors of supplied tips. Do not merely build a graph of pairwise-compatible tips or select a connected component. Under v1's limited operation set, independent context validation plus these whole-union checks is the compatibility predicate; future operations need a new explicit predicate before support.

Derive `state(U)` by collecting genesis/admission generations and subtracting every exact-generation withdrawal. Do not reauthorize historical ordinary operations against an arbitrary replay prefix of U. Duplicate withdrawals commute; causal inviter removal does not erase an established admission. Historical generations remain recorded after withdrawal, and a readmission must causally follow withdrawal of that host's old generation.

```text
consider(e, accepted):
    if e.recordId is already accepted: return duplicate
    if complete proof is unavailable: discard e; return proofIncomplete
    independently validate past(e) + e
    candidate = accepted union past(e) union {e}
    if candidate fails the whole-union predicate:
        retain bounded verified conflict evidence; return historyConflict
    atomically retain candidate and its derived frontier
    return adopted
```

Process records serially. When a batch contains several independently ready records, choose the smallest decoded record ID next. Do not wait for another peer to provide a preferred alternative. A prior incomplete receipt reserves no place. Later proof completion is evaluated against the then-current accepted set. After genuine conflict, stop ordinary synchronization/business with that peer; never undo an accepted record. Rejoining another branch is an explicit exit and fresh admission.

Retained history and selected history are different associations. After explicit local exit or adoption of the local generation's exclusion, a new locally authorized, issuer-confirmed join verifies its full admission history independently, then atomically selects it. Do not union it with the inactive incompatible selection. Preserve old accepted records, frozen frontier, receipts and departure tasks as inactive evidence. Normal `consider` unions with the current selection only. This explicit transition is neither automatic rollback nor deletion of accepted records, and is the only way to change an incompatible selection. Local exclusion disables authority and marks that selection inactive immediately. Leave on an already removed/inactive generation is idempotent detachment without a new signed record or new outbox; preserve any existing tasks.

## Invitations and admission

An invitation is one string: `dewbow-network-v1.` followed by base64url of JCS `{ body, signature, secret }`. The public body has exactly `protocolVersion: 1`, `networkId`, `issuerMembershipId`, `issuerPublicKey`, `historyId`, `invitationFrontier`, `invitationId`, `issuedAt`, `expiresAt`, `credentialHash` and `endpoints`. Retain the issuance frontier and history commitment with invitation accounting. The secret and invitation ID are independent random 32-byte values. `credentialHash` is base64url SHA-256 of the raw secret. The issuer signs the public body using label `invitation`. This string is transferred through a trusted channel; possession alone does not bypass issuer-local confirmation.

Default expiry is 600 seconds after issuance. A new redemption requires the issuer's current clock to precede `expiresAt`, matching retained invitation state, an active issuer and a compatible continuation of the issuance snapshot. The issuer rejects malformed intervals or a current time before `issuedAt`. Receivers do not retroactively expire a valid old admission using their own clock. Signed timestamps do not prove globally correct elapsed time; a faulty issuer clock remains an explicit limitation.

The join body has exactly `protocolVersion: 1`, `networkId`, `issuerMembershipId`, `invitationId`, `invitationHistoryId`, `invitationFrontier`, `joinAttemptId`, `hostId` and `publicKey`. `joinProof` is `{ body, signature }`, signed with the joining key using label `join`. The history ID/frontier equal the invitation's issuance snapshot. The admission's author equals the proof's issuer. The joining node verifies that complete issuance context and issuer membership before signing; peers later verify it as admission ancestry. Admission history contains no invitation secret or bearer credential.

The joining node persists its fresh key and stable invitation/attempt identity before any exchange. It pins the issuer key before transmitting the secret. `getInvitationProof` validates the live invitation over this pinned channel without consuming it, and returns a read-only proof token for issuance ancestry. The joining node validates that ancestry, then signs and retains the exact join body/proof before redemption. This breaks the dependency between validating issuance history and supplying a signed join proof. The issuer verifies token, key possession and stable attempt, then asks its local authenticated operator to confirm host/key. At confirmation commit, recheck expiry, unused token, active issuer, issuance-context compatibility and host/key uniqueness under the adoption serialization boundary. Commit invitation consumption, exact admission and retry result atomically before success. A second attempt cannot redeem a consumed invitation. Reject a same-attempt request with changed device, key or input.

If the response is lost, an exact retry authenticates the joining key and returns the original record, including after token expiry or issuer withdrawal. This restricted result retrieval grants no new admission, remote operation or invitation use. Retain successful invitation-to-attempt/result bindings with accepted history; delete unused secrets after expiry and consumed secrets after admission. A denial retains the attempt's fingerprint and denied outcome until invitation expiry, leaves the invitation unused and never signs an admission. Retry returns that denial rather than reopening its prompt. Pending local confirmation is runtime-only and is requested again after restart unless a retained terminal result exists.

Result recovery need not retain the old issuer's TLS key forever. If it is unavailable, explicitly reconnect in public `joinRecovery` proof-only mode, sending only the retained public joinProof, never the invitation secret. Verify a positive returned original admission with the invitation-pinned issuer key and complete context, regardless of the recovery transport's identity. An untrusted negative or missing result proves nothing and cannot clear an uncertain attempt or trigger automatic fresh admission/key generation. Serving retained signed bytes needs no old issuer signing key. Normal redemption still requires the original pin.

The joining node verifies complete genesis-to-admission history before it becomes business-ready. A one-sided issuer success may therefore precede joiner readiness; status distinguishes them. A different existing active host membership must be withdrawn before new admission, and each admission uses a fresh key. Last-member exit or loss of all usable membership keys requires a new genesis; restoring old files cannot prove current authorization.

## Transport and trust bootstrap

Use a separate explicitly configured peer listener with mutual [TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446); no fixed port is assigned. Require both server and client CertificateVerify, including provisional proof and fresh-join channels. Cryptographically verified unknown client certificates grant proof access only. Existing loopback operator Web/control authentication stays separate. Peer routes do not accept browser cookies, local control tokens, arbitrary public CA identity or trust-on-first-use as membership authority. V1 disables 0-RTT and session resumption; an offered resumption must fall back to a fresh full authenticated handshake. Recheck current authority on every connection.

Each TLS certificate presents the exact public key of the claimed membership generation; TLS key-possession verification must remain enabled. A self-signed certificate is a key container, not membership permission. Certificate refresh with that same key changes no membership. Invitation pinning or a verified admission establishes the expected key. Provisional unknown keys may complete only a restricted proof channel, without sending invitation secrets or business data; no failed pin silently becomes a trusted peer. A claimed membership must bind to the actual TLS peer key, preventing replay of another member's admission proof as one's own.

To select among active and retained old keys before HTTP, the client sets TLS SNI to `k-<first32>.<last32>.dewbow.invalid`, where the two lowercase hexadecimal halves encode SHA-256 of the expected raw public key. This selector is public routing information, not authorization or a DNS lookup; dial the configured endpoint separately. If the key is retained, the server selects it but grants only the permissions currently valid for that identity. If unavailable, fail that pinned connection. An explicit proof-only reconnect uses `proof.dewbow.invalid` and any server key; it cannot redeem an invitation or carry business until a new admission proof independently establishes the current identity and a fresh authenticated member handshake succeeds. Outbox acknowledgements always require the expected recipient key, not this fallback.

If no membership key remains, a running configured proof listener may use a fresh transport-only key for public result recovery; it claims no membership and grants no business access. Each TLS connection has one hello binding. Changing identity, Network or purpose requires a new connection; pool connections by these bindings, not merely endpoint address. A valid completed admission proof can then feed normal compatible adoption, followed by a fresh member connection; proof verification alone never overrides the selected history.

`hello` is a tagged input with common `{ protocolVersion: 1, networkId, mode }` and exactly one variant:

| Mode | Additional fields | Initial permissions |
| --- | --- | --- |
| `member` | `{ membershipId, history }` | Proof/reconciliation until current member/context checks pass |
| `join` | `{ issuerMembershipId, invitationId, joinAttemptId }` | Fresh TLS key has no membership ID; pinned-issuer invitation-proof fetch and redemption only |
| `joinRecovery` | `{ joinProof }` | Exact public committed-result retrieval only, never secret redemption |
| `proof` | `{ membershipId, purpose }` | Claimed admission/exclusion/departure proof only; null membershipId permits responder-identity proof without enumeration |

The response is `{ protocolVersion: 1, networkId, membershipId, history, access }`, identifying the server's presented key and verified binding where available; membershipId/history may be null in a strictly provisional proof response. `access` is `proofOnly`, `synchronize` or `business`, a runtime observation rather than a durable grant. An admission candidate must bind its proven generation to the actual client key. Business and mutations require caller and target hello identities to equal the TLS keys and current active generations. Unknown versions fail closed without exit, fork selection or state rewrite.

| Peer situation | Permitted exchange |
| --- | --- |
| Key matches a known active generation | Reconcile history; business only after current context/authority checks |
| Unknown generation with a claimed admission | Submit bounded signed admission ancestry, genesis-first, through `submitMembershipProof`; verify before ordinary manifests |
| Known historical or removed generation | Proof needed for its exclusion or its own old-generation departure; no general manifests/address book/business |
| Invitation-pinned issuer and fresh joiner | Exact invitation redemption, confirmation/result recovery and admission proof |
| Unrelated genesis or key without a valid claim | Generic denial; no history enumeration |

Proof sessions identify a purpose and exact claimed generation. Except for invitation-authorized issuance proof, require that generation's signed admission and TLS-key possession, or a locally known historical binding, before returning restricted history. Validate submitted ancestry in bounded transient working memory or against retained accepted records. An isolated unverified descendant is discarded and must be resent after its parents. A proof view can contain verified foreign records without being selected locally; discard it at session end instead of keeping a pending queue.

Full-context proof validation can require an entire branch's membership ancestry. V1 explicitly permits this disclosure to a historically admitted key for exclusion/departure, and to a valid candidate for admission verification. Necessary proofs may identify other members. They never include private keys, invitation secrets, addresses unrelated to proof delivery, native content, callbacks or business receipts. Exceeding a verification budget gives `RESOURCE_LIMIT`; it does not manufacture membership validity or a global conflict.

## History synchronization without an orphan queue

### Triggers and snapshots

Connect/reconnect starts reconciliation immediately. While still active after adoption, send a coalesced `notifyHistory` to known reachable members; every connected peer also compares summaries every 30 seconds with up to 10% jitter. While an active Network exists, startup and the bounded retry scheduler attempt known disconnected nonconflicting members, rotating endpoints fairly. Notifications are hints and can be lost. Disconnection and restart never change membership. Confirmed incompatible peers are excluded from ordinary attempts until fresh membership or explicit local reconnection. Exclusion or exit stops ordinary notification/sync; only permitted restricted exchanges and existing outbox tasks remain.

Each direction calls `openHistory` with `{ frontier }` (null for current history, or a retained frontier contained in the source's selected history), receiving `{ historyId, frontier, recordCount, snapshotToken }`. The token is random, connection-bound and purpose-bound, with a 60-second renewable idle timeout. Successful page/record/ack activity renews idle expiry; there is no fixed 60-second total duration. This permits large manifests to finish. IDs/records remain tied to one immutable snapshot despite newer adoption. Expiry or restart gives `SNAPSHOT_EXPIRED`; restart from summaries, retaining valid records already adopted. Limit concurrent tokens rather than making old history invalid.

The two directions use separate authenticated HTTP connections. On each connection the client reads the server's manifest and submits its own fixed manifest through `submitHistoryManifest`. This lets the server identify the caller's known IDs without reverse HTTP requests on the same connection. The reverse pull needs a reachable contact candidate, not an online founder.

`listHistoryIds` input is `{ snapshotToken, afterRecordId, limit }`, using null initially. Result is `{ historyId, recordIds, nextAfterRecordId }`, with IDs in decoded-byte order and null next at completion. Both peers exchange complete paged manifests. Check uniqueness, order, total count and reconstructed history commitment; never splice pages from different snapshots. A manifest remains a claim until matching complete signed records validate. Claims cannot delete local history or grant authority.

`submitHistoryManifest` has two tagged forms:

| Input | Result |
| --- | --- |
| `{ mode: "open", history }` | `{ manifestToken, nextAfterRecordId: null, complete: false }` |
| `{ mode: "write", manifestToken, afterRecordId, recordIds, done }` | `{ manifestToken, nextAfterRecordId, complete }` |

Open reserves one bounded upload for that connection and purpose, replacing its previous upload. Each write contains at most 256 IDs in strictly increasing decoded-byte order; its afterRecordId equals the last accepted ID or null initially. An identical last-page retry returns the same progress. Changed retries, overlapping/out-of-order pages, mixed snapshots and excess counts fail. A final page sets done and must match the declared count, reconstructed historyId and frontier membership before complete becomes true. nextAfterRecordId is the last accepted ID, including on completion. A completed upload remains immutable until a new open. Its random token has the same renewable 60-second idle expiry and disconnect lifetime as snapshots; capacity limits apply before reservation. Only a completed manifest may be referenced by readHistoryRecords.peerHistoryId. The claim never selects history, grants authority or acknowledges adoption.

### Record transfer and acknowledgement

After both manifests, compute differences. `readHistoryRecords` input is `{ snapshotToken, peerHistoryId, recordIds, cursor }`. `peerHistoryId` names the other manifest completed on this connection, and `recordIds` selects missing targets. The source traverses their ancestry minus the other manifest's known IDs and transmits parents before children, breaking ready ties by ID. Result is `{ historyId, records, cursor, hasMore }`, bounded by both record count and bytes. Continuation state is runtime-only and connection-bound.

Only a complete independently valid record compatible with local accepted history is durably adopted. Already retained records deduplicate. A receiver sends `acknowledgeHistory` with `{ historyId, recordIds }` only for records it has durably accepted, including duplicates confirmed in its store. The source may use these acknowledgements to avoid redundant transfer during this session, never as permanent proof of future peer state. Incomplete, invalid, conflicting or merely received records are not adoption acknowledgements.

If Y arrives before missing X, discard Y and optionally return `PROOF_INCOMPLETE`. That response is only a progress hint. Correctness must survive losing the hint, all cursors and every ephemeral buffer: next manifest comparison still lacks Y, and the sender's ancestor-first transfer supplies X then Y. A source with later Z retains X and Y as ancestors and can supply them. Merely obtaining X does not reveal its children; recurring manifests are what rediscover Y.

After transfer, compare current summaries again, synchronizing new compatible changes within the caller's deadline. If local changes keep advancing, stop with `SYNC_REQUIRED` when the deadline expires. Do not block local management while waiting for an incomplete proof. Other verified connections continue. No pending change record, permanent incomplete-ID blacklist or cross-request orphan cache is stored. V1 does not compact accepted history or use sender deletion based on peer acknowledgements.

## Addresses, retries and resource bounds

Explicit operator seed endpoints and retained last-known endpoints are the initial connection candidates. A member can send `{ body, signature }` under label `address`, where body is `{ protocolVersion: 1, networkId, membershipId, endpoints, leaseSeconds, nonce }`. `leaseSeconds` is 1 through 300 and starts at receipt; duplicate live nonces do not refresh it. A reachable member can forward this unchanged. Verify the original member's signature and current identity before adopting a hint.

Hints only affect connection attempts. They cannot replace keys, create membership or authorize a different host at the same address. Keep at most eight candidate endpoints per membership, favoring explicit seeds and successful connections. Lease expiry removes freshness, not membership or the last useful contact candidate. No mDNS, network scanner, public rendezvous or NAT traversal is part of v1. If no path remains, the operator supplies a new seed.

Endpoints are HTTPS origins with an explicit port, no userinfo, query, fragment or non-root path. Disable redirects and check resolved addresses before dialing. Remotely supplied hints cannot target loopback, unspecified, multicast or link-local addresses; explicit local seeds may select a locally intended endpoint. Do not forward credentials until expected-key verification. DNS or address changes never relax key verification.

| Setting | V1 default or bound |
| --- | --- |
| Invitation lifetime | 600 seconds |
| Periodic reconciliation | 30 seconds, up to 10% jitter |
| Connect timeout / sync-only automatic business wait | 5 seconds / 10 seconds |
| Snapshot idle timeout | 60 seconds, renewed by successful activity; no fixed total lifetime |
| Peer request/control frame | At most 1 MiB; no compression in v1 |
| Business result transfer | 64 KiB decoded chunks; default 64 MiB aggregate budget, locally adjustable |
| Signed record envelope | At most 256 KiB UTF-8 |
| Manifest page / requested missing IDs | At most 256 / 128 IDs |
| Record page | At most 32 records and 1 MiB, whichever comes first |
| Control/proof JSON nesting | At most 16 levels |
| Concurrent connections / proof workers | Default 32 / 4 per daemon |
| New proof sessions from one presented key | Default 6 per minute, burst 2, plus a global worker budget |
| Transient proof working memory | Default 16 MiB per worker, 64 MiB daemon total |
| Automatic retry backoff | 1, 2, 4, ... seconds, capped at 300 seconds with up to 20% jitter |
| Verified alternative evidence | Default 64 conflict witnesses and 16 MiB total |

Frame, record, encoding and page bounds are v1 interoperability rules. Capacity, rate, retry cadence and working-memory defaults may be configured locally without changing record validity. If a record's complete frontier cannot fit the record bound, return `RESOURCE_LIMIT`; do not omit parents or silently compact history. There is no total age/count cutoff invalidating accepted history. A large foreign proof may require increasing the local working budget; report this explicitly rather than pretending it was invalid. Release buffers/proof work on their session's disconnect, idle deadline or cancellation. The 10-second business wait does not cancel independent background reconciliation. If disk writes fail, preserve accepted state and refuse adoption/admission requiring durability.

Keep a small verified conflict witness: record IDs, reason, necessary signatures/bindings and ancestry not already retained. Evict oldest witnesses when the evidence budget is reached, without dropping accepted history or changing branch. Eviction may cause re-verification on a later contact. Peer reachability, active snapshot cursors, addresses learned from failed unverified peers and live connection authorization are not durable grants.

## Departure delivery across branches

Exit from an active membership atomically retains the signed departure, immutable intent `{ networkId, membershipId, operationId, departureRecordId }`, and one task for every other active generation in the pre-exit selected state, then disables normal authority immediately. An already removed/inactive membership detaches idempotently without signing or new tasks. Do not create tasks for historical removed generations. Tasks bind recipient host, membership ID and key, not just an address. Retain only signed contact hints/known endpoints needed for fixed destinations; remote proofs cannot add destinations. Joining another Network or generation does not delete this outbox or reuse its key.

1. Authenticate the expected recipient key over the restricted channel. A new key at the old address cannot acknowledge the old recipient's task. Obtain a bounded, complete valid proof view for that recipient's current context; do not select it locally.
2. If that view already excludes the departing old generation, request an absence acknowledgement. A newer admission of the same host is never the withdrawal target.
3. If the original departure's full closure is compatible, offer it. Otherwise locally construct `leaveNetwork` with the exact old generation and recipient frontier. This rebasing is the sole exception to signing against the exited node's own accepted frontier.
4. Derive a stable rebase operation ID as `digest("departureRebase", { networkId, membershipId, operationId, historyId })`, where operationId is the retained original intent. Sign only this constructed record, never a remote-provided body or hash. Bind the same Network and key; verify every context record before signing. Reject another Network, another generation, arbitrary operation or unsupported semantics.
5. An active recipient validates and atomically adopts the withdrawal, or confirms absence. It returns a signed `departureAck` body `{ protocolVersion: 1, networkId, departureRecordId, membershipId, recipientMembershipId, historyId, status }`. `status: "absent"` certifies the sender's old generation is absent in that verified view. If the expected recipient has itself exited or been removed, `status: "recipientInactive"` instead supplies its retained valid withdrawal context; it need not adopt the sender's history or reactivate itself. This also handles two nodes leaving while mutually offline. Both statuses complete only that destination task. `departureRecordId` identifies the original intent even for a rebase. Verify the expected recipient key, scope and complete context before marking completion.

Restricted retained keys may authenticate this channel and sign locally constructed control acknowledgements; their only management-record signing capability is withdrawal of their own exact old generation. They cannot admit a node, remove another generation, request execution or query native content/receipts. A post-exit proof view and its records are transient, not a second selected history. Necessary proof ancestry may reveal the recipient's membership history, as described above.

Unconfirmed tasks do not expire. Retry only while the daemon runs, under the bounded backoff and concurrency rules. Another member's acknowledgement cannot complete a destination's task. A replaced recipient that cannot prove possession of its old key leaves that task unconfirmed; it does not certify all old branches disappeared. Explicit local forgetting may abandon tasks and disclose that those destinations remain unconfirmed. The old private key can be deleted when no pending departure task or join recovery needs it; complete public accepted history remains. No finite known destination set guarantees delivery to every undiscovered member/branch. If the old key is lost, another active member must remove the old generation; keyless rebasing is impossible.

## Business requests and receipts

Peer business access requires both caller and target active in a reconciled compatible context. The entry first authenticates its local operator. The target trusts that member's delegation, then enforces its own native policy, callback identities, bindings and session serialization. A stolen member key can therefore be serious operator authority; signatures are not independent proof that a human approved the action. V1 adds no owner credential to change that trust model.

Define a business context `{ protocolVersion: 1, networkId, callerMembershipId, targetMembershipId, historyId, sourceHostId, targetHostId }`. Caller and target IDs must equal the actual client/server TLS keys' verified hello generations, both current active members. Source/target host IDs must match those admitted bindings and the receiving daemon. A peer cannot claim another member's receipt scope merely by supplying its IDs.

`executeOperation` adds `{ operation, input, requestId }` to this context. Allowed mutation names are exactly `createSession`, `connectSession`, `sendMessage`, `steerTurn`, `answerQuestions`, `decideApproval` and `interruptTurn`. `input` contains the existing typed operation fields except `requestId` and target-routing `hostId`, which are forbidden inside input. The adapter reconstructs those fields from the outer envelope where the local operation expects them; session/turn/interaction IDs remain in input. Reject mismatches and unknown fields rather than applying precedence. Lifecycle/control/upgrade operations, arbitrary HTTP paths and native protocol forwarding are forbidden. Existing operation validation and target runtime/callback checks remain mandatory.

Under a single membership-admission serialization boundary, require the envelope's historyId to equal the target's current selected historyId and both exact generations to remain active. Otherwise return `SYNC_REQUIRED` before admission or deny an established conflict/exclusion. Only then admit into the existing execution/receipt mechanism. The entry automatically synchronizes compatible differences for up to 10 seconds, retrying identical input and request identity. This wait is volatile, not a durable execution queue. Expiry before possible admission is `NOT_READY`. Once dispatch could have reached admission, missing response is `DELIVERY_UNCERTAIN`, not evidence of nonexecution. Reads, receipt queries and subscription starts use the same current-context gate; native reads remain read-only.

The logical remote receipt key is `(networkId, sourceHostId, requestId)` at the original target state directory. It excludes `membershipId`, `historyId`, transport instance and entry restart, so fresh admission/compatible merge cannot bypass the retained receipt. Different source hosts can use the same client ID without colliding. Map this scope into a separate durable receipt keyspace in the future format; keep legacy local receipt identities unchanged and never synthesize a string prefix that can alias a released local client ID.

Before first dispatch, the entry atomically retains an outbound binding from that same tuple to original targetHostId, operation, semantic fingerprint and dispatch state, without storing the input content. Reusing it with another target/input conflicts locally. Retain it while delivery is uncertain, across restart, exit and fresh admission; keep settled bindings for at least the target's guaranteed retry window. The target cannot detect an attempted redirect to another machine by itself. After entry restart, query the bound target or wait for the caller to resupply identical verified input; never reconstruct/replay native work from the binding. Losing state-directory identity is not recovery of old outbound attempts.

The input fingerprint includes original target, operation and normalized semantic input using existing operation-specific rules; exclude changing auth/context envelopes. If a retained scoped receipt exists, reauthorize the caller, validate original target/input and return it without executing again. A changed target/input conflicts. Network changes cannot create another namespace, redirect an uncertain operation or turn a retry into new work. Receipt queries require current authorization; removed/incompatible callers cannot use proof/departure routes to recover business data.

`getRequestReceipt` adds `{ receiptSourceHostId, requestId }` to the caller's business context. The lookup tuple uses receiptSourceHostId, while caller/source identity still matches TLS. Any currently authorized operator member may inspect that receipt, including an original entry's receipt after it was removed, but cannot execute under another source host's scope. Result is `{ receiptScope: { networkId, sourceHostId, requestId }, receipt, receiptRetentionSeconds }`, where receipt is the existing operation receipt or null. A null result is not proof of nonexecution after cleanup. An inspecting member never converts the query into a new mutation or receipt namespace.

The target advertises `receiptRetentionSeconds: 86400` as a minimum, counted from its first acceptance, and follows the existing [retention policy](storage.md), including indefinite protection while delivery or execution recovery is uncertain. Cleanup of scoped receipt and routing associations must be atomic. Missing receipts after the guarantee do not prove nonexecution; do not automatically retry uncertain old operations as fresh work.

| Race or failure | Required result |
| --- | --- |
| Caller removal commits before admission | Reject the request |
| Admission commits before caller removal | Keep original work/recovery; deny later caller requests and subscriptions |
| Target itself becomes excluded before admission | Stop Network admission; local work remains available |
| Response lost after possible admission | Preserve original identity and query the target; never fail over execution |
| Compatible context changes during retry | Reconcile and retain the same receipt scope and fingerprint |
| A fork/removal blocks recovery | Keep the outcome uncertain until an authorized path can query it |

`readOperation` adds `{ operation, input }` to the business context without creating a receipt. Allowed reads are exactly `listHosts`, `listSessions`, `getSession`, `readSessionHistory`, `getSessionActivity` and `readSessionContent`. Strip/forbid inner routing hostId as above; reconstruct target-local input. `listHosts` returns only the selected target's local host, not recursive Network discovery. Native read cursors keep their existing meaning and are committed by the caller only after a complete result has been received and merged.

### Large results and subscriptions

Existing typed native history can contain one item larger than the control-frame bound. Do not truncate it, split semantic messages, invent history cursors or persist a content copy to fit transport. Successful business responses fitting 1 MiB use the ordinary JSON result envelope. Larger responses use `application/x-ndjson`, transferring that same serialized result envelope as bounded frames:

| Frame | Exact fields |
| --- | --- |
| Start | `{ type: "start", transferId, eventType: "result" }` |
| Chunk | `{ type: "chunk", transferId, index, bytes }`, zero-based contiguous index, base64url of at most 64 KiB serialized UTF-8 bytes |
| End | `{ type: "end", transferId, chunkCount, byteLength, sha256 }`, SHA-256 over concatenated decoded bytes |

The receiver validates continuity, size/hash and complete JSON before publishing a result or advancing a native cursor. There is no disk spool or durable chunk buffer. An interrupted read can be repeated; an interrupted mutation response preserves delivery uncertainty and uses receipt recovery. The default aggregate budget is 64 MiB and may be increased locally; budget errors do not change native history completeness. Source truncation already present in Codex remains unknown completeness.

`subscribeSessionUpdates` is a separate POST operation adding `{ sessionId }` to the business context. It returns `text/event-stream`, an explicit exception to JSON result responses. SSE events `start`, `chunk` and `end` carry the same frame objects, with start eventType `snapshot` or `update`. Transfers are serialized. Their reconstructed JSON is `{ subscriptionId, eventId, networkId, hostId, membershipId, runtimeId, historyId, payload }`, where payload is the existing SessionUpdates object and eventId is a per-subscription safe integer starting at 1. runtimeId is fresh whenever the target's owned native process changes, not the entry's runtime. Apply only complete validated events.

The first logical event is a current snapshot. Reconnect always creates a new subscriptionId and snapshot; v1 does not resume from Last-Event-ID or retain a durable stream log. Existing native history cursors remain independent. Closing the HTTP stream cancels subscription delivery, not execution. Heartbeat comments may be sent every 15 seconds. `streamError` carries `{ code, message, retryable }` without a successful end frame. Removal closes the stream; any local accepted-history change invalidates its context and closes it with SYNC_REQUIRED, after which reconcile and resubscribe. The entry also closes streams when its own context changes. Pending callbacks remain tied to the exact target runtime and current caller authority. No response chunks, native content or completed native turn history enter Network storage.

## Peer operation surfaces and errors

The daemon implements member/proof hello, bounded proof exchange, history reconciliation and signed address hints on its optional separate TLS listener. The CLI lifecycle implements invitation redemption, issuer-local confirmation, original-result recovery and departure delivery. Native business handlers remain deferred and return NOT_READY after applicable authority checks. See [Peer transport](network-peers.md) for the implementation and configuration boundary. Peer operations are JSON `POST /network/v1/<operation>`, returning `{ result }` or `{ error: { code, message, retryable } }`, except for the future explicitly framed large results and SSE subscriptions. No request logs include secrets or raw business content. Hello establishes protocolVersion/networkId for the connection; subsequent control inputs inherit that context and are rejected across Network/session boundaries. Business envelopes repeat it for admission checks. Every request still checks current route permissions, not a cached access label.

| Peer operations | Purpose |
| --- | --- |
| `hello`, `submitMembershipProof` | Key/member binding and bounded purpose-scoped proof exchange |
| `getInvitationProof`, `redeemInvitation`, `getJoinResult` | Issuance ancestry, issuer-local confirmation and exact-attempt recovery |
| `notifyHistory`, `openHistory`, `listHistoryIds`, `submitHistoryManifest`, `readHistoryRecords`, `acknowledgeHistory` | Snapshot comparison, bidirectional manifest exchange, ancestor-first records and durable adoption acknowledgement |
| `exchangeAddressHints` | Signed hint exchange between current verified members |
| `deliverDeparture`, `getDepartureStatus` | Original/rebased exact-generation exit and acknowledgement |
| `executeOperation`, `getRequestReceipt`, `readOperation`, `subscribeSessionUpdates` | Direct typed target operations and native updates under current authority |

`submitMembershipProof` has three exact forms, all under a purpose-bound connection:

| Mode/input | Result |
| --- | --- |
| `{ mode: "open", purpose, membershipId, recordId }` | `{ proofToken, history }`; history is null for an unverified claim |
| `{ mode: "write", proofToken, records, done }` | `{ proofToken, verifiedRecordIds, complete, history }` |
| `{ mode: "read", proofToken, cursor, limit }` | `{ proofToken, records, cursor, hasMore, history }` |

Purposes are `admission`, `exclusion` or `departure`; `getInvitationProof` additionally issues a read-only invitation token. Positive `getJoinResult` and `redeemInvitation` replies include a `proofToken` authorizing only the original admission closure; departure acknowledgements include a `proofToken` for their verified acknowledgement context. Read those tokens through `submitMembershipProof` read mode on the same connection. No additional proof-open capability is granted. Open binds the exact claimed generation, TLS key and target record; an unrecognized candidate can upload signed ancestry but receives no responder history until its claim is validated. A known member may request responder-identity proof with null recordId, receiving only that server generation's admission closure. Reads expose only the responder-prepared closure permitted for that claim. Pages are ancestor-first and bounded like record pages; incomplete records are discarded and must be resent. `done: true` requests final complete-context verification. `verifiedRecordIds` acknowledges transient verification, not selected-history adoption. Tokens expire after 60 seconds idle with successful page activity renewing them, and vanish on disconnect. Proof workers also have a locally configurable 300-second total verification budget; increase it explicitly for a larger valid proof. This is a processing budget, not history invalidation, and does not apply to ordinary manifest snapshots. A valid foreign proof does not automatically select it. Only normal compatible adoption uses acknowledgeHistory.

Other control shapes are fixed as follows; proof-bearing replies use the proof-session mechanism rather than an oversized inline history:

| Operation | Input | Result |
| --- | --- | --- |
| `notifyHistory` | `{ history }` | `{ received: true }`, no adoption claim |
| `getInvitationProof` | `{ invitation }` over invitation-pinned join channel | `{ proofToken, history }` for issuance ancestry without consumption; invitation ID alone is insufficient |
| `redeemInvitation` | `{ invitation, joinProof }` | `{ status: "awaitingConfirmation" }`, `{ status: "denied" }` or `{ status: "admitted", record, history }`; poll exact attempt while pending |
| `getJoinResult` | `{ joinProof }` | Same result variants or unavailable; original signed bytes only, no fresh signing |
| `exchangeAddressHints` | `{ hints }`, at most 8 | `{ hints }`, at most 8 valid current hints |
| `deliverDeparture` | `{ departureRecordId, record }` | `{ status: "proofRequired" }` or `{ acknowledgement }` after proof/adoption |
| `getDepartureStatus` | `{ departureRecordId, membershipId }` | `{ acknowledgement }` or `{ status: "proofRequired" }` |

`readHistoryRecords` cursors and proof tokens are scoped to connection/snapshot and never durable. A returned history summary can be expanded only through the purpose-appropriate proof path. Business receipts and subscriptions are never available there. The same operation cannot upgrade a proof-only connection into business access without a verified member handshake and reconciliation.

| Error | HTTP status | Effect |
| --- | --- | --- |
| `INVALID_INPUT`, `INVALID_PROOF` | 400 | Reject the input, no forced fork or exit |
| `UNAUTHORIZED`, `FORBIDDEN` | 401 / 403 | No business; restrict proof disclosure as specified |
| `PROTOCOL_UNSUPPORTED` | 400 | Retain state; require a supported peer/version |
| `PROOF_INCOMPLETE`, `SYNC_REQUIRED` | 409 | Discard incomplete records; reconcile, no admission for that refused attempt |
| `HISTORY_CONFLICT` | 409 | Retain accepted branch; stop ordinary exchange |
| `REQUEST_CONFLICT` | 409 | Keep original receipt; no new execution |
| `SNAPSHOT_EXPIRED` | 410 | Restart snapshot exchange |
| `INVITATION_EXPIRED`, `INVITATION_USED` | 409 | Reject new redemption; permit exact committed-result recovery |
| `RESOURCE_LIMIT` | 429 | Apply backoff/increase local capacity; do not reinterpret history |
| `NOT_READY`, `UNAVAILABLE` | 503 | No readiness guarantee; distinguish pre-admission failure from uncertainty |
| `DELIVERY_UNCERTAIN` | 409 or retained receipt outcome | Original target/identity remains authoritative |

These peer status mappings do not change the existing operator Web mappings. Local Network CLI operations use existing private control authentication and the inputs below. CLI commands include `dewbow network create`, `invite`, `join`, `pending`, `confirm`, `deny`, `status`, `members`, `remove`, `leave` and `set-peer-address`; see the [CLI guide](cli.md#network-membership) for exact syntax. Admission confirmation is an issuer-local operator action, never a remote approval bypass.

Future operator envelopes select a target using `{ networkId, hostId }` and include `sessionId` for session operations. Existing local callers remain valid without Network fields. The implementing PR must align [interfaces.md](interfaces.md) and [openapi.yaml](openapi.yaml) with the actual additive routes and shared Rust/TypeScript contracts. Peer routes cannot expose `/internal` or browser credentials.

For these local operations, requestId is an operator intent retained through retry, not a peer joinAttemptId or native execution ID. Creation/join requires no currently active membership. Status is local, not global consensus.

| Local operation | Input | Result |
| --- | --- | --- |
| `createNetwork` | `{ networkName, listenEndpoint, advertisedEndpoints, requestId }` | Local Network status after durable genesis |
| `createInvitation` | `{ requestId }` | `{ invitationId, invitation, expiresAt, status }`; token only while live |
| `joinNetwork` | `{ invitation, requestId }` | Status with stable joinAttemptId and joining/active readiness |
| `confirmNetworkJoin` | `{ joinAttemptId, publicKey, decision, requestId }`, decision allow/deny | Exact admission result or local denial; stale/mismatched prompt fails |
| `getNetwork` | `{}` | `{ networkId, membershipId, historyId, networkName, localStatus, dissemination }`; identity fields may be null when none |
| `listNetworkMembers` | `{}` | `{ members }` derived from selected history, exact generation IDs and separate observed reachability |
| `removeNetworkMember` | `{ membershipId, requestId }` | Local adoption and per-known-peer dissemination; self-target uses leave semantics |
| `leaveNetwork` | `{ requestId }` | Local exit plus known-destination task status |
| `setNetworkPeerAddress` | `{ membershipId, endpoint, requestId }` | Updated local seed, without changing key or membership |

localStatus is `none`, `joining`, `active`, `left` or `removed`. Dissemination reports only known peer acknowledgements. Retrying issuance returns the same live invitation or its consumed/expired status, never another token. Retrying a committed join returns its result even if a runtime confirmation prompt vanished. A fresh authorized join may replace an inactive left/removed selection; an incidental join retry cannot replace an active incompatible selection. Pending confirmation details are runtime-only, not native Codex callbacks.

## Persistence and implementation boundary

The proposed durable model consists of accepted signed records and retained per-selection frontiers, the current selected-history association, Network/member key bindings, local invitation result accounting, bounded verified conflicts, current signed contact hints, departure intents/tasks, outbound original-target bindings and scoped business receipts/recovery associations. Private key files are protected local state, with owner-only POSIX permissions or Windows ACLs; do not put raw keys in shared records, logs, URLs or browser storage. Keep old departure keys separate from the active key and clean uncommitted joining keys only after resolving uncertain admission. Public result recovery does not require retaining an exited issuer's private key forever.

Atomically commit accepted records with their frontier/intent results, admission with invitation use, exit with its outbox, explicit fresh join with its new selection association, outbound target binding before dispatch, and native request receipt before native action. Restart reloads committed selection and retained evidence, reconstructs members and resumes departure tasks and uncertain routing recovery. Reject malformed/newer/unsupported formats without rewriting them. Reconstruct volatile connection/proof/sync state instead of restoring authorization.

This model extends the current management allowlist and needs an explicit ordered format/configuration migration under [storage compatibility](storage.md) before implementation writes it. Select the next format after auditing supported published tags, preserving local IDs, frozen settings, receipts/fingerprints and active/uncertain native associations, with a recoverable backup and interruption tests. Do not reset existing state, reinterpret released local request IDs or use a second live database. This specification allocates no storage/product version and changes no released contract by itself.

The [Network storage, keys and crash recovery design](network-storage-design.md) refines this boundary with local tables, key encoding, file/database ordering and recovery outcomes. The implemented [storage foundation](storage.md#network-storage-foundation) uses schema 2. [Peer transport](network-peers.md) reuses that format without adding another database or durable content stream.

Library selection, final executable DDL/indexes, exact CLI flags and UI presentation belong to the implementation PRs; they must implement these semantics rather than reopen the protocol decisions. Compaction, in-place rotation, owner-key recovery, automatic LAN discovery, execution relaying, protocol upgrade governance and automatic fork merging are outside v1. Unknown versions/operations fail closed without selecting a branch or erasing state.

## Conformance scenarios

These are required synthetic implementation scenarios, not results of an implemented feature or a formal security proof. Start from a valid common history unless a case says otherwise. Preserve the [design's automatic-merge table](network-design.md#automatic-merge-rules) in addition to these cases.

| Case | Required observation |
| --- | --- |
| Independent admissions/removals under every delivery order | Same accepted compatible set gives identical members, frontier and historyId |
| Reordered/duplicate JSON properties, Unicode and set arrays | JCS bytes agree; invalid duplicate fields/noncanonical IDs are rejected; semantic set ordering is validated |
| Identical operation/join retry after history advances | Return byte-identical original signed record; never sign a fresh result |
| Concurrent A removes B1; C removes B1; B1 admits D | The two withdrawals merge, but adding the admission fails the whole-union predicate |
| Concurrent A removes B1; B1 removes C1; C1 removes A1 | Individually valid branches exist; the whole three-record union is incompatible |
| A removes B1; B1 admits D; D then admits E | E cannot be imported without its conflicting admission ancestry |
| C accepts B1 admitting D, then C admits E; A concurrently removes B1 | E inherits the complete branch context even though C itself remains authorized |
| Two different admissions for one host, invite or join attempt | No silent collapse; reject sequential misuse or retain concurrent fork |
| B1 admission of D causally precedes B1 withdrawal | D remains established; old B1 withdrawal does not affect later B2 |
| C drops Y before X, loses all sync memory and restarts | Repeated manifests discover X and Y; ancestor-first transfer completes without an orphan queue |
| Source advances while manifest pages are read | Every page uses one snapshot; mixed/expired snapshot restarts without rollback |
| Complete manifest takes longer than 60 seconds with ongoing progress | Renew idle expiry; finish without a hard lifetime restart loop |
| Two ready conflicting continuations arrive | First processed complete compatible record is retained; no user chooser or automatic exit |
| All sources for dropped Y permanently disappear | Report inability to obtain history; never fabricate Y or claim complete recovery |
| Fresh D reaches stale C after inviter B goes offline | B's signed admission ancestry authenticates D without contacting B |
| Fresh joiner has no membership ID or accepted history | Join-mode TLS, token-authorized issuance ancestry, then signed join proof and redemption; no bootstrap cycle |
| Invitation's issuance frontier differs from the admission ancestry | Reject the recontextualized proof even when its author/attempt IDs match |
| Original issuer key is gone after an uncertain successful join | Public result recovery validates original signed admission; an untrusted negative never clears the attempt |
| Confirmation waits past expiry, issuer removal or a conflicting local change | Commit-time checks refuse admission without consuming the invitation |
| Removed generation or unknown key asks for general history/native content | Deny; only valid purpose-scoped admission/exclusion/departure proof is allowed |
| Necessary departure proof contains other members' records | Permit bounded management ancestry only, without promising field-level secrecy |
| Client offers TLS resumption after caller withdrawal, or endpoint presents a new key | Full authentication is required; no cached authorization or implicit key replacement |
| Completely offline self-exit; another member is also offline indefinitely | Exit is locally immediate; preserve each unconfirmed task and old key across restart |
| Two members both leave before receiving each other's exit | Expected-key recipientInactive acknowledgements retire only the corresponding known tasks |
| Original exit contains admission history conflicting with recipient | Verify recipient view and construct exact-old-generation rebase; do not import the old conflicting branch |
| Departure signer receives wrong Network, new generation or arbitrary payload | Refuse signing; accepted local history is unchanged |
| Recipient acknowledges another intent or uses a replacement key | Task remains unconfirmed; no global delivery claim |
| Fresh rejoin while old departure tasks remain | New generation/key operates independently; old tasks can only withdraw the old generation |
| Explicit fresh join into an incompatible branch | Select new verified admission history; retain old evidence/outbox without forcing its union into the new branch |
| Removed local generation leaves or joins again | No redundant sequential leave; detach idempotently and allow fresh confirmed admission |
| Admission/withdrawal races request admission | Serialization produces one of the specified before/after outcomes, never stale authorization |
| Two source hosts reuse a request ID; one source retries after rejoin | Distinct source scopes remain distinct; original source retry finds its retained receipt |
| Lost execution response, restart, merge or fork | Query original scoped receipt within retention; no new target, namespace or execution |
| Entry restarts and caller retries the same ID against another target | Durable outbound binding rejects redirect before dispatch |
| One native history item exceeds 1 MiB | Bounded result frames preserve the entire existing typed value and native cursor |
| Native update stream disconnects or its history context changes | Apply only complete transfers; reconcile and start a fresh snapshot without a durable stream log |
| Proof path attempts callback answer or receipt query | Deny, even if the old key once had operator authority |
| Unsupported version, quota exhaustion, disk-full or malformed stored state | Preserve accepted state; fail explicitly without reset, fork coercion or false success |
| Upgrade from each supported tagged source and interruption during migration | Preserve identities, receipt scopes and native recovery; never replay a callback or native request |

The membership engine, storage and Peer transport guides describe their implemented synthetic checks and remaining integration boundaries. Separate-machine acceptance and multi-node native execution remain work for their implementing issues; this protocol document alone does not establish those outcomes.
