# Versioned upgrade acceptance

Run `npm run test:upgrade` after building Web, the Dewbow executable and the synthetic native fixture with the pinned workspace tools. It exercises the public installed CLI with two distinct native executable images and versions. CI runs it on Linux x64, Windows x64, macOS Intel and macOS Apple Silicon. The Release workflow repeats acceptance using its optimized candidate before uploading distribution files or allowing publication.

```sh
npm run build:rust
npm run test:upgrade
```

For an optimized candidate already built by the Release workflow:

```sh
npm run test:upgrade -- --release
```

The command archives the immutable predecessor source pinned in `scripts/upgrade-acceptance.mjs` into an ignored private directory, changes only that copy's product version to `0.0.0-upgrade-acceptance.0`, and builds it with its locked dependencies and separate outputs. The initial pin is [the merged upgrade supervisor implementation](https://github.com/rovewyn/dewbow/commit/2be0d8f4a4efbb6f0954b5cbda892baad8615d33), which already uses current-format state and the upgrade protocol. The candidate keeps the workspace's actual development version and current implementation. Fetch repository history before running acceptance in a shallow clone; CI checks out full history. Review the pin deliberately when selecting a supported predecessor for release preparation.

The real release packager supplies the candidate's archive layout and metadata; separate synthetic archives declare a compatible transaction and a manual-only transition so both policies are exercised independently of the real release policy. No installed user binary, repository version, published artifact, release tag or real Codex home is changed. Synthetic files use separate state, work, installation and marked native directories under `outputs/`; successful runs remove their own directory and failures retain it for private inspection.

The baseline is deliberately a current-format synthetic predecessor. It does not establish support for any published source release. In particular, the released 0.1.0 executable has no upgrade command or maintenance protocol, and its management-state transition is excluded by the [0.2.0 release notes](release-notes/0.2.0.md). Testing the automatic transaction with a compatible predecessor does not override the target release's published upgrade or rollback policy. `--release` tests the same optimized executable that packaging verifies, using a compatible synthetic archive; it does not rewrite the real distribution archive or establish 0.1.0 migration support.

## Required scenarios

| Scenario | Required observation |
| --- | --- |
| Manual-transition policy | A synthetic archive declaring `rollbackSafe: false` is rejected before maintenance, with the original service and state preserved. |
| Interrupted archive delivery | The public upgrader rejects a truncated archive against its original checksum before maintenance. The original daemon instance keeps serving. |
| Release connection loss | An explicit loopback proxy closes the public command's actual release connection. The intended connection must hit this fault, and the original daemon must remain unchanged. No TLS check, certificate store or host trust policy is changed. |
| Candidate startup failure | The marked native fixture fails the candidate's model probe once. The public upgrader restores and verifies the original executable and service. |
| Worker termination | Kill only the fresh worker belonging to this synthetic job after the real candidate has replaced the installation and native validation is gated. The independent supervisor restores the original service. |
| Frontend disconnect and duplicate execution | Kill the waiting frontend while validation is gated. A repeated command attaches to the same job. Releasing validation completes the version change; repeating an equal-version upgrade does not restart the service. |

Every scenario also checks the retained host identity, frozen session creation configuration, request deduplication target, absence of duplicate native work and a synthetic native credential canary. Successful upgrade checks the installed binary hash, reported version, new daemon identity and admission of a new request. Cleanup stops the selected synthetic daemon and verifies its listener has closed.

Network failures are injected at distinct boundaries: public-CLI release discovery connection loss, incomplete/stalled/oversized archive response bodies in the actual Rust download function, and truncated archive rejection through the installed CLI. The CLI network fixture makes no external connection and cannot mistake an upstream discovery failure for an archive download fault. These checks do not establish a complete successful online download from GitHub. Existing Rust process tests additionally cover simultaneous controller loss, restart-triggered recovery, bounded failure and repair, delayed workers, interrupted checkpoint publication and Windows job policies.

## Windows execution host

Production handoff requires complete Job Object escape. A local host that forbids it cannot demonstrate successful detached upgrades. GitHub Actions uses the existing same-account independent validation host:

```powershell
./scripts/test-windows.ps1 -upgradeAcceptance
./scripts/test-windows.ps1 -upgradeAcceptance -releaseCandidate
```

The script installs no service and changes no job policy. No production detachment check is disabled. Cargo and npm are build/test prerequisites only; the installed product still runs without Node.js or Rust.

These checks use real OS processes, files, SQLite storage, archive tools, executable replacement and the public CLI, with a synthetic Codex app-server. They are not production SSH acceptance, real Codex service acceptance, reboot or hardware power-loss validation. Keep private diagnostics and actual run results out of commits and PR bodies; report validation commands and CI links without copying local state.
