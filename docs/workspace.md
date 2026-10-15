# Workspace development

See [project ownership](README.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). Rust uses the root Cargo workspace and lockfile; TypeScript uses npm workspaces and the root npm lockfile.

## Setup and builds

Use Rust 1.99.0 stable, Node.js 24.21.0 LTS and npm 12.2.0 with the committed root lockfiles. Rust is pinned in `rust-toolchain.toml`, Node in `.node-version`, and npm in the root `package.json` field `packageManager`. Install and select these versions before running the commands below from the repository root. `.node-version` and `packageManager` record the required versions; they do not by themselves install Node/npm or change the current shell's PATH. Rust has no LTS channel. On Windows, Rust's MSVC target needs the C++ build tools and Windows SDK.

```sh
node --version
npm --version
cargo --version
npm ci
npm run build:rust
```

The version checks must report Node.js v24.21.0, npm 12.2.0 and Cargo 1.99.0. If needed, install npm with `npm install --global npm@12.2.0` after selecting Node.js 24.21.0. npm 12 allows only reviewed dependency scripts in root `allowScripts`; see the contributor policy when upgrading Koffi or fsevents.

npm builds protocol, SDK and UI before Web. Cargo embeds `apps/web/dist`; rebuild Web before Cargo after a UI change. Cargo can compile library tests without those assets, but daemon startup rejects missing Web assets. `cargo build --release --bin dewbow` creates the standalone executable; it requires native Codex at runtime and does not need Node.js.

The retained TypeScript SDK remains independently usable. `npm run demo` prints read-only discovery counts. `npm run demo:history -- <session-id> 20 desc` reads private native history. Keep real results out of version control.

## Optional local environment management

mise is an optional way to install and select the same pinned tools locally. Any installation method must satisfy the versions above. The repository's `mise.toml` configures Rust only; select Node explicitly and install the required npm version in that Node installation:

```sh
mise trust
mise install
mise install node@24.21.0
mise exec node@24.21.0 -- npm install --global npm@12.2.0
mise exec node@24.21.0 -- node --version
mise exec node@24.21.0 -- npm --version
mise exec -- cargo --version
```

If the current shell already selects the pinned tools, use the direct commands in this guide. Otherwise, prefix Node/npm commands with `mise exec node@24.21.0 --`, such as `mise exec node@24.21.0 -- npm run build:rust`, and Cargo commands with `mise exec --`, such as `mise exec -- cargo fmt --all --check`. Keep Gitleaks available in the environment used for the hook installer and commits. The CI and Release workflows install pinned tools directly and do not use mise.

## Validation

```sh
npm run build
npm run typecheck
npm run version:check
npm run test:release
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --bins --examples
node scripts/test-rust.mjs
npm test
git diff --check
```

The root npm test includes Rust integration checks and expects the compiled `dewbow` executable and SDK fixture. These tests use explicitly marked synthetic native storage and isolated private state. They cover lifecycle, HTTP authentication, request identity, callbacks, Unicode output, independent history and restart uncertainty. Retained TypeScript tests cover SDK adapters, protocol helpers, chat projection and navigation.

Rust source uses idiomatic snake_case identifiers while JSON uses the shared camelCase contract. Native Codex names remain native at integration boundaries. Keep generated build outputs, databases, logs and actual acceptance results in ignored directories.

## Continuous integration

[CI](../.github/workflows/ci.yml) installs pinned Node/npm and Rust on Linux, macOS 26 Intel, macOS 15 Apple Silicon and Windows. Both macOS architectures run the full checks on native runners: `macos-26-intel` for x86_64 and `macos-15` for ARM64. ARM64 runner capacity can delay jobs; Intel checks do not substitute for ARM64 checks. Every job builds Web before Rust, runs formatting and strict Clippy, builds all binaries/examples, and runs Rust plus retained npm tests. Linux also checks SDK package contents. The workflow has read-only repository permission and does not publish or deploy.

CI also checks the shared product version before dependency installation; release-tool tests run with the root npm test suite. The separate [Release workflow](../.github/workflows/release.yml) builds and verifies distribution archives for Linux x64, Windows x64 and both macOS architectures; publication requires an explicit manual input on a matching version tag. See [Versioning and releases](releasing.md) for preparation, artifacts and the future publication procedure.

These builds and synthetic subprocess checks establish platform foundations. They do not establish real Codex, OS sandbox or multi-machine acceptance. Report actual local verification separately from configured or completed CI runs.
