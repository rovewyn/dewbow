# Dewbow CLI

The `dewbow` executable contains the local daemon and the built Web. Node.js is a development dependency, not a Dewbow runtime requirement. Codex remains a separately installed native dependency.

## Build and prerequisites

Use the stable Rust 1.99.0 pinned in `rust-toolchain.toml`, Node.js 24.21.0 and npm 12.2.0 with the committed root lockfiles. Follow [workspace setup](workspace.md#setup-and-builds) to verify the active versions before running these commands from the repository root. mise is an [optional local environment manager](workspace.md#optional-local-environment-management). On Windows, install the MSVC C++ build tools and Windows SDK if they are missing.

```sh
npm ci
npm run build
cargo build --workspace --bins --examples
```

Build Web assets before Cargo: the daemon embeds `apps/web/dist`. A build without those assets can compile for library tests, but daemon startup refuses to serve an incomplete application. Use `cargo build --release --bin dewbow` after the Web build for the standalone executable. Keep build artifacts out of Git.

The native integration targets the independent Codex CLI 0.162.1. Install the official standalone distribution, retaining its companion binaries and resources. Do not replace Desktop's bundled runtime. On Windows, the official signed installer can be used:

```powershell
$env:CODEX_NON_INTERACTIVE = '1'
$installer = Invoke-RestMethod https://chatgpt.com/codex/install.ps1
& ([scriptblock]::Create($installer)) -Release 0.162.1
codex --version
codex login status
```

If another installation precedes it on PATH, select the independent executable explicitly. Existing Codex login, native conversations and configuration are retained.

## First start

```sh
dewbow init --codex-executable <standalone-codex-executable>
dewbow doctor
dewbow web
```

`init` creates private configuration and a stable host ID under `~/.dewbow`. `web` starts the background daemon if necessary, opens the browser with a one-use login link, and prints the ordinary loopback URL. No model turn is started automatically. Direct unauthenticated visits show instructions to use the CLI.

For an isolated checkout demo, use an ignored state directory and another available port:

```sh
dewbow --state-dir state/demo init --codex-executable <standalone-codex-executable> --port 3240
dewbow --state-dir state/demo doctor
dewbow --state-dir state/demo web
dewbow --state-dir state/demo daemon status
dewbow --state-dir state/demo daemon stop
```

All commands accept `--state-dir`. Initialization also accepts `--codex-home`; otherwise the normal `CODEX_HOME` or `~/.codex` is used. Existing configuration is preserved. Conflicting initialization options fail instead of overwriting it; edit private configuration while stopped, or choose another state directory.

## Lifecycle

`daemon run` runs in the foreground. `daemon start` launches a user background process and waits for storage, native initialization and the Web listener. Repeating start returns the existing ready instance. `daemon status` verifies the protected local endpoint against the saved instance identity. `daemon stop` shuts down its owned Codex process and verifies both process exit and listener release. There is no system service, boot startup or self-update command.

An occupied port is never adopted. A stale instance, live recorded native process or identity mismatch requires recovery rather than a PID kill. Inspect the selected directory's private log and ownership record, verify the actual processes, and stop only the intended instance. Foreground `daemon run` can recover after confirming the previous native process has exited. Do not erase native Codex storage to repair Dewbow state.

## Validation

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --bins --examples
cargo test --workspace --all-targets
node --test scripts/tests/rust-daemon.test.mjs
```

The Rust acceptance script uses an explicitly marked synthetic Codex home and the compiled SDK fixture. It covers lifecycle, operator authentication, deduplication, questions, approvals, streaming, Unicode content and restart recovery. Synthetic checks and CI builds do not establish real native or multi-machine acceptance. Keep actual screenshots and results in ignored local directories.
