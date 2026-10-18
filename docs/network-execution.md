# Remote Network execution

Any active compatible member can be an operator entry or an execution target. An entry authenticates its local operator and connects directly to the selected target over the existing mutual TLS Peer transport. There is no coordinator, execution relay, permanent founder privilege or automatic target failover. Configure Peer listeners and reachable contacts with the [Network CLI](cli.md#network-membership).

## Operations and authority

The adapter accepts only `createSession`, `connectSession`, `sendMessage`, `steerTurn`, `answerQuestions`, `decideApproval` and `interruptTurn`. The existing [operator resources](interfaces.md#remote-execution) accept a target `hostId`; omitted optional host fields select the local daemon. Local requests retain their original fingerprints and receipt identities.

Peer requests use the exact [business context and operation envelope](network-protocol.md#business-requests-and-receipts). Outer routing fields cannot be repeated inside operation input. The target revalidates current caller and target generations, the actual TLS keys, admitted host bindings, selected history and conflict quarantine. Unknown fields, operations and arbitrary native forwarding are rejected. Membership reconciliation is bounded to ten seconds before readiness failure; it does not create a durable execution queue.

When the authenticated member `hello` reports business access and the same verified history snapshot as the current local selection, mutation preparation uses that commitment without another manifest exchange. Different snapshots still require ordinary reconciliation. The hello is not a lasting grant: both endpoints recheck the live business context at request admission, including a history change or withdrawal after the handshake.

Target session locks serialize local and remote callers. Under the membership database transaction boundary, the target checks authority and inserts the first receipt before any native call. Withdrawal committed first prevents admission. Admission committed first leaves the work and its recovery associations intact; withdrawal removes subsequent caller authority. A target leaving the Network rejects new Network requests while retaining local operations. An isolated node cannot enforce a withdrawal it has not learned.

The target's native runtime owns execution, configuration, sandbox, approvals and native conversation state. Remote entry defaults or settings never replace target policy. Native callback responses require the exact target session, turn, interaction and runtime identity. Question bodies, answers, approval details and callback identities remain volatile; process restart invalidates old callbacks and never replays their answers.

## Receipts and recovery

The durable remote request key is `(networkId, sourceHostId, requestId)`, independent of membership generation, compatible history changes, transport and runtime instances. Different sources can reuse a client request ID. Remote keys cannot collide with legacy local receipt IDs. Semantic fingerprints bind the original target, operation and normalized input, excluding refreshable authority; omitted send mode is equivalent to `default`.

Before possible dispatch, the entry commits an outbound binding and marks it uncertain. The row contains target, operation, fingerprint and result references, never input content or native output. Target-owned receipts and minimum uncertain recovery associations live in the same selected `daemon.sqlite`, using schema 2. No second receipt authority or content database is replicated to the entry.

An identical retry of a previously dispatched attempt queries the original target. It cannot redirect to another target, change input or replay native work. An entry retains the original binding across exit and Network selection changes; reusing that client ID under another Network conflicts instead of creating an execution namespace. A confirmed pre-admission refusal permits another identical submission while retaining the target binding. A missing response after possible admission is `DELIVERY_UNCERTAIN`. A crash after marking uncertainty can remain uncertain even when no byte was sent; a missing receipt never establishes nonexecution or authorizes fresh execution.

Entry disconnection or removal does not cancel target-owned admitted work. Target restart reconciles retained operations with native state and keeps unsupported or unconfirmed outcomes explicit. Pending receipts become unknown rather than being resent. A delivered receipt describes native delivery, independently of turn completion. Completed history and native status remain Codex-owned.

Network receipts and outbound bindings are retained indefinitely by the current storage policy, exceeding the advertised 86400-second minimum. Existing local receipt cleanup is unchanged. Successful delivery clears obsolete uncertain receipt recovery references; active/unresolved turn bindings continue following the normal management recovery rules.

The authenticated scoped receipt GET is available from any current compatible operator member, including directly on the target. It can inspect another source's receipt after that source exits, but cannot execute in its scope. Receipt reads do not adopt proofs, synchronize histories, write contacts, extend retention or trigger native work. A stale inspection context returns `SYNC_REQUIRED`; ordinary membership synchronization must catch up independently. Removed callers and proof/departure channels cannot inspect business receipts. Forks, exclusion or an unavailable target can block recovery without changing the retained uncertainty.

## Validation

The Network storage tests exercise authority and history checks at receipt admission, forged identity rejection, input conflicts and revocation before receipt reuse. Existing migration tests retain schema-1 local identities, receipts and recovery associations when upgrading to schema 2.

The CLI lifecycle integration suite runs multiple daemon processes with real loopback mutual TLS and the synthetic native fixture. It covers all seven mutations, local and separate-source ID isolation, target policy, session contention, callback duplication, lost operator responses, entry and target restarts, old callback invalidation, removal during an active turn, another member's receipt inspection and fresh-admission deduplication. It inspects the synthetic management journal to verify receipt retention and absence of business/callback bodies. These are local multiprocess observations, not physical-machine or live-account native acceptance.

Direct [Network reads and subscriptions](interfaces.md#network-reads) inspect native history and content on the selected target. The [Network Web workflow](web.md#network-workflow) uses these direct services with explicit target selection and volatile retry inputs. Physical-machine acceptance remains separate from local synthetic validation.
