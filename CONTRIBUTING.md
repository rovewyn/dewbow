# Contributing

## Workspace development

Use Node.js 24.21.0 and npm 12.2.0 with the committed root `package-lock.json`. The runtime is pinned in `.node-version`, and npm is pinned in the root `packageManager` field. Run `npm ci` at the repository root. Core workspaces are `packages/core-protocol` (`@dewbow/core-protocol`), `packages/core-sdk` (`@dewbow/core-sdk`), `apps/core-host-daemon` (`@dewbow/core-host-daemon`), `apps/core-control-plane` (`@dewbow/core-control-plane`), and `apps/core-web` (`@dewbow/core-web`). Team workspaces are `packages/team-protocol` (`@dewbow/team-protocol`), `apps/team-backend` (`@dewbow/team-backend`), and `apps/team-web` (`@dewbow/team-web`). Keep dependency versions and installation in the root lockfile.

Use the latest LTS release for runtimes and dependencies that offer LTS; otherwise, use the latest stable release. Keep `@types/node` on the runtime's major version. Validate upgrades before updating the pinned versions and lockfile. See [Workspace development and CI](docs/workspace.md) for setup and automated checks.

npm 12 blocks dependency install scripts unless the root `allowScripts` field permits them. Koffi's native setup is approved only for its pinned version. The optional macOS `fsevents` package uses its shipped native binary, so its install scripts remain denied. Review `npm install-scripts ls` and the relevant scripts when upgrading dependencies; approve only required scripts for the reviewed versions.

Run `npm run build` to build all workspaces in dependency order, then `npm run typecheck` and `npm test`. Typechecking builds both protocols and SDK declarations before checking services. Tests cover the SDK, shared service journal, daemon runtime, Core and Team management, both Web history projections, and Team-to-Core HTTP integration with synthetic state. `npm run core:demo` runs discovery once and prints summary counts. `npm run core:demo:history -- <session-id> 20 desc` reads one page of a session's chat history and prints private conversation content. `npm pack --workspace @dewbow/core-sdk --dry-run` checks the SDK delivery contents and builds the package first.

`DEWBOW_HOST_ID=example-host npm run core:host-daemon -- --check` validates host daemon configuration without accessing Codex. `npm run core:control-plane -- --check` validates listener configuration without opening storage. Normal Control Plane startup requires the credentials and permitted-host file documented in `docs/control-plane.md`; normal host daemon startup requires the credentials and local Codex setup in `docs/host-daemon.md`. See `docs/operations.md` for the reproducible `local:init`, service startup and `local:smoke` commands, and `docs/` for workspace boundaries.

`npm run core:web` starts the Web interface at `http://127.0.0.1:5173`. `npm run build --workspace @dewbow/core-web` typechecks and builds its static assets, then `npm run core:web:preview` serves that build at `http://127.0.0.1:4173`. Both listeners use loopback and require an available port; use `-- --port <port>` with either root command to select another port. Stop them with Ctrl+C. For full integration, use the built Web at the Control Plane origin. Vite development proxies the default local API; static preview has no API proxy. The service startup commands build only their required workspaces. See `docs/web.md` for the browser boundary and manual checks.

Write only the necessary unit tests described in `AGENTS.md`. Use synthetic temporary fixtures. Keep real discovery results in ignored local directories and out of package contents.

`npm run team:backend` starts the independent Team backend after building its prerequisites; `npm run team:check` validates its configuration with `DEWBOW_TEAM_OPERATOR_TOKEN` set. `npm run team:web` starts Team UI development at `http://127.0.0.1:5174`; `npm run team:web:preview` serves its built assets at `http://127.0.0.1:4174`. For a complete preview, use Team's backend origin at `http://127.0.0.1:3100`. `npm run local:init` adds a separate Team credential and configuration while preserving existing Core values, then `npm run local:team:backend` starts the built backend. See [Team workspace](docs/team/workspace.md) for configuration and [local operations](docs/operations.md) for both applications.

## Enable commit checks

With mise on Windows, use the repository runtime explicitly: `mise exec -- npm --version` must report 12.2.0 and `mise exec -- node --version` must report v24.21.0. If needed, run `mise install node@24.21.0` and `mise exec -- npm install --global npm@12.2.0`. Install Gitleaks through mise (`mise use --global gitleaks@8.30.1`) or another trusted distribution with the `git` scan command. Run the hook installer using Git for Windows' `sh.exe` inside `mise exec --` when `sh` is not on PATH. The same environment must expose Gitleaks when committing. See [local operations](docs/operations.md#windows-runtime-and-private-state) for standalone Codex and Windows state protection.

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
