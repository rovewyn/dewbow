# Contributing

## Workspace development

Use Rust 1.99.0 stable, Node.js 24.21.0 LTS and npm 12.2.0 with the committed root Cargo and npm lockfiles. Rust is pinned in `rust-toolchain.toml`, Node in `.node-version`, and npm in `packageManager`. Verify the active versions before running the documented `npm`, `cargo` and `node` commands directly. Local environment managers such as mise are optional; see [local environment management](docs/workspace.md#optional-local-environment-management). Run `npm ci` at the repository root. The root Cargo workspace contains `apps/cli`, `apps/daemon`, `packages/protocol/rust` and `packages/sdk/rust`. Retained npm workspaces are `packages/protocol`, `packages/sdk`, `packages/ui` and `apps/web`. Keep dependency versions in the corresponding root lockfile.

Use the latest LTS release for runtimes and dependencies that offer LTS; otherwise, use the latest stable release. Keep `@types/node` on the runtime's major version. Validate upgrades before updating the pinned versions and lockfile. See [Workspace development and CI](docs/workspace.md) for setup and automated checks.

npm 12 blocks dependency install scripts unless the root `allowScripts` field permits them. Koffi's native setup is approved only for its pinned version. The optional macOS `fsevents` package uses its shipped native binary, so its install scripts remain denied. Review `npm install-scripts ls` and the relevant scripts when upgrading dependencies; approve only required scripts for the reviewed versions.

Run `npm run build:rust` to build TypeScript/Web and then all Rust binaries and examples. The daemon embeds built Web assets, so Web must be built first. Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace --all-targets`, `npm run typecheck` and `npm test`. The npm test command includes Rust integration tests and requires the compiled SDK fixture. Tests use synthetic state and cover native adapters, management identity, lifecycle, callbacks, streaming and recovery. `npm run demo` prints read-only discovery counts. `npm run demo:history -- <session-id> 20 desc` prints private native history. `npm pack --workspace @dewbow/sdk --dry-run` checks the independently retained TypeScript SDK contents.

Use `dewbow init`, `dewbow doctor` and `dewbow web` for local native setup. `dewbow daemon run` runs in the foreground; `start`, `status` and `stop` manage a user background process. All commands accept `--state-dir`. See [CLI operations](docs/cli.md) for the independent Codex installer and Windows build prerequisites. The TypeScript Control Plane and Host Daemon have been removed; their private state is preserved and is not migrated.

`npm run web` starts Vite at `http://127.0.0.1:5173`; `npm run web:preview` serves static assets at `http://127.0.0.1:4173`. Both bind loopback and require an available port; use `-- --port <port>` to choose another. Stop them with Ctrl+C. Full integration uses the embedded Web at the Rust daemon origin. Development-only proxies forward API/auth to the default daemon; static preview has no API proxy. See `docs/web.md` for development authentication and browser checks.

Write only the necessary unit tests described in `AGENTS.md`. Use synthetic temporary fixtures. Keep real discovery results in ignored local directories and out of package contents.

Run `npm run version:check` and `npm run test:release` when changing manifests or release tooling. Product versions are synchronized from the root Cargo workspace with `npm run version:sync`; `npm run version:set -- <version>` prepares a new version without tagging or publishing. See [Versioning and releases](docs/releasing.md) for release PRs and the separately authorized publication workflow.

Use separate ignored state and work directories for real demos. The compiled Dewbow executable needs no Node.js. See [installation and upgrades](docs/installation.md) for release installers and the explicit upgrade command. Remote enrollment, automatic background updates, system services and boot startup are deferred.

## Enable commit checks

On Windows, `npm --version` must report 12.2.0 and `node --version` must report v24.21.0 before installing dependencies. Install Gitleaks from a trusted distribution with the `git` scan command. If `sh` is not on PATH, run the hook installer using Git for Windows' `sh.exe`. The same environment must expose Gitleaks when committing, including when an optional environment manager is used. See [local operations](docs/operations.md#windows-runtime-and-private-state) for standalone Codex and Windows state protection.

Install Gitleaks with support for the `git` command. On macOS with Homebrew:

```sh
brew install gitleaks
```

Then run this command from the repository:

```sh
sh scripts/install-hooks.sh
```

The installer enables the versioned hooks in `.githooks/`. It checks that Gitleaks is available and that the pre-commit hook is executable. It refuses to replace another `core.hooksPath` or active hooks in Git's default hooks directory. Integrate existing hooks before retrying; do not disable them.

Hook activation is local Git configuration and is not distributed by cloning. Run the installer in each clone. Linked worktrees share local repository configuration, so each worktree used for commits must have the versioned hook files checked out. Confirm the hook is present and enabled before committing:

```sh
git config --get core.hooksPath
test -x .githooks/pre-commit
```

The expected configuration value is `.githooks`.

## Review and commit

1. Check the branch, working tree, upstream, and remote default branch. Refresh remote references when available. Preserve unrelated work and use a feature branch.
2. Run the checks required for the change and review `git diff --check`.
3. Stage explicit file paths for the current change. Do not use `git add .` when unrelated or unfinished files are present.
4. Inspect the staged files and their full contents:

   ```sh
   git diff --cached --name-status
   git diff --cached
   git diff --cached --check
   ```

5. Create a focused commit with a Conventional Commit message, such as `chore: improve commit checks`.
6. Push the feature branch and open a pull request to `main`. Describe the resulting behavior and relevant validation. Merge pull requests to `main` with squash.
7. After the pull request is merged, follow the branch cleanup steps in `AGENTS.md` and stop local preview servers started for that pull request. Confirm that their processes have exited and their ports have been released. Preserve previews needed by other ongoing work or explicitly requested to remain running.

The pre-commit hook checks staged whitespace and runs:

```sh
gitleaks git --pre-commit --staged --redact --no-banner
```

Missing Gitleaks, scan errors, and findings block the commit. Output redacts detected secret values. Fix the affected files, stage the corrected contents, and retry. Do not use `--no-verify`, disable the hook, or weaken the scanner to bypass a failure.

Gitleaks scans staged changes for secrets. It does not inspect every local file or establish that personal data and machine paths are safe to publish. Review the complete staged diff even when the scan passes. Git hooks also require local activation; the committed hook files alone do not enforce checks on other contributors' machines.

## Keep local data private

Do not commit credentials, tokens, cookies, private profiles, personal data, machine-specific configuration, local environment values, or absolute paths from a real machine. Configuration examples may include variable names and placeholder values. The `.env.example` exception is for placeholders only.

Keep Codex session exports, local databases, runtime state, raw logs, screenshots, traces, and measured results outside the repository or in these ignored root directories:

- `.demo/`, `state/`, and `outputs/`
- `data/`, `results/`, and `reports/`
- `artifacts/` and `logs/`

The ignore rules also cover common environment files, private key files, local `.aws/` and `.codex/` directories, dependency installations, and caches. Ignore rules do not protect already tracked files or files staged with `git add -f`.

Use synthetic fixtures and placeholders for committed examples. Do not copy real session data into fixtures or embed local findings in pull request text. Publishing local results requires explicit user authorization and a separate sensitive-data review. Keep authorized publication separate from code changes.
