# Network peer transport

The daemon implements direct authenticated peer connections and membership reconciliation on a separate HTTPS listener. The [membership engine](network-membership-engine.md) remains the only authority validator; [Network storage](storage.md#network-storage-foundation) remains the durable source of accepted management records. There is no coordinator, privileged founder, replicated conversation store or execution relay.

This is the transport foundation for issue #39. The [Network CLI lifecycle](cli.md#network-membership) integrates enrollment, issuer-local confirmation, exact-result recovery and departure outbox delivery. CLI control stays authenticated on loopback. Operator Network reads and subscriptions use direct Peer adapters. [Remote execution](network-execution.md) adds typed native mutations and scoped receipt recovery. Network Web integration remains deferred.

## Configuration and lifecycle

Local daemon orchestration uses `Repository::configure_peer(PeerSettings)` to retain an optional `listenEndpoint` and up to eight `advertisedEndpoints` in the existing settings row. The default listener is absent. `set_peer_address` retains an explicit endpoint for an exact member generation. Neither operation creates membership or replaces its key.

Endpoints are HTTPS origins with explicit ports and no credentials, query, fragment or non-root path. A listener can bind an explicitly selected local interface; advertised endpoints must identify reachable addresses. There is no fixed port. Port zero is useful for isolated test listeners; use a reachable explicit port in advertisements. Configuration is loaded when `PeerRuntime::start` runs. Applying a listener change requires shutting down that runtime and starting it again; ordinary daemon restart does this automatically. Enrollment orchestration must perform that lifecycle when it exposes configuration.

`PeerRuntime` owns the accept loop, reconciliation scheduler, connections, proof workers and transient buffers. Startup errors stop the daemon's owned native runtime rather than leave it running behind a failed Peer service. `shutdown` awaits cancellation and releases its listening socket. Dropping the handle also signals cancellation. No peer listener serves local assets, `/internal`, browser authentication or operator API routes. Peer requests containing cookies or authorization headers are rejected.

The daemon supplies its existing maintenance gate to the Peer runtime. Sealed upgrades reject new Peer admission and synchronization writes. Shutdown stops new work, closes runtime-owned outgoing connections and waits for already-started blocking verification/commit work before releasing state ownership. Standalone library runtimes used in synthetic tests have no native maintenance coordinator.

`PeerCapacity` configures connection and proof-worker counts, the aggregate working reservation and the total verification budget of a proof session. Defaults are 32 connections, four proof workers, 64 MiB and 300 seconds. Complete-history working capacity uses `DEWBOW_NETWORK_WORKING_BYTES`, as described in [local operations](operations.md). Capacity admission is conservative accounting, not an operating-system allocator quota. Exhaustion reports `RESOURCE_LIMIT`; it never makes an otherwise valid history invalid.

## Identity and restricted channels

TLS uses full mutual TLS 1.3 handshakes, the retained Ed25519 generation key and strict CertificateVerify verification. Session tickets, resumption and early data are disabled. Certificates are temporary self-signed public-key containers. Identity follows the exact public key, not a certificate fingerprint, hostname or public CA. Pinned-key SNI selection and explicit proof-only SNI follow [Network protocol v1](network-protocol.md#transport-and-trust-bootstrap).

One `hello` binds each connection to one Network, identity and purpose. Unknown valid keys can submit bounded admission proof; they cannot enumerate ordinary history. Proof verification can supply a compatible admission to the normal transactional adoption path. That provisional connection remains restricted: the client opens a new full member connection after adoption. Old keys can receive only their purpose-scoped retained proof, never ordinary membership authority. Every ordinary operation checks current local and peer generations again; adopted withdrawal or verified conflict closes an ordinary connection.

When a retained pin is unavailable or no longer names the responder's current generation, the client explicitly reconnects in proof-only mode. It fetches complete signed responder admission ancestry without invitation secrets or business data, checks the original Network and host binding and validates compatible adoption. It then establishes a fresh member connection pinned to the proven generation key. Another host at the same endpoint cannot replace the original target. The certificate selected before a server handshake remains that connection's exact HTTP identity even if local membership changes during the handshake.

Admission, exclusion and departure proof tokens are connection-bound and disappear on disconnect. Full proof verification is distinct from durable adoption. A proof from another retained selection never unions that selection into the active history. Invitation operations use pinned join channels with explicit issuer-local confirmation. Public `joinRecovery` returns only retained signed admission ancestry or an inconclusive result, never new authority. Departure operations use exact old-generation keys and verified recipient contexts, including inactive-recipient acknowledgements and locally constructed rebases. Native reads and subscriptions require ordinary member authority and a matching current history. Typed mutations and receipt queries use the target admission gate.

## Reconciliation and addresses

The scheduler reconciles known members on startup, after membership changes and on coalesced history notifications, and revisits successful peers every 30 seconds with jitter. Failed endpoints rotate fairly with exponential backoff. Independent bounded attempts prevent an unreachable member from blocking another. Reachability failures do not remove a member.

Address-hint leases are runtime observations. Repeating a live signed nonce does not extend its expiry; expiry or restart leaves the last-known candidate available without freshness. Nonce bookkeeping is bounded; an untracked hint at capacity stays a stale candidate rather than gaining a new freshness claim.

Each HTTP connection is bound to its identity and purpose. Reconciliation pulls a fixed remote snapshot and uploads the caller's complete manifest through `submitHistoryManifest`; the reverse direction is a separate authenticated connection. Both directions therefore need reachable contact candidates. Explicit seeds, last-known endpoints and unchanged signed hints supply them. Current members can forward another current member's signed hint; a hint changes only contact candidates. There is no discovery scanner, mDNS, rendezvous or NAT traversal. Remotely supplied endpoints cannot dial loopback, unspecified, multicast or link-local addresses, including DNS resolutions and IPv4-mapped IPv6 addresses. Explicit local seeds may select locally intended addresses. Connections are direct and do not use environment proxy settings or HTTP redirects.

The source pages IDs in decoded-byte order, checks the uploaded manifest commitment and sends missing records ancestor-first. A receiver verifies a complete compatible candidate against its current selection, commits it atomically and only then acknowledges adoption. A stale base is recalculated. A failed commit leaves the previous state authoritative. Incomplete records are discarded without a pending queue or seen-ID blacklist; another manifest comparison rediscovers them. A verified conflict retains bounded evidence and quarantines that exact peer generation without rolling back accepted records or automatically exiting. The quarantine survives runtime restart while its attributed witness remains retained. Explicit local reconnection clears the peer attribution and retries verification while keeping the evidence. Old unattributed witnesses remain valid evidence; witness eviction may require verification again on later contact.

Snapshot and manifest tokens expire after 60 seconds without successful activity and renew during progress. A snapshot has no fixed total lifetime, even when the source adopts newer records. Only one served snapshot and one uploaded manifest are retained per connection. Transfer cursors, proof views, connection authorization and framing buffers are volatile. Already committed records survive lost acknowledgements and reconnection.

## Framing and validation

Peer control messages are bounded JSON POST operations under `/network/v1`. Rust request and result types live in the protocol crate. Duplicate JSON properties, unsupported forms and oversized inputs fail before dispatch. The [protocol](network-protocol.md#addresses-retries-and-resource-bounds) defines interoperable frame, page, nesting and record bounds.

The reusable framing module supplies bounded JSON serialization, NDJSON/SSE encoding and incremental receivers. A start/chunk/end transfer preserves one complete typed JSON value, including native items larger than a control frame. Receivers check transfer identity, contiguous indexes, base64url encoding, byte budget, length, digest and complete JSON before publishing. EOF, cancellation or `streamError` discards the incomplete logical value. No frame is spooled to disk. Native read and subscription handlers share these bounded frames. Typed execution uses bounded JSON responses.

Focused regression checks run with:

```sh
cargo test --locked -p dewbow-daemon --lib network::peer
```

These tests use synthetic management state and real loopback TLS/HTTP connections. They cover founder independence, admission proof bootstrap, current-authority checks, key substitution, missing client certificates, automatic reconciliation/restart, conflict quarantine, failed commits, duplicate retries, immutable snapshots with renewable expiry, discarded-child recovery, framing and socket release. The [execution checks](network-execution.md#validation) additionally exercise native fixture operations across multiple daemons. These checks do not constitute acceptance on separate physical machines.

## Native read adapters

`readOperation` implements exactly the six protocol read operations. A weak service
reference supplies native discovery/history/content reads without forwarding local
HTTP credentials or retaining a second content store. Business context is checked
under the same database serialization boundary as membership adoption, then the lock
is released before native work. The context and authority are checked again before
result publication and throughout streamed delivery.

Each TLS connection retains at most one fully verified business context. Delivery
checks the live selection, history commitment, local generation, key and active
status under the membership commit lock, together with current maintenance and
conflict quarantine. An unchanged immutable history can reuse its verified key/member
bindings without rechecking every ancestor signature for every 64 KiB chunk. Any
context change invalidates that reuse and performs full authorization again. This
volatile verification state grants no authority across a change or reconnect.

Results through 1 MiB use ordinary JSON. Larger results transfer the same envelope
through bounded NDJSON frames. `subscribeSessionUpdates` transfers complete snapshot
and update envelopes over framed SSE. The operator entry validates and reassembles
each logical value in memory before publishing it. Transfers retain only bounded
volatile buffers, share Peer working reservations and use HTTP backpressure. Capacity
pressure can reject a transfer below the 64 MiB logical ceiling. Disconnect or invalid
frames discard incomplete values and never advance the reader's native cursor.

The entry connects directly to an explicitly selected Network/host, reconciles
compatible history within ten seconds and enforces current authority throughout
delivery. An authenticated hello with an identical verified snapshot avoids a
redundant manifest exchange; it does not replace current business authorization.
Subscriptions bind the target's native runtime and close on history changes,
removal, maintenance or shutdown. Typed mutations and scoped receipt queries use the target-owned execution adapter.

`node --test scripts/tests/network-reads.test.mjs` exercises three real local daemon
processes with synthetic native storage: independent entries, unmanaged sessions,
large results, history/output/diff pagination, subscription reconnects, founder exit,
target restart and removal. These checks are distinct from physical-machine acceptance
in issue #44 and do not establish remote execution support.

## Lifecycle scheduling and acceptance

The Peer runtime revisits retained join attempts and due departure tasks every five seconds. Join attempts retain their original identity and key; expiry clears only never-submitted attempts. Uncertain attempts continue original-result recovery. Unused invitation secrets are cleared after expiry. Departures use up to four independent workers, fixed known destinations and durable exponential retry delays capped at 512 seconds. Tasks never expire automatically. Listener shutdown cancels outgoing work; committed identities, admissions and acknowledgements survive restart.

`network-lifecycle.test.mjs` exercises four real local daemon processes and the public CLI with synthetic native runtimes. It covers founder-independent enrollment, offline removal, restart, self-removal, maintenance and occupied listeners, and verifies shutdown releases both listener ports. Rust lifecycle tests additionally exercise lost-result recovery, inactive recipients and conflicting-branch departure rebasing over real loopback TLS. These checks do not constitute physical-machine acceptance, which remains in issue #44.
