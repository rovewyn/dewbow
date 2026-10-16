# Network storage, keys and crash recovery

Status: proposed implementation design, documentation only. This document refines the [Network design](network-design.md) and [Network protocol v1](network-protocol.md) for [issue #37](https://github.com/rovewyn/dewbow/issues/37). It does not create tables, generate keys, run migrations, allocate a storage version or expose Network operations. The current implementation and supported formats remain described by [management storage and compatibility](storage.md).

## Ownership and identity

Every node independently owns its selected state directory, keys and one live `daemon.sqlite`. There is no shared database, central key service, privileged creator or Network master key. Any active member can admit another node or remove an exact member generation, including itself; the membership engine decides validity under the protocol.

Preserve `config.json` and its existing `hostId`, local control credential and native configuration. A state directory identifies a Dewbow node, not physical hardware. Copying it can clone that identity; this design does not detect a secretly cloned directory. Every new genesis or admission uses a fresh Ed25519 key. Rejoining retains `hostId` but changes the key and `membershipId`. A key identifier is only a private local file locator and is never a membership credential.

```text
<state-dir>/
  config.json
  daemon.sqlite
  network-keys/
    <keyId>.pk8
    <anotherKeyId>.pk8
```

The existing `records(kind, id, data)` table retains its released local operation identities and management semantics. Add the Network tables below to the same database through a future reviewed migration. Native conversations, credentials, history, tool output and completed native turn status remain owned by Codex. Neither private key files nor inactive upgrade backups are additional live databases.

## Schema notation and constraints

The following field lists specify the proposed logical layout, not executable migration DDL. `PK` means primary key, `FK` means a same-database foreign key and `?` means nullable. Fields are required unless marked nullable. SQL names use lowercase plural table names and snake_case columns; stored JSON uses camelCase.

- Store protocol digests, nonces, invitation IDs, attempt IDs, operation IDs and raw public keys as fixed 32-byte `BLOB` values. Check type and length. Decode canonical base64url at the protocol boundary; preserve protocol ordering by decoded bytes.
- Keep existing `hostId` values as canonical UUID text. Local `selection_id`, `key_id` and conflict `witness_id` are new random UUID text. Request, command, session and turn IDs keep their existing contract representations without normalization or prefixes.
- Use nonnegative integers for counts and retry counters, checked enumerations for states, and UTC text for local timestamps. Persist signed timestamps exactly as encoded by the protocol. Local scheduling timestamps do not authorize membership or extend a signed lease.
- Store signed objects as canonical JSON, retaining the complete body and signature. Indexed copies of signed fields must match the signed object. Reject malformed JSON, unexpected fields, invalid signatures, inconsistent references and unsupported formats before writeback.
- Enable and verify foreign-key enforcement on every write connection before transactions. Use restrictive references, not cascading deletion of history, receipts or recovery evidence. Validate invariants that span tables under the same admission/write serialization boundary.
- Do not impose global SQL uniqueness on foreign history's host IDs, member public keys, invitation IDs or operation intents. Different retained selections can contain incompatible alternatives. Their validity and compatibility are membership-engine decisions, not an excuse to overwrite or collapse records.

`network_records` contains accepted history only. Incomplete incoming records, foreign proof-session views, confirmation prompts, connection authority, synchronization cursors, reachability observations, callback details and content buffers are not durable grants. A bounded conflict witness is a separate evidence cache, not accepted history.

## Core tables

| Table | Primary key | Other columns |
| --- | --- | --- |
| `network_settings` | `singleton_id INTEGER`, constrained to `1` | `current_selection_id TEXT? FK network_selections`, `listen_endpoint TEXT?`, `advertised_endpoints_json TEXT` |
| `network_selections` | `selection_id TEXT` | `network_id BLOB FK network_records`, `local_membership_id BLOB FK network_records`, `key_id TEXT FK network_keys`, `status TEXT`, `frontier_json TEXT`, `history_id BLOB`, `record_count INTEGER`, `created_at TEXT` |
| `network_records` | `record_id BLOB` | `network_id BLOB`, `kind TEXT`, `envelope_json TEXT` |
| `network_keys` | `key_id TEXT` | `public_key BLOB UNIQUE`, `format_version INTEGER`, `storage_status TEXT`, `created_at TEXT` |

`network_settings` is one local configuration row, not a Network-wide setting or coordinator. A null current selection means no selected history. A retained left/removed selection may remain current until a fresh confirmed join replaces it. Listening/address settings are local configuration and convey no membership authority.

`network_selections.status` is `active`, `left` or `removed`. Enforce at most one `active` row with a partial unique index. An active row must be the current selection, refer to the local host's exact active generation and a present matching key. Joining progress lives in `network_join_attempts`; it is not an active selection. New creation/join requires no active membership. A possibly submitted join must retain its recovery obligation; a definitely unsent attempt terminated as `expired` does not block a new request. Derive the protocol's local `none`/`joining`/`active`/`left`/`removed` display state from these associations, without treating an uncertain join as business-ready.

Each selection's complete accepted set is the ancestor closure of its retained frontier. `history_id` and `record_count` must match that set, including genesis. Reconstruct members from it. Never union all rows with the same `network_id`: the store can retain incompatible histories from earlier explicit selections. Normal adoption extends only the current selection. A fresh locally authorized and issuer-confirmed admission may replace an inactive selection after independent complete validation; it preserves the old frontier, records, receipts and departure tasks.

`network_records` is immutable. An existing ID must resolve to the same canonical signed record; invalid or differing input cannot replace it. Genesis uses its own record ID as `network_id`. Validate this relationship before commit rather than depending on a cyclic genesis foreign key. No accepted-history compaction, deletion or count/age expiry is part of v1.

`network_keys.storage_status` is `present`, `deletePending` or `deleted`. Keep deleted-key metadata so historical associations retain their public binding; `deleted` means the private file is no longer required or loaded. Authority comes from verified selection/attempt/departure associations, not the presence of a file or the storage-status column. Local private-key metadata may require a unique public key because conforming local generation never reuses a key; that restriction does not apply to foreign records.

Index records by `(network_id, record_id)` and selections by `(network_id, status)`. No independent authoritative member-state table is introduced. A future derived index must remain rebuildable and cannot overrule signed history.

## Invitations and local management requests

| Table | Primary key | Other columns |
| --- | --- | --- |
| `network_requests` | `request_id TEXT` | `operation TEXT`, `fingerprint BLOB`, `operation_id BLOB?`, `selection_id TEXT? FK network_selections`, `status TEXT`, `result_refs_json TEXT`, `created_at TEXT` |
| `network_invitations` | `(issuer_membership_id BLOB, invitation_id BLOB)` | `public_invitation_json TEXT`, `secret BLOB?`, `expires_at TEXT`, `status TEXT`, `consumed_attempt_id BLOB?`, `created_at TEXT` |
| `network_join_attempts` | `(role TEXT, issuer_membership_id BLOB, join_attempt_id BLOB)` | `invitation_id BLOB`, `local_request_id TEXT? FK network_requests`, `host_id TEXT`, `public_key BLOB`, `key_id TEXT? FK network_keys`, `invitation_json TEXT`, `credential_secret BLOB?`, `fingerprint BLOB`, `join_proof_json TEXT?`, `status TEXT`, `result_record_id BLOB? FK network_records`, `created_at TEXT` |

`network_requests` accounts for private local Network management intents, separately from released native-operation receipts. The fingerprint binds the operation and semantic input. Preserve the original intent ID and exact signed result references before reporting success. Retrying a changed input conflicts. Result JSON contains result codes and necessary IDs, not a member-list snapshot, pending prompt, native content or duplicate bearer secret. Issuance retries reconstruct the same live invitation from its protected invitation row or return its consumed/expired status.

`network_invitations` is issuer-local accounting; its public invitation contains the signed issuance frontier and history commitment. `status` is `live`, `consumed` or `expired`. At consumption, bind exactly one attempt to the exact accepted admission. Keep that successful binding with accepted history even after expiry or issuer exit. Null the issuer secret after successful consumption or expiry. Public history contains no bearer secret.

`network_join_attempts.role` is `joiner` or `issuer`. A joiner row retains the stable issuer/invitation/attempt/host/key binding before any exchange. Store the public invitation and, while needed for unresolved redemption, its private credential separately. `join_proof_json` is initially null and is filled once after complete issuance-context verification; its fields must agree with the retained binding. A supplied issuer-membership claim can be unknown during bootstrap and therefore is not an accepted-history FK until validated.

Joiner states are `prepared`, `proofReady`, `uncertain`, `admitted`, `denied` or `expired`; none alone grants business authority. `prepared` retains the key/attempt but no join proof. Commit `proofReady` with the exact verified join proof, retained locally without disclosing it to another node. Both states prove no redemption request has been sent: under the same attempt serialization boundary, commit `uncertain` before any possible `redeemInvitation` send, including a retry or queued send. Do not otherwise expose the join proof before that commit. If the commit fails, do not send. A crash after the commit remains uncertain even if no byte actually left the node.

An invitation reaching its retained `expiresAt` on the local clock may terminate only a still-`prepared` or `proofReady` attempt as `expired`. This is a local cutoff for a proven unsent intent, not a claim that the issuer rejected it or that signed history expired. Serialize expiry against the transition to `uncertain`; expiry cannot terminate an attempt that won that transition. Atomically retain the expired attempt and original local request's terminal result, and clear its credential. The key becomes eligible for the existing reference-checked deletion process, not immediate file deletion. Retrying the original `requestId` returns that expired outcome without reopening the attempt or generating a key. A new request and valid invitation can start a fresh attempt with a fresh key.

Once `uncertain`, keep the same attempt, key and proof until the original result is resolved under the protocol. Invitation expiry, an untrusted negative, an unavailable issuer or a missing result cannot turn it into `expired`, discard the key or authorize a fresh attempt. On verified admission, transactionally select the complete admission history. `denied` remains an explicit issuer denial, distinct from local expiry. Retain only public proof for restricted result recovery once bearer redemption is resolved; do not send the invitation secret over public recovery. This refinement adds one joiner status and no table, column, cancellation state or cancellation operation.

Issuer rows record terminal `admitted` or `denied` outcomes. Pending confirmation remains volatile and is requested again after restart if no terminal result exists. A denial retains its fingerprint/outcome at least until invitation expiry without consuming the invitation. An admitted result must match the consumed invitation and immutable record. Serving retained signed admission bytes does not require the exited issuer's old private key.

Index live invitations by `(status, expires_at)` and attempts by `(role, invitation_id, status)`. Cross-table checks enforce the consumption/result relationship. Do not make an uncertain join reusable merely because its invitation expired. Protected secret-field cleanup is logical deletion; WAL pages and private backups are not promised secure erasure.

## Departure outbox

| Table | Primary key | Other columns |
| --- | --- | --- |
| `network_departures` | `departure_record_id BLOB FK network_records` | `network_id BLOB`, `membership_id BLOB FK network_records`, `operation_id BLOB`, `key_id TEXT FK network_keys`, `created_at TEXT` |
| `network_departure_tasks` | `(departure_record_id BLOB FK network_departures, recipient_membership_id BLOB)` | `recipient_host_id TEXT`, `recipient_public_key BLOB`, `contact_candidates_json TEXT`, `status TEXT`, `retry_count INTEGER`, `next_attempt_at TEXT?`, `acknowledgement_json TEXT?` |

Exit atomically stores the signed departure, its immutable intent, one task for each other active generation in the pre-exit selection, and the inactive local selection. It immediately disables ordinary authority. Leaving an already removed/inactive selection is idempotent detachment without another signed record or new tasks. Removing somebody else stores the accepted removal and local intent result; the membership protocol propagates it without borrowing the target's key.

Tasks are `pending`, `confirmed` or `abandoned`. They bind the recipient's exact generation and expected key, not an address or merely a host ID. Retain only bounded signed hints/known endpoints for those fixed destinations. A proof cannot add destinations, replace the recipient key or turn a newer admission into the withdrawal target.

Index pending tasks by `(status, next_attempt_at)`. Pending tasks do not expire and retry only while the daemon runs. A verified `absent` or `recipientInactive` acknowledgement confirms only its bound destination. Another member's confirmation never retires it. Explicit local forgetting may mark a task abandoned while reporting the destination remains unconfirmed; it cannot be silent expiry.

For incompatible recipient contexts, obtain and verify a transient complete proof view, then construct only the protocol's exact-old-generation self-withdrawal. Derive its stable rebase intent ID as specified by the protocol. The original departure ID remains the task identity. Never select or durably archive the foreign proof view, sign a remote-provided body or give the retained key a generic signing/management API.

After confirmation, retain the verified acknowledgement and terminal task outcome. Transient proof buffers are released. Old tasks survive a fresh join and keep using only the old key; they cannot affect the new generation.

## Remote request bindings and receipts

| Table | Primary key | Other columns |
| --- | --- | --- |
| `network_outbound_requests` | `(network_id BLOB, source_host_id TEXT, request_id TEXT)` | `target_host_id TEXT`, `operation TEXT`, `fingerprint BLOB`, `dispatch_state TEXT`, `result_ref_json TEXT?`, `created_at TEXT` |
| `network_request_receipts` | `(network_id BLOB, source_host_id TEXT, request_id TEXT)` | `target_host_id TEXT`, `operation TEXT`, `fingerprint BLOB`, `command_id TEXT UNIQUE`, `receipt_json TEXT`, `recovery_refs_json TEXT?`, `created_at TEXT` |

The outbound row belongs to the entry; the receipt belongs to the original execution node. They are local responsibilities, not a replicated receipt database. Neither key includes a membership generation, history snapshot, runtime instance or connection ID. Existing local `records` receipts keep their original keys and fingerprints; never manufacture prefixed legacy request IDs for peers.

Before first dispatch, bind the tuple to the original target, operation and semantic input fingerprint in a committed transaction. Outbound states are `prepared`, `uncertain` or `settled`. Persist `uncertain` before any possible business send. A crash after that marker is conservatively uncertain even if no byte was sent. Repeated input/target conflicts are rejected locally before another dispatch. A confirmed pre-admission refusal can settle the current attempt, but never remove its original-target binding.

Target admission serializes current caller/target generation checks, native session admission and receipt creation. Commit its receipt before native action. Fingerprints cover original target, operation and semantic input, excluding refreshable authentication/history context. Recovery associations use the full receipt scope or internal `command_id`, not an unscoped request-ID lookup. Native work is never reconstructed from a fingerprint or automatically replayed after restart.

`receipt_json` is the existing delivery-outcome shape, not completed native execution history or a second content record. `recovery_refs_json` contains only minimum active/uncertain native associations and is cleared when resolved. The entry retains only result references/delivery information, not native output, callback bodies or a second target receipt authority.

Retain Network outbound bindings and receipts indefinitely in this v1 storage proposal, exceeding the peer protocol's 24-hour minimum. Existing local receipts retain their separate policy: settled receipts become eligible for cleanup after at least 24 hours, while uncertain or active recovery remains protected. Network rows do not participate in that local cleanup. A later bounded Network cleanup policy requires a separate compatibility review and atomic cleanup of required routing/receipt relationships. A null receipt or inaccessible target is not proof of nonexecution.

Index outstanding outbound work by `dispatch_state`; index target recovery by the retained internal command/session/turn associations. Integrating remote execution must update recovery code to respect the new scope without rewriting released local IDs or introducing a duplicate native action.

## Contact candidates and conflict evidence

| Table | Primary key | Other columns |
| --- | --- | --- |
| `network_contacts` | `(network_id BLOB, membership_id BLOB, endpoint TEXT)` | `explicit_seed INTEGER`, `signed_hint_json TEXT?`, `last_success_at TEXT?` |
| `network_conflicts` | `witness_id TEXT` | `network_id BLOB`, `reason TEXT`, `evidence_json TEXT`, `byte_count INTEGER`, `created_at TEXT` |

Contacts are bounded connection candidates keyed to an exact member. Persist explicit seeds, current signed hints and necessary last-known addresses, not unverified failed-peer data. Keep at most eight candidate endpoints per member. Lease freshness and nonce tracking are runtime state; after restart treat retained hints as stale candidates and do not recreate their previous lease or cached authorization. Always reauthenticate the expected key before credentials or business traffic.

Conflict evidence contains verified conflicting IDs, reason, signatures/bindings and only necessary ancestry not already retained. Apply the protocol's default 64-witness/16-MiB budget and oldest-witness eviction. Eviction changes no accepted record, selected history or permission. Evidence is not an orphan queue, permanent incomplete-record blacklist or additional selected history. Reconstruct observed reachability and sync/proof cursors instead of persisting them.

## Key encoding, permissions and capabilities

Use newly generated Ed25519 member keys encoded as unencrypted PKCS#8 DER, following [RFC 8410 private-key encoding](https://www.rfc-editor.org/rfc/rfc8410.html#section-7). `format_version` describes the local key container/reader, independently of product, protocol and database versions. This design selects no crypto/TLS library or dependency version.

Protect the parent state/key directories and every file before writing private bytes:

- POSIX directories use mode `0700`, private key files use `0600`, and ownership must match the selected local account.
- Windows uses a protected ACL granting the current account and SYSTEM, without broader inherited access.
- Reject symlinks, reparse-point/path substitution and nonregular files. Derive the path only from a validated local key UUID; never accept an arbitrary stored or caller-supplied path.
- Derive the public key on load and compare it with metadata and the exact selected/retained binding. Reject mismatches, malformed files and unsupported containers. Never silently generate a replacement key under an existing binding.
- Private bytes, invitation credentials and local control credentials never enter shared records, logs, URLs, browser storage or public result JSON. Secret buffers have bounded owners/lifetimes and are released when their use ends.

This permits unattended daemon restart without a master password or external owner credential. It protects against unrelated local accounts through filesystem access control; it does not protect against an administrator or code already able to read the same account's private files. Do not claim at-rest encryption. Any later OS keystore backend needs its own versioned recovery/backup design.

An active member key is usable only with current validated membership. A joining key is limited to its retained attempt. A retained departure key can authenticate restricted delivery, sign locally constructed acknowledgements and withdraw only its own exact old generation. It cannot admit members, remove another generation, read native content/receipts or execute business requests. Enforce these capabilities in the daemon interface, not through filenames. No permanent creator key or Network CA becomes a source of authority.

## File and database crash consistency

All operations run under exclusive ownership of the selected daemon state. Never admit requests while a storage migration leaves global state unresolved. An unresolved individual key transition blocks its dependent capabilities, not unrelated valid work under another key. Require successful file/database durability steps before reporting success; failure preserves evidence and refuses the affected transition.

### Create before reference

1. Generate a fresh key and local key ID. Create a unique private file without overwriting another key; incomplete temporary output is never a usable key.
2. Write and validate its PKCS#8 bytes, flush the file and complete the platform's required durable publication/directory steps. Publish only to its unique final name; do not use an update helper that deletes an existing key before replacement.
3. Commit the key metadata and stable genesis/join-attempt association in SQLite. A signed public genesis/admission result is not reported before its associated record/selection transaction commits.
4. Permit external key use only after the required metadata/attempt commit. Before redemption retain the exact verified join proof and commit `uncertain` before any possible redemption send.

The safe failure residue is an unreferenced private file, never a committed reference to an incompletely published key. Do not load or dispatch from such a file. Quarantine incomplete/unreferenced output and clean it only after validating committed state and resolving all migration/key transactions; ambiguous restored state is not grounds for deletion.

### Keep files stable during ordinary transitions

Exit, exclusion and fresh selection change database associations and capabilities without renaming or overwriting key files. Old and new keys can coexist while old departure tasks or uncertain admission need them. A missing old key does not cancel tasks or prove remote withdrawal; another active member may need to remove that generation.

### Delete after releasing requirements

1. Under serialization, prove there is no active selection, unresolved joining/recovery requirement or pending departure task needing the key. Preserve public bindings and terminal results.
2. Commit `storage_status = deletePending`; this disables loading/signing with that key and prevents new dependent work. Do not allow a task to become pending again under it.
3. Delete the file, complete the required filesystem persistence steps, then commit `storage_status = deleted`. Resume a pending deletion idempotently after restart.

File deletion does not erase copies in backups, WAL/free pages or old storage media. Backups containing keys and invitation secrets require the same privacy boundary. Restoring an older private snapshot cannot prove current membership, remove unseen withdrawals or safely recreate lost execution receipts.

### Recovery outcomes

| Durable observation after interruption | Required recovery |
| --- | --- |
| Key file exists without a committed metadata/attempt reference | Do not use it; validate/quarantine as above, without creating a new identity from it |
| Join attempt is `prepared`, with no retained proof or redemption send | Resume issuance-proof acquisition while the invitation is usable, or atomically terminate as `expired` at the local cutoff; no join proof is needed to end a proven unsent attempt |
| Join attempt is `proofReady`, with no committed uncertainty marker | Resume the original proof-ready attempt or atomically expire it; commit `uncertain` before any possible redemption send |
| Join attempt is `uncertain`, including a crash before actual send | Recover the original result with the same attempt/key/proof regardless of invitation expiry; do not infer denial, expire it or issue a fresh attempt |
| Join attempt and original request have committed `expired` | Return the retained expired outcome on old-request retry; allow a new request and valid invitation, and clean the old key only through existing reference checks |
| Admission committed at issuer but reply lost | Return the original signed admission on exact authenticated retry; preserve consumed accounting |
| Pending confirmation lost on restart | Ask the issuer's operator again unless a retained terminal result already decides the attempt |
| Exit and tasks committed, reply or delivery lost | Keep local ordinary authority disabled and retry the exact old-generation tasks |
| Key is `deletePending`, with file present or absent | Finish deletion idempotently; never restore signing authority |
| A required present key is missing or mismatched | Block its use and report recovery required; preserve unrelated state, tasks and uncertain outcomes |
| Outbound state is uncertain or target receipt acknowledgement is missing | Keep original target/scope/fingerprint; query or accept caller-resupplied identical input under normal admission, without automatic replay |
| Disk full, unsupported container or malformed retained association | Refuse the affected mutation without resetting state, dropping evidence or claiming success |

## Atomic database operations

Expose transaction-level storage operations, not a sequence of independently committed generic row writes:

| Operation | Commit together |
| --- | --- |
| Create Network | Genesis, initial selection/frontier, current pointer, key association and local intent result |
| Adopt complete compatible changes | Accepted records, updated frontier/commitment/count, local exclusion status when applicable and relevant intent result |
| Admit a member | Accepted admission, invitation consumption, terminal issuer attempt, updated selection and exact retry result |
| Prepare local join redemption | Exact retained proof and `uncertain` attempt state before any possible redemption send; serialize against unsent-attempt expiry |
| Expire an unsent local join | `expired` attempt, original local request's terminal result and credential cleanup; reuse existing key deletion rules |
| Finish a local join | Complete accepted admission history, terminal joiner attempt, new selection/current pointer and result; preserve inactive history/outbox |
| Exit active membership | Signed departure, frozen post-exit selection, original intent, fixed recipient tasks and local result |
| Remove another member | Exact accepted removal, updated selected history and local result; no target key or consent |
| Prepare remote dispatch | Original target/input binding before send; uncertain marker before any possible dispatch |
| Admit native action | Scoped target receipt and necessary active/uncertain recovery association before native action |
| Confirm one departure destination | Verified matching acknowledgement and only that task's terminal status |
| Begin/finalize key cleanup | Required reference checks and the corresponding storage-status transition |

Record verification and membership selection share the serialized adoption boundary with these commits. The storage layer does not independently decide branch compatibility. A failed transaction leaves the previous accepted state intact. SQLite constraints supplement complete protocol and relationship validation rather than replacing it.

## Migration and rollback boundary

Before implementation, audit supported published tags and the target release's [release notes](release-notes/README.md), then choose the next storage format and exact executable DDL/indexes. This document assigns neither a schema integer nor a product version and does not broaden the existing support window. Extending tables, durable JSON or recovery scope requires format review even if the local management API remains `v1`.

1. Acquire exclusive lifecycle ownership and verify that the previous daemon and its owned native runtime have stopped. Validate the full source format before write PRAGMAs or transformations; preserve malformed, unknown and future state without rewriting its version.
2. Retain a private, consistent recoverable backup, including WAL-backed database state, configuration and any key files already required by a supported source. An inactive backup is not another runtime store.
3. Apply ordered migrations transactionally, committing `user_version` with matching data changes. Preserve `records` identities, frozen configuration, fingerprints, receipts and uncertain native associations. Adding Network support alone does not require changing existing `config.json` fields or generating a key for an unjoined node.
4. If a supported transition changes configuration or key files, use an explicit durable upgrade transaction/journal across files. On restart, determine commit/rollback from that transaction, not file timestamps or a guessed fresh-state fallback.
5. Validate target relationships and required key/public bindings before admitting requests or starting native work. Rebuild members from each retained selection, reconstruct volatile connections/proof state and resume retained departure/result recovery conservatively.
6. Align updater source/target schema admission and rollback metadata. Automatic pre-commit restoration requires a verified consistent source snapshot. After new work is accepted, never restore a snapshot that loses its receipts or revives older membership authority; refuse unsafe rollback or preserve current compatible management state through a documented procedure.

Migration never rewrites native Codex storage or replays a callback/request. Copying a state directory or restoring a backup is not keyless owner recovery and does not reconcile undiscovered history. Key loss/replacement requires withdrawal and fresh confirmed admission as specified by the protocol.

## Implementation boundaries and acceptance

Issue #37 establishes protected key storage, the reviewed schema/migration and transaction-level persistence contracts. The membership engine in #38 supplies complete validated changes; #39 connects peer synchronization; #40 exposes lifecycle operations; #42 integrates remote request execution. These storage contracts do not make any unfinished peer or public operation available. Keep unimplemented admission paths closed.

Future implementation acceptance must cover:

- Supported tagged-format synthetic fixtures preserve host/session/native IDs, local receipt keys and fingerprints, frozen configuration and active/uncertain recovery associations; fresh-install tests alone are insufficient.
- Invalid/future databases and key containers are rejected without mutation. Startup verifies selected-history closure, commitments, current/active uniqueness, invitation/result relationships, exact key bindings and full receipt scopes before admission.
- Interruptions at file publication, key-reference commit, join response loss, exit commit, task confirmation and both deletion phases produce the recovery outcomes above without duplicate membership actions or restored authority.
- Invitation consumption/admission are atomic; exact terminal retry works after expiry/issuer exit; denial and restart do not silently approve a pending prompt.
- A crash in `prepared` before proof acquisition, or in `proofReady` before submission, can reach local `expired` without blocking a new request. A crash after committing `uncertain`, before actual send or after issuer admission with a lost reply, retains original-result recovery and cannot expire. Old-request retry returns the same terminal expired outcome; expiry/send races have one serialized winner and cleanup obeys existing key references.
- Offline self-exit survives restart; tasks bind exact recipients, do not expire, and survive a new generation/Network selection. Recipient replacement cannot confirm an old task.
- Different source hosts may reuse a request ID; the original source's rejoin/restart finds its original receipt. A target/input redirect conflicts before dispatch, including after entry restart. No missing acknowledgement is converted into nonexecution or replay.
- Old/current keys coexist with restricted capabilities; deleted or malformed keys cannot be silently replaced. Backups and unreferenced files do not become automatic membership recovery.
- Migration interruption, repeated startup, WAL-consistent backup and updater pre-commit recovery preserve supported state. Post-commit work prevents unsafe snapshot restoration.
- No content archive, incomplete-record staging queue, durable callback body, second live database or global member-state authority is introduced.

Documentation validation checks consistency, local links and whitespace only. No migration, key-permission, crash-injection or multi-node runtime acceptance is claimed by this design update.
