# Workspace development

See [project ownership](README.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). Rust uses the root Cargo workspace and lockfile; TypeScript uses npm workspaces and the root npm lockfile.

## Setup and builds

Use Rust 1.99.0 stable, Node.js 24.21.0 LTS and npm 12.2.0. Rust is selected by `rust-toolchain.toml` and `mise.toml`; Node is selected by `.node-version`. Rust has no LTS channel. On Windows, Rust's MSVC target needs the C++ build tools and Windows SDK.

```sh
mise trust
mise install
mise exec -- npm ci
mise exec -- npm run build:rust
```

Verify Node/npm versions before installing dependencies. If needed, install `node@24.21.0` with mise and npm 12.2.0 inside that installation. npm 12 allows only reviewed dependency scripts in root `allowScripts`; see the contributor policy when upgrading Koffi or fsevents.

npm builds protocol, SDK and UI before Web. Cargo embeds `apps/web/dist`; rebuild Web before Cargo after a UI change. Cargo can compile library tests without those assets, but daemon startup rejects missing Web assets. `cargo build --release --bin dewbow` creates the standalone executable; it requires native Codex at runtime and does not need Node.js.

The retained TypeScript SDK remains independently usable. `npm run demo` prints read-only discovery counts. `npm run demo:history -- <session-id> 20 desc` reads private native history. Keep real results out of version control.

## Validation

```sh
mise exec -- npm run build
mise exec -- npm run typecheck
mise exec -- npm run version:check
mise exec -- npm run test:release
mise exec -- cargo fmt --all --check
mise exec -- cargo clippy --workspace --all-targets -- -D warnings
mise exec -- cargo build --workspace --bins --examples
mise exec -- cargo test --workspace --all-targets
mise exec -- npm test
git diff --check
```

The root npm test includes Rust integration checks and expects the compiled `dewbow` executable and SDK fixture. These tests use explicitly marked synthetic native storage and isolated private state. They cover lifecycle, HTTP authentication, request identity, callbacks, Unicode output, independent history and restart uncertainty. Retained TypeScript tests cover SDK adapters, protocol helpers, chat projection and navigation.

Rust source uses idiomatic snake_case identifiers while JSON uses the shared camelCase contract. Native Codex names remain native at integration boundaries. Keep generated build outputs, databases, logs and actual acceptance results in ignored directories.

## Continuous integration

[CI](../.github/workflows/ci.yml) installs pinned Node/npm and Rust on Linux, macOS and Windows. Every job builds Web before Rust, runs formatting and strict Clippy, builds all binaries/examples, and runs Rust plus retained npm tests. Linux also checks SDK package contents. The workflow has read-only repository permission and does not publish or deploy.

CI also checks the shared product version before dependency installation; release-tool tests run with the root npm test suite. The separate [Release workflow](../.github/workflows/release.yml) builds distribution archives; publication requires an explicit manual input on a matching version tag. See [Versioning and releases](releasing.md) for preparation, artifacts and the future publication procedure.

These builds and synthetic subprocess checks establish platform foundations. They do not establish real Codex, OS sandbox or multi-machine acceptance. Report actual local verification separately from configured or completed CI runs.
