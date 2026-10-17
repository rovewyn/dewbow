# Network operation, recovery and acceptance

Every current member has the same Network authority. Any member can admit a new node after exact-key confirmation, remove another member, or remove itself. The founder can disappear or be removed while the remaining members continue. There is no coordinator, privileged founder, execution relay or election service.

Use the [CLI membership guide](cli.md#network-membership) or [Network Web workflow](web.md#network-workflow) for enrollment. This guide defines recovery observations and the evidence needed to accept a Network installation.

## Operating rules

Configure a separate reachable HTTPS Peer endpoint on each machine. Permit the selected Peer port through the intended LAN/VPN firewall. Keep operator Web on loopback; open each node's Web through its local `dewbow web` command. A VPN supplies reachability; it does not supply membership authority. There is no discovery scanner, rendezvous, NAT traversal or public relay.

An invitation can come from any current member. Compare the joining host, full public key and fingerprint through a trusted channel before allowing the exact request on the issuer. Wait for the joiner's `localStatus: active`. An issued invitation, pending request or issuer approval alone does not establish completed admission. Invitations are short-lived secrets; do not place them in logs, process arguments, Git or shared acceptance reports.

Keep these observations separate:

| Observation | Meaning |
| --- | --- |
| Membership | The selected signed history admits an exact `membershipId` and key. A display name or reachable address supplies no authority. |
| Reachability | A direct connection can currently be made to a known endpoint. A timeout does not remove a member. |
| Member synchronization | Peers validate and merge compatible signed admissions and withdrawals. This transfers trust metadata and contact hints, without copying conversations or executing work. |
| Operation entry | The local CLI/Web authenticates its operator and selects the exact Network, target host and admission. Each member provides this entry independently. |
| Request execution | The entry calls the selected target directly. That target owns admission checks, native Codex execution, receipts, callbacks and recovery. A reachable third node cannot relay the operation. |
| Departure propagation | The local withdrawal is retained, with delivery tracked for known recipients. Offline recipients can learn it later. Partial propagation is not global completion. |

After removal or self-exit, already admitted work continues on its execution host. Inspect it locally or through another current compatible member. Withdrawal revokes subsequent access; it is not cancellation, history deletion or an undo operation. Readmission needs a new invitation and generation key. An old removal retry names its old generation and cannot remove the fresh admission.

## Failure recovery

Preserve the selected state directory, its management database and protected `network-keys` together. Keep native Codex home and working files separate. Stop the owned daemon before copying state; do not restore a snapshot into a running installation. The current release's supported sources and rollback limits are in the [release notes](release-notes/0.2.0.md).

| Failure | Required response and observation |
| --- | --- |
| Founder offline | Continue through any reachable current member. Keep the founder as offline or explicitly remove its exact generation. Admit a new node from a surviving member. |
| Network partition | Continue only where the target is reachable and authority can be verified. Restore contact candidates and allow reconciliation. Compatible histories converge; a verified conflict is quarantined without automatic branch rollback, voting or arbitrary union. |
| Offline removal | Retain the signed withdrawal and pending propagation. On return, the removed key has only restricted proof/departure access and cannot regain ordinary authority from its stale snapshot. Partitioned nodes cannot enforce an unseen withdrawal until they receive valid evidence. |
| Changed address | Set an explicit reachable endpoint for the intended current `membershipId`. An address change never substitutes another host or key. Check routes and firewall before changing identity. |
| Quarantined conflict | Preserve the bounded evidence and inspect the competing histories. Explicit reconnection retries verification; it does not authorize a conflicting merge. Follow the [fork rules](network-design.md), without deleting accepted records. |
| Entry response lost | Keep the original Network, target, source, request ID and input. Inspect the scoped receipt or repeat the identical request. `DELIVERY_UNCERTAIN` or a missing receipt never authorizes a new request ID or execution elsewhere. |
| Target abruptly stopped | Restart with the same state directory and native home. Reconcile native state and retained receipts. Report unknown delivery when it cannot be established. Old native callbacks are invalid after process restart; do not replay answers or approvals. |
| Active key missing or mismatched | Startup fails closed. Preserve the database and remaining files. Recover only the exact verified key belonging to that retained identity from its protected backup, or investigate an explicit readmission plan. Do not generate a replacement key under an old admission or edit the database to bypass validation. |
| Upgrade interrupted | Use the guarded upgrade transaction and its original installation/state selection. Inspect `upgrade --status`; use `--recover` when required. A committed upgrade cannot restore an older trust/receipt snapshot. |

Restoring an older snapshot can lose accepted receipts and removal evidence, create conflicting history, or permit duplicate work. A backup is recovery evidence, not general rollback permission. Do not reset state or replace it with a fresh directory to make an upgrade pass. A peer's old snapshot cannot revoke another node's retained fresh admission, but a machine that loses its own accepted evidence still needs inspection. See [storage compatibility](storage.md) and [remote receipt recovery](network-execution.md#receipts-and-recovery).

## Automated acceptance

Build with the pinned tools, then run:

```sh
npm run build:rust
node scripts/test-rust.mjs
npm test
npm run test:upgrade
npm run test:network-upgrade
```

On Windows, run the test suites outside a restrictive launcher's Job Object using the documented independent same-account host:

```powershell
./scripts/test-windows.ps1
./scripts/test-windows.ps1 -upgradeAcceptance
./scripts/test-windows.ps1 -networkUpgrade
```

The existing CI matrix runs Linux x64, Windows x64 and both macOS architectures. Release acceptance also tests the optimized candidate. A passing matrix verifies synthetic behavior on those systems; it does not establish physical-machine or live-account acceptance.

| Layer | Synthetic coverage |
| --- | --- |
| Membership engine and storage | Signed causal histories, compatible merges/forks, exact-generation withdrawal/readmission, schema-1 migration interruption, immutable receipts/recovery associations, key publication/deletion interruptions, missing-key refusal. |
| Peer transport | Real loopback mutual TLS, restricted old keys/proofs, pin substitution refusal, reconciliation, lost acknowledgements, quarantine, bounded framing, maintenance and socket release. |
| CLI/operator/native integration | Multiple independent daemon processes, founder crash and removal by a newly admitted member, offline withdrawal, restored old snapshot/key after readmission, self-exit, remote reads/streams and all seven mutations. Entry/target crashes preserve receipts and invalidate old callbacks without duplicate execution. |
| Web client | Exact Network/host/admission/session selection, identical session IDs across hosts, immutable retries and subscription identity/order. Browser inspection remains a distinct manual check. |
| Installed upgrade | Distinct pinned synthetic executables; schema-1 migration plus schema-2 Network state with active keys, signed removals, offline recipient and remote delivery receipt. Startup failure, worker death and frontend disconnect exercise recovery and preservation. |

See [versioned upgrade acceptance](upgrade-acceptance.md) for predecessor pins, synthetic compatibility declarations and commands. These checks use a marked synthetic Codex app-server; no real account, user history or credential is required. Test assertions and synthetic fixtures belong in Git. Raw state, logs, screenshots and run results remain private in ignored `outputs/` or the other directories allowed by `CONTRIBUTING.md`.

## Physical LAN/VPN and native acceptance

Use user-selected machines and independently prepared synthetic native conversations. Record each node's platform, executable version, selected state/native directories, endpoint and test role privately. Do not continue existing personal conversations. Before interrupting a process or changing connectivity, identify its exact owned instance and arrange local recovery access.

1. Initialize A, B and C with independent state and native homes. Enroll B through A, then C through B. Compare exact keys and inspect status from all three Web entries. Confirm direct Peer reachability without exposing operator Web to the LAN.
2. Stop A. From B, invite and confirm D. From D, remove A's exact generation. B/C/D must continue without contacting A. Restart A and observe its removed status after reconciliation.
3. Partition C from B/D using the selected test connectivity boundary. Remove C on B while C is offline. Record local success and incomplete known-recipient propagation separately. Restore connectivity; C must learn removal and ordinary reads/writes must fail. Rejoin C with a new key; old removal retries must not affect it. Have C or D remove itself and verify the other members learn that departure.
4. From two independent Web entries, select one target conversation and exercise creation, history/output/diff reads, follow-up, steering, interruption, a question response and approval Allow/Deny on dedicated synthetic turns. Verify execution and native files on the selected target. Refresh the entry and reconnect its update stream. Closing an entry must not stop target-owned work.
5. Lose an entry connection after submitting work, retaining its original request identity and input privately. Inspect the target receipt through another member and retry identically after reconnection. Verify one native delivery. Restart the target while a synthetic question/approval is pending; the old callback must be refused. Unknown outcomes remain explicit.
6. Exercise the supported upgrade on the same selected state, including a safely staged failed-start recovery. Verify retained host/admission/key identity, signed withdrawal evidence, local and remote receipts, frozen settings and native history. Use the target release's actual compatibility policy; synthetic `rollbackSafe` declarations never authorize a real release transition.
7. Stop the test daemons, verify their owned native processes and listeners have exited, and preserve private evidence needed for unresolved outcomes. Do not stop unrelated instances or delete native account data.

For each scenario record `pass`, `fail` or `not run`, the exact versions/platforms, expected and observed behavior, and a private evidence location. Separate loopback synthetic runs, actual LAN/VPN observations, live native observations and unverified platforms. A release or issue claiming full cross-machine acceptance must include the actual selected-node results; runnable checks and this checklist alone do not establish it.
