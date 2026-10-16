# Management storage and compatibility

Dewbow keeps one live management database per [state directory](operations.md#state-directory). Codex remains the durable authority for native conversation history, content and execution status. The storage boundary in [AGENTS.md](../AGENTS.md#database-ownership-boundary) continues to apply when adding upgrade support.

## Version identifiers

Product, API and database versions describe different compatibility boundaries:

| Identifier | Current representation | Meaning and evolution |
| --- | --- | --- |
| Product version | SemVer in the root `Cargo.toml`, synchronized to workspace manifests and lockfiles | Identifies the complete executable release; changes for each product release |
| Management API contract | String `v1`, declared by the protocol package and included as `contractVersion` in session update snapshots | Defines operation names, request/response fields, errors and event semantics; compatible additions can retain the version, while breaking changes need a coordinated transition |
| Management database schema | Integer `2` in SQLite `PRAGMA user_version`, represented as `upgrade.stateSchema` in release metadata | Identifies SQL structure and durable JSON/identity semantics; supported source formats require ordered migrations |

These identifiers do not advance together. Product version `0.2.0` uses API contract `v1` and database schema `2`. See [API contract version](interfaces.md#contract-version) for the HTTP boundary and [release notes](release-notes/README.md) for supported source releases and approved transition exceptions.

Startup accepts an empty unversioned database, the exact supported schema `1`, or schema `2`. It validates source configuration, schema and management records before write PRAGMAs, initializes empty state transactionally, and migrates supported state under exclusive daemon ownership before native startup. Unknown, malformed and newer formats are preserved and rejected. Private configuration and upgrade-transaction tags are checked independently.

## Current management model

The [store](../apps/daemon/src/store.rs) uses `records(kind, id, data)` with a primary key on `(kind, id)`. SQL names use snake_case; `data` is JSON with camelCase fields. Durable writes project an allowlist, while runtime objects may contain additional volatile fields.

| Record | Retained purpose | Upgrade invariant |
| --- | --- | --- |
| `session` | Management/native IDs, working directory, resolved creation configuration, creation time and active management turn ID | Keep native associations and frozen execution policy; do not silently adopt another thread or change its settings |
| `operation` | Request and command IDs, operation, input fingerprint, target associations, delivery status, creation time and error | Preserve the receipt and input-conflict check throughout the retry window and while required for recovery |
| `turn` | Only active or unresolved turn IDs, request/session/native associations, mode and creation time | Reconcile with Codex after restart; a missing callback or stopped runtime does not prove completion |
| `meta/owner` | Owned native PID | Check ownership and process exit before migration or restoration |

The stable host ID and private daemon settings are in `config.json`. They belong to the same upgrade boundary as the database. Pending interaction bodies, answers, callback identities, live content and event buffers stay in memory. Migrations must not reactivate old callbacks or copy historical command output into the management store.

Keep this small management model; a second live database or a table redesign is not required merely to introduce migrations. The SQLite schema includes the semantics of JSON fields and fingerprints, not just table definitions. Changing the durable allowlist or input normalization can require a format change even when the SQL table is unchanged.

## Network storage foundation

Schema `2` keeps `records` unchanged and adds thirteen management tables in the same connection and transaction boundary:

| Tables | Retained purpose |
| --- | --- |
| `network_settings`, `network_selections`, `network_records` | One current local selection, inactive selections and complete accepted signed history |
| `network_keys` | Public key bindings and local key-file status; no private bytes |
| `network_requests`, `network_invitations`, `network_join_attempts` | Stable local intent/results, invitation accounting and original admission recovery |
| `network_departures`, `network_departure_tasks` | Exact old-generation withdrawal and fixed destination tasks |
| `network_outbound_requests`, `network_request_receipts` | Original routing/input binding and scoped target delivery/recovery receipts |
| `network_contacts`, `network_conflicts` | Bounded connection candidates and conflict evidence without membership authority |

The [DDL](../apps/daemon/src/network/schema.sql) enforces types, identifier lengths, enums, foreign keys and a single active selection. Startup reconstructs each selection's complete frontier closure with the [membership engine](network-membership-engine.md), checks its commitment/count, and validates key, invitation, attempt, receipt and departure relationships. There is no independent authoritative member table or incomplete-record queue. Ordinary adoption updates only the current compatible selection; old inactive history remains evidence.

The repository exposes atomic Rust persistence operations for future peer/lifecycle adapters. These commit selected records, result references and outbox/receipt associations together. They do not expose Network CLI commands, Web routes, peer listeners or native execution. Future adapters must acquire the daemon's normal admission/maintenance gate and authenticate the exact member generation before calling them. The adapter must calculate fingerprints from the actual normalized input.

Member keys are fresh Ed25519 PKCS#8 DER files under `network-keys/<keyId>.pk8`, protected by the local OS account: POSIX 0700/0600 and ownership checks, or a protected current-account/SYSTEM Windows ACL. This is filesystem protection, not encryption. Publication flushes private bytes and filesystem metadata before a database reference commits. Loads reject links, unsupported/mismatched containers and broader permissions. No key is generated for an unjoined node, and no missing key is silently replaced. Unreferenced staged/final files are quarantined without granting authority.

Key cleanup commits `deletePending` after reference checks, durably removes the file, then commits `deleted`. Restart resumes both deletion phases, including the POSIX two-name hard-link interruption window. A different unexpected file is preserved for recovery. A cleanup failure leaves the affected key disabled and emits a private diagnostic; it does not stop unrelated valid work. Active keys sign membership changes; retained keys expose only locally constructed old-generation departure/restricted acknowledgement operations. Terminal results and public bindings survive cleanup.

Joiner states are `prepared`, `proofReady`, `uncertain`, `admitted`, `denied` and `expired`. The exact proof remains private until `uncertain` commits under the same serialization as expiry, before any possible redemption send. Only definitely unsent `prepared`/`proofReady` attempts can expire. That transaction clears the credential and settles the original request; an old retry remains expired, while a new request can create a fresh attempt/key. Once uncertain, timeout, invitation expiry or transport failure cannot infer denial or permit a replacement attempt. Only the authenticated original issuer's terminal result may settle it. Pending operator confirmation stays volatile.

Self-exit commits local inactivity and one nonexpiring task for every other pre-exit active generation. Tasks survive restart and a new selection. Only the expected recipient key's correctly scoped acknowledgement settles its task. Retained foreign proof views stay transient, and old keys cannot acquire ordinary authority under the new selection.

Default Network verification working memory is 16 MiB; set the positive byte count `DEWBOW_NETWORK_WORKING_BYTES` when retained complete history requires more. The budget can refuse an operation or startup without truncating accepted history. Contact candidates are limited to eight per member; conflict witnesses are limited to 64 entries and 16 MiB with oldest-witness eviction. Neither cache authorizes membership. Retained signed contact hints restart as stale connection candidates.

## Required evolution process

1. Identify supported source releases by their tagged formats. Distinguish an empty new database from an unversioned released journal by its complete known structure; version `0` alone is not enough.
2. Inspect schema versions, table definitions and required record shapes before initialization or writeback. Reject unsupported and future formats without initializing their schema, dropping data or setting their version to the current one.
3. Acquire exclusive lifecycle ownership and verify daemon/native exit. Retain a private, consistent backup before changing state. Include WAL data and all Dewbow files needed to restore the supported source release.
4. Run ordered migrations with atomic commits or an explicit crash-recovery transaction across files. Update `user_version` only when the matching data transformation commits. Reopening after interruption must finish or safely recover without applying a transformation twice.
5. Preserve management identities, resolved configuration, original fingerprints, receipts required by the retention policy and unresolved execution relationships. Transform only the required management fields. Do not change native Codex storage or introduce duplicate content/event storage.
6. Validate the migrated relationships before admitting requests, then reconcile native execution state. Keep delivery unknown when the retained evidence is insufficient. Validate every supported upgrade source, not just a fresh install.

Product SemVer, public management contract `v1`, SQLite schema versions and private upgrade-transaction formats serve different purposes. They must be reviewed together, without using one as proof that the others are compatible. Removing support for a released format needs an explicit support-window decision and an upgrade path.

## Validation and retention

- **Version validation:** only an empty, unversioned database may be initialized. Existing databases must have an exact supported schema and expected objects/constraints. Unknown versions, extra schema objects and malformed tables are rejected before write PRAGMAs or initialization. Migration and its version marker commit together.
- **Record validation:** startup and upgrade checkpoint inspect all persisted records before writeback. Required fields, record-key identities, types, frozen configuration and receipt status/fingerprint shapes are checked. A missing native turn ID remains a valid unknown-acknowledgement state and is reconciled conservatively. Unknown fields or record kinds are rejected rather than silently stripped. Invalid records return a recovery error without exposing their contents or modifying their data.
- **Receipt retention:** retained receipts are loaded into memory on startup. The daemon applies the bounded policy below to SQLite and its memory projection together; history reads never trigger cleanup or storage writes.

Storage regression tests protect rejection without modification and retention of frozen configuration and uncertain receipts. Lifecycle tests cover restart and deduplication within the current format. These checks do not establish compatibility with a different persisted format; validate each supported migration separately.

## Receipt retention

Local request deduplication lasts at least 24 hours from the server's first acceptance time (`operation.createdAt`) within the same state directory. An identical operation and input returns the retained receipt, and changed input under that ID returns `REQUEST_CONFLICT`. Restart preserves the original timestamp and does not start a new window. Request IDs remain client-chosen strings; there is no expiry token or automatic rejection of an old request.

Network outbound bindings and target receipts use `(networkId, sourceHostId, requestId)` and are retained indefinitely. Local receipt cleanup never visits these tables. Membership generation, selection or daemon restart cannot redirect a retained uncertain request to a different target. Different source hosts can reuse a request ID. No input body, native output or completed-turn history is retained by these Network receipts.

Only receipts with a known delivery outcome (`delivered` or `error`) and an acceptance time at least 24 hours old are eligible for cleanup. Keep `accepted` and `unknown` receipts regardless of age. Also retain receipts associated with an active or unresolved turn, that turn's original request, or a retained runtime callback. A delivered command can still have an active turn, so delivery alone is insufficient. Unparseable or future timestamps are retained conservatively. Recovery records and managed session bindings are not removed by receipt cleanup.

The daemon cleans once after startup recovery, then every 24 hours while running. Its own timer stops with the runtime and skips missed ticks rather than running a backlog. Cleanup is serialized with request admission; upgrade maintenance blocks new cleanup and waits for any admitted cleanup before checkpointing. A skipped maintenance pass waits until the next daily tick or restart. Without such delays, eligible settled receipts are normally retained for about 24–48 hours. The guarantee remains 24 hours, and protected receipts can remain longer.

Cleanup deletes eligible SQLite rows in one transaction, then removes the same rows from memory while holding the store locks. A failure before commit retains the receipts; an interruption after commit reloads the committed set on restart. There is no additional database or request tombstone. Once a receipt has been removed, the same request ID can be admitted as a new operation and may execute again, even with the original input. Clients should reconcile an old outcome before deliberately submitting it again; absence of a receipt does not prove that it never executed.

The local retention window and daily cadence are fixed; there is no user-configurable TTL or cleanup command. SQLite row deletion makes space reusable but does not promise that the database file immediately shrinks. Routine cleanup does not run `VACUUM` or change the schema version. Uncertain delivery can still accumulate and requires recovery rather than automatic age-based deletion.

## Rollback and release evidence

The current [upgrade transaction](../apps/cli/src/transaction.rs) checkpoints the current database, snapshots configuration and management state, seals admission during candidate startup, and allows automatic restoration only before durable commit. Preserve those safeguards. Inactive upgrade snapshots and retained failure copies are private recovery artifacts, not additional live databases.

The updater admits only manifest contract `v1`, target state schema `2` and `rollbackSafe: true`. A release declaring manual transition is rejected before maintenance. Actual release policy and supported predecessors are recorded in the target release notes.

Private upgrade transaction `v2` records the source schema and hashes of retained present key files alongside configuration/database hashes. Snapshot publication flushes the complete inventory. Restoration verifies it before touching current files, retains failed state, and restores only recorded keys under sealed admission; unrelated files are preserved. Existing private `v1` transactions remain readable for their original schema-1 recovery. Neither reader can turn a committed upgrade into automatic rollback. Upgrade snapshots, key quarantine and migration backups require the same private permissions as live state.

After new requests have been accepted, restoring an old snapshot can erase their receipts even though native actions already happened. Rollback must then preserve current management records or refuse and provide an explicit recovery procedure; retaining an executable backup alone is insufficient.

Use synthetic fixtures that reproduce each supported released format. Verify preserved IDs/configuration, identical and conflicting retries, uncertain delivery, native reconciliation, interruption and repeated startup during migration, rejection of future/malformed state without modification, WAL-backed backup consistency, and pre-commit restoration. Keep tests of new work after commit separate from pre-commit rollback, and keep all real user databases out of fixtures and Git.
