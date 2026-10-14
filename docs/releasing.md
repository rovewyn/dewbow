# Versioning and releases

Dewbow ships one product: the `dewbow` executable, its daemon and its embedded Web. Rust crates and retained npm workspaces share that product version. All npm packages remain private; this workflow does not publish to npm or crates.io. Codex is installed separately. Product releases do not change the Dewbow management contract version, which remains `v1` during early development.

## Version policy

The authoritative version is `[workspace.package].version` in the root `Cargo.toml`. Every Rust member inherits it with `version.workspace = true`. The root npm package, all explicit npm workspaces, their internal dependency pins and both root lockfiles must agree with it.

Use unprefixed SemVer without build metadata in both manifests and Git tags. A tag must exactly match the product version, such as `0.1.0` or `0.2.0-rc.1`. During `0.x` development:

- Increment the patch for compatible fixes, such as `0.1.0` to `0.1.1`.
- Increment the minor for features or breaking changes, such as `0.1.1` to `0.2.0`.
- Use prereleases for candidates, such as `0.2.0-rc.1`. Release candidates are marked as prereleases on GitHub.
- Adopt `1.0.0` when the public behavior and upgrade expectations are ready for a stability commitment.

Conventional Commit PR titles survive squash merges and provide the change history. Mark breaking changes with `!` or a `BREAKING CHANGE` footer. Review the version choice and user-facing notes rather than inferring them solely from commit types.

## Synchronize and check

Run these commands from the repository root with the documented Node/npm runtime:

```sh
mise exec -- npm run version:check
mise exec -- npm run version:sync
mise exec -- npm run version:set -- 0.2.0-rc.1
mise exec -- npm run version:check -- --tag 0.2.0-rc.1
mise exec -- npm run test:release
```

`version:check` is read-only and fails on drift. `version:sync` reads the Cargo product version and repairs the npm versions, internal dependency pins and lockfile version entries. `version:set` also changes the authoritative Cargo version. It does not install dependencies, resolve new external versions, create commits or tags, or publish anything. All file parsing and structural checks finish before writes begin. Inspect the resulting diff before committing.

The script handles this repository's explicit npm workspace paths, Cargo member lists, package string fields and inherited Rust versions. It fails on unsupported workspace layouts instead of guessing. External dependency versions, resolutions and integrity values stay untouched. Update the script when changing these workspace conventions. Node alone can run the version checks and release-tool tests; Cargo and installed npm dependencies are needed for builds.

CI checks consistency on all platforms. Keep generated files, local measurements, logs, databases and actual acceptance results in the ignored directories documented in `CONTRIBUTING.md`.

## Prepare a release PR

1. Start from current `main` using the contributor workflow. Keep ordinary feature work in short-lived PRs.
2. Select the next product version and run `version:set`. The existing `0.1.0` manifest version does not by itself establish that a release has been published.
3. Create `docs/release-notes/<version>.md` in English, with the actual changes and requirements for that release. Include the information below; remove template placeholders before review.
4. Run version checks, release-tool tests and the validation commands in [Workspace development](workspace.md). Build Web before Cargo. Inspect both lockfile diffs, then follow staged review and Gitleaks requirements in `CONTRIBUTING.md`.
5. Open a focused PR such as `chore(release): prepare 0.2.0-rc.1`. Review the version, notes and supported targets. Merge it with squash after required checks pass.

Release-note outline:

```markdown
# Dewbow <version>

## Changes

- Describe the user-visible behavior and its purpose.

## Upgrade requirements

- State the required independent Codex CLI version and supported platforms.
- List breaking CLI, API, configuration or local-state changes.
- State explicitly whether a Dewbow-owned state reset is required.
- State whether rollback to the preceding release can use the same state.

## Known limitations

- Describe actual limitations, including native acceptance that remains unverified.
```

Automated changelog generation and release PR maintenance can be added later. This first workflow uses reviewed release-note files and a manually prepared PR.

## Build without publication

[Release](../.github/workflows/release.yml) runs when a tag matches `[0-9]*.[0-9]*.[0-9]*` or when manually dispatched. This filter includes stable and prerelease tags without a prefix; the preparation job requires an exact match with the product version. Both default to building and uploading Actions artifacts only. A branch dispatch can exercise release preparation before tagging. No release is created unless a later manual dispatch selects `publish: true`.

The workflow installs pinned Node/npm and Rust, uses `npm ci` and Cargo `--locked`, builds Web before Rust, runs typechecking and the Rust/npm checks, builds the optimized executable, and verifies the extracted archive's executable with `--version` and `--help`. All matrix jobs must succeed before the publication job can run.

The initial distribution targets are:

| Runner | Target | Archive |
| --- | --- | --- |
| Ubuntu 24.04 | `x86_64-unknown-linux-gnu` | `.tar.gz` |
| Windows 2025 | `x86_64-pc-windows-msvc` | `.zip` |
| macOS 15 | `aarch64-apple-darwin` | `.tar.gz` |

These targets are explicit; CI operating-system coverage does not imply other architectures or older OS versions are supported. Linux uses GNU libc, not a musl static build. Binary signing, notarization, installers, self-update and package-registry publication are deferred.

Each archive is named `dewbow-<version>-<target>.<extension>` and contains only `dewbow` (or `dewbow.exe`), `CLI.md` and `release.json`. The manifest records the product version, full source commit, target and executable SHA-256. A separate `<archive>.sha256` records the archive checksum. Actions keeps build artifacts for 14 days. Local state, Codex data, environment files and build logs are never package inputs.

For a local Windows build and package check:

```sh
mise exec -- npm ci
mise exec -- npm run build
mise exec -- cargo build --locked --release --bin dewbow --target x86_64-pc-windows-msvc
mise exec -- npm run release:pack -- --target x86_64-pc-windows-msvc
mise exec -- npm run release:check -- --target x86_64-pc-windows-msvc
```

Use the matching target for Linux or macOS. Packaging requires the platform's `tar`; Windows uses the built-in BSD tar's ZIP support. Output goes to ignored `artifacts/release/`. Packaging refuses to overwrite an existing archive or checksum. Move reviewed outputs outside that directory or remove only your own generated outputs before rebuilding. Package verification checks archive contents, checksums, metadata and the extracted executable. These smoke checks do not start a daemon or access real Codex storage, and do not establish real native acceptance.

## Publish later, with explicit authorization

Pushing a tag and running a publication job are separate operations from preparing code. Perform them only when authorized. The following is the future procedure, not part of setting up this workflow:

1. Confirm the release PR is merged and the desired commit is in remote `main`.
2. Create an annotated `<version>` tag, such as `0.1.0`, at that reviewed commit and push that tag explicitly. The tag must exactly match the product version, without a prefix. Tagged builds reject commits outside remote `main`.
3. Inspect the successful build, package contents, release notes and any separately recorded native acceptance. Request any required publication approval at this point.
4. Manually dispatch the Release workflow on that exact tag with `publish: true`. It rebuilds and checks every distribution, verifies the archived checksums, then creates the public GitHub Release from `docs/release-notes/<version>.md` and the current run's artifacts.

The built-in `GITHUB_TOKEN` is used only by the workflow. Build jobs have read-only repository access; only the explicitly selected publication job has `contents: write` and `actions: read`. No personal access token is required. Keep action revisions pinned when updating workflows.

The publication command requires an existing remote tag and fails if the release already exists. It never updates a release or clobbers assets. Never move a released tag or replace published binaries; fixes receive a new version. Workflow artifacts are temporary build outputs and are distinct from published release assets. For a fresh build after a completed artifact upload, use a new manual dispatch rather than rerunning all jobs with the same artifact names.

## Upgrade and recovery

Stop the selected Dewbow daemon and its owned native runtime before replacing its executable or changing Dewbow-owned state. Preserve native Codex conversations, credentials and unrelated files. State resets are release-specific, require documented instructions, and must be validated with fresh synthetic databases; early development does not require migration code.

Keep the previous executable and a suitable backup of Dewbow-owned state when an upgrade needs one. Do not assume an older executable can read state written by a newer release. Follow that release's rollback guidance, preserving native Codex data throughout. Separate synthetic checks, completed CI, real native verification and publicly published acceptance claims.
