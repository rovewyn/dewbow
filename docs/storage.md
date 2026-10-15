# Management storage and compatibility

Dewbow keeps one live management database per [state directory](operations.md#state-directory). Codex remains the durable authority for native conversation history, content and execution status. The storage boundary in [AGENTS.md](../AGENTS.md#database-ownership-boundary) continues to apply when adding upgrade support.

## Version identifiers

Product, API and database versions describe different compatibility boundaries:

| Identifier | Current representation | Meaning and evolution |
| --- | --- | --- |
| Product version | SemVer in the root `Cargo.toml`, synchronized to workspace manifests and lockfiles | Identifies the complete executable release; changes for each product release |
| Management API contract | String `v1`, declared by the protocol package and included as `contractVersion` in session update snapshots | Defines operation names, request/response fields, errors and event semantics; compatible additions can retain the version, while breaking changes need a coordinated transition |
| Management database schema | Integer `1` in SQLite `PRAGMA user_version`, represented as `upgrade.stateSchema` in release metadata | Identifies the SQL structure and durable JSON/identity semantics the code understands; a future format change needs an explicit versioned migration for supported sources |

These identifiers do not advance together. A product release can retain both API contract `v1` and database schema `1`. A future storage migration from schema `1` to `2` can leave the API unchanged. See [API contract version](interfaces.md#contract-version) for the HTTP boundary and [release notes](release-notes/README.md) for supported source releases and any approved transition exceptions.

The current implementation validates schema `1` and initializes only an empty, unversioned database. It has no general migration runner. Implement the required migration and update the updater's accepted schema range when introducing a new supported format; changing a version constant alone is insufficient. Private configuration and upgrade-transaction tags are also checked by their own readers and must be reviewed when their formats change.

## Current management model

The [store](../apps/daemon/src/store.rs) uses `records(kind, id, data)` with a primary key on `(kind, id)`. SQL names use snake_case; `data` is JSON with camelCase fields. Durable writes project an allowlist, while runtime objects may contain additional volatile fields.

| Record | Retained purpose | Upgrade invariant |
| --- | --- | --- |
| `session` | Management/native IDs, working directory, resolved creation configuration, creation time and active management turn ID | Keep native associations and frozen execution policy; do not silently adopt another thread or change its settings |
| `operation` | Request and command IDs, operation, input fingerprint, target associations, delivery status, creation time and error | An identical retry must find the original receipt; retain unknown delivery and input conflicts |
| `turn` | Only active or unresolved turn IDs, request/session/native associations, mode and creation time | Reconcile with Codex after restart; a missing callback or stopped runtime does not prove completion |
| `meta/owner` | Owned native PID | Check ownership and process exit before migration or restoration |

The stable host ID and private daemon settings are in `config.json`. They belong to the same upgrade boundary as the database. Pending interaction bodies, answers, callback identities, live content and event buffers stay in memory. Migrations must not reactivate old callbacks or copy historical command output into the management store.

Keep this small management model; a second live database or a table redesign is not required merely to introduce migrations. The SQLite schema includes the semantics of JSON fields and fingerprints, not just table definitions. Changing the durable allowlist or input normalization can require a format change even when the SQL table is unchanged.

## Required evolution process

1. Identify supported source releases by their tagged formats. Distinguish an empty new database from an unversioned released journal by its complete known structure; version `0` alone is not enough.
2. Inspect schema versions, table definitions and required record shapes before initialization or writeback. Reject unsupported and future formats without initializing their schema, dropping data or setting their version to the current one.
3. Acquire exclusive lifecycle ownership and verify daemon/native exit. Retain a private, consistent backup before changing state. Include WAL data and all Dewbow files needed to restore the supported source release.
4. Run ordered migrations with atomic commits or an explicit crash-recovery transaction across files. Update `user_version` only when the matching data transformation commits. Reopening after interruption must finish or safely recover without applying a transformation twice.
5. Preserve management identities, resolved configuration, original fingerprints, request receipts and unresolved execution relationships. Transform only the required management fields. Do not change native Codex storage or introduce duplicate content/event storage.
6. Validate the migrated relationships before admitting requests, then reconcile native execution state. Keep delivery unknown when the retained evidence is insufficient. Validate every supported upgrade source, not just a fresh install.

Product SemVer, public management contract `v1`, SQLite schema versions and private upgrade-transaction formats serve different purposes. They must be reviewed together, without using one as proof that the others are compatible. Removing support for a released format needs an explicit support-window decision and an upgrade path.

## Validation and retention

- **Version validation:** only an empty, unversioned database may be initialized. Existing databases must have schema version 1 and the expected table/column/key structure. Unknown versions, extra schema objects and malformed tables are rejected before write PRAGMAs or initialization. New table creation and its version marker commit together.
- **Record validation:** startup and upgrade checkpoint inspect all persisted records before writeback. Required fields, record-key identities, types, frozen configuration and receipt status/fingerprint shapes are checked. A missing native turn ID remains a valid unknown-acknowledgement state and is reconciled conservatively. Unknown fields or record kinds are rejected rather than silently stripped. Invalid records return a recovery error without exposing their contents or modifying their data.
- **Receipt retention:** receipts are retained indefinitely and loaded into memory on startup. This preserves deduplication but grows with request count. Any future expiry or compaction policy must define the retry window and preserve uncertain operations; silently deleting receipts to reduce storage changes execution semantics.

Storage regression tests protect rejection without modification and retention of frozen configuration and uncertain receipts. Lifecycle tests cover restart and deduplication within the current format. These checks do not establish compatibility with a different persisted format; validate each supported migration separately.

## Rollback and release evidence

The current [upgrade transaction](../apps/cli/src/transaction.rs) checkpoints the current database, snapshots configuration and management state, seals admission during candidate startup, and allows automatic restoration only before durable commit. Preserve those safeguards. Inactive upgrade snapshots and retained failure copies are private recovery artifacts, not additional live databases.

The existing updater admits only manifest contract `v1`, state schema `1` and `rollbackSafe: true`. These checks apply to the currently supported format. A future state-format change needs a reviewed updater path and accurate release metadata. `rollbackSafe` must describe the actual supported predecessor and the stage at which restoration remains safe; release-specific exclusions belong in release notes.

After new requests have been accepted, restoring an old snapshot can erase their receipts even though native actions already happened. Rollback must then preserve current management records or refuse and provide an explicit recovery procedure; retaining an executable backup alone is insufficient.

Use synthetic fixtures that reproduce each supported released format. Verify preserved IDs/configuration, identical and conflicting retries, uncertain delivery, native reconciliation, interruption and repeated startup during migration, rejection of future/malformed state without modification, WAL-backed backup consistency, and pre-commit restoration. Keep tests of new work after commit separate from pre-commit rollback, and keep all real user databases out of fixtures and Git.
