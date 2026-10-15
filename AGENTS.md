# Repository Guidelines

## Project Structure & Module Organization

Read the repository's entry-point documentation and applicable directory-level instructions before making changes. Inspect the existing structure, dependency manifests, lockfiles, and available commands. Do not assume a framework, runtime, package manager, or deployment platform.

Read `CONTRIBUTING.md` for contributor setup and the commit workflow. After cloning, install Gitleaks with support for the `git` command and run `sh scripts/install-hooks.sh` before making commits.

Keep the root `README.md` as simple as possible: a brief project introduction and a statement that documentation is in `docs/`. A link to the `docs/` directory is allowed. Do not link to individual documentation files from the root README unless the user explicitly requests those links. Put detailed setup, API, architecture, and usage documentation in files under `docs/`. Keep repository policy and contributor instructions in their corresponding root files, including `AGENTS.md` and `CONTRIBUTING.md`, with their full content.

Keep long-lived documentation focused on the current design, supported behavior and rules that continue to apply. Put release-specific changes, one-time upgrade or migration transitions, compatibility exceptions and release-specific rollback requirements in `docs/release-notes/<version>.md`. General guides may link to relevant release notes without repeating historical procedures. Keep current operational constraints in the general guides even when a particular release introduced them.

Read `[workspace.package].version` in the root `Cargo.toml` to identify the current development target. Run `npm run version:check` to print that version and verify its synchronized manifests and lockfiles, then consult `docs/release-notes/<that-version>.md`. Keep that file marked unreleased until publication. At the start of the next development cycle, set the agreed target with `npm run version:set -- <version>` and create its unreleased notes; do not infer the development target from the latest published tag or introduce another version source. Changing a development version does not authorize tagging or publication.

Keep related code and resources together. Follow established directory boundaries and naming patterns. Update operating instructions when a change affects setup, configuration, commands, or expected behavior.

Dewbow owns local host identity, native conversation references, configuration snapshots, execution, recovery, and approvals. Keep the executable in `apps/cli`, its daemon library in `apps/daemon`, the operator interface in `apps/web`, management contracts in `packages/protocol` (including its Rust crate), native Codex integration in `packages/sdk` (including its Rust crate), and browser presentation in `packages/ui`. The daemon embeds Web assets and directly owns a native Codex app-server. All browser operations use operator authority. Remote networks, MCP and external agent access are deferred.

Keep generated files, caches, dependency installations, and temporary outputs out of version control unless the repository explicitly tracks them. Preserve user-created files and local results during cleanup.

## Setup & Development Commands

Use the repository's documented runtime versions, package manager, and lockfiles. Prefer existing scripts and reproducible installation commands. Avoid changing dependencies or introducing tools without a clear need for the task.

Use the documented build, development, preview, and validation commands. If commands are missing, inspect the project before choosing them. Document reusable commands and required environment variable names without including secret values.

Run `git diff --check` when reviewing changes and `git diff --cached --check` before committing.

## Coding Style & Naming Conventions

Match the surrounding code and the conventions of each language. Use descriptive names, keep changes focused, and reuse existing abstractions before adding new ones.

Use English for repository documentation, code comments, and other written project artifacts.

Preserve public interfaces and established behavior unless the task requires a change. Explain non-obvious constraints, lifecycle assumptions, and tradeoffs where they affect maintenance.

Keep the Web API design in `docs/interfaces.md` and its machine-readable contract in `docs/openapi.yaml` aligned with the Rust daemon's routes, validation, authentication, response shapes and session update semantics. Review both when changing the operator HTTP surface. Distinguish private CLI control operations from the Web contract.

For user interfaces, preserve semantic content, accessibility, and responsive behavior. Release resources when their owner is torn down.

For retained generated assets, preserve source outputs and record exact prompts, exposed tool parameters, and integration notes. Do not invent model names, versions, seeds, or other unavailable metadata. Remove unused assets and temporary design files created by the task.

### Naming conventions

Use the shared `@dewbow` npm scope, with names matching their directories, such as `@dewbow/protocol`, `@dewbow/sdk`, and `@dewbow/web`. The private root coordinator is `@dewbow/workspace`. Rust crate names use the `dewbow-` prefix; the only application executable is `dewbow`. Keep the ownership and project map in `docs/README.md` current.

Use `camelCase` for Dewbow-owned TypeScript and JavaScript variables, functions, methods, object properties, and configuration keys. Use the same field names in HTTP requests and responses, MCP inputs and results, SDK types, and Web application objects. For example, use `hostId`, `sessionId`, `requestId`, `sessionOptions`, and `instructionsAppend`.

Use verb-first `camelCase` for Dewbow-owned management operations and MCP tool names, such as `createSession` and `listSessions`.

Use lowercase plural `snake_case` for SQLite table names, such as `records`, `events`, and `session_configs`. Use lowercase `snake_case` for SQL column names, such as `session_id` and `created_at`.

Use `camelCase` for JSON fields stored in SQLite so they match the TypeScript objects. Keep SQL column-to-object mappings in the storage layer. Preserve externally defined names, including native Codex protocol and configuration fields, at integration boundaries; translate them in the adapter when needed.

Treat names in released interfaces, configuration and persisted records as compatibility-sensitive. Review renames for upgrade and client impact, and include the required migration or transition within the authorized change. Keep internal naming changes focused on the task.

## Compatibility and State Evolution

Dewbow has published releases. Preserve supported released configuration, management state and public behavior across upgrades, including during `0.x` development. Determine compatibility from published tags and their actual formats, rather than the current manifest version or fresh-install tests. Record supported source releases, support-window changes and explicitly approved transition exceptions in the target release's notes. See [management storage and compatibility](docs/storage.md) for the storage format and upgrade requirements.

Version the management storage format independently of the product and public contracts. Review SQL structure, stored JSON fields, request fingerprint semantics and recovery associations as part of that format. Keep compatible changes within the existing public contract version; an incompatible contract change needs an explicit transition plan and coordinated daemon/client updates. A version label does not permit silent breaking changes.

Database format changes require an ordered, versioned migration for supported released state. Validate the source format before writes; reject unsupported, malformed or newer formats without resetting them or rewriting their version. Migrate under exclusive daemon ownership before native startup or request admission, after the previous daemon and its owned native runtime have stopped, with a verified recoverable backup and transactional or explicitly recoverable failure handling. Commit the schema version only with the corresponding data changes. Preserve host/session/native identities, frozen configuration, request IDs and fingerprints, delivery receipts, and active or uncertain recovery associations. Never turn uncertain delivery into success or replay a native request or callback during migration.

Do not drop or recreate released tables, erase request receipts, or substitute fresh state as an ordinary upgrade path. State resets require explicit authorization and documented consequences for identity, deduplication and recovery. Unsupported development-only state may have a separately documented reset path. Preserve native Codex conversations, credentials and unrelated files throughout. Verify upgrades using synthetic fixtures matching supported released formats, including restart after interruption, duplicate retries and failure recovery. Document rollback limits before release; restoring an old snapshot after accepting new work can lose receipts and permit duplicate execution.

## Database Ownership Boundary

Codex is the only durable source of conversation history and native execution status. Read messages, tool items, command output, file diffs, ordering, and completed turn status from native Codex storage through the SDK. History, activity, and content reads must never write to Dewbow's database. Do not persist native metadata snapshots, derived presentation objects, raw protocol items, output chunks, or a second conversation/event history.

The state directory is Dewbow's private local data directory for configuration, management storage, runtime ownership files and daemon diagnostics. It defaults to `~/.dewbow` (`%USERPROFILE%\.dewbow` on Windows or `$HOME/.dewbow` on POSIX); all CLI commands accept `--state-dir <directory>` to select another directory. Use the same selection for initialization and subsequent management commands so restarts reuse the retained request receipts and recovery state. Conversation working files belong to their `workDir`, while native Codex conversations and credentials belong to the separately selected Codex home. See [state directory operations](docs/operations.md#state-directory) for file purposes and directory selection.

Dewbow owns one live SQLite database, `daemon.sqlite`, in each selected state directory, shared by all conversations managed through that directory. Private inactive backup copies for upgrade and recovery are allowed; they must not become additional runtime stores or content archives. Durable records are limited to managed conversation bindings and frozen creation configuration, request deduplication receipts (request identity, input fingerprint, required target associations, and delivery outcome), and the minimum active or uncertain execution and process ownership information needed for recovery. Do not retain completed native turn status as a parallel history. Remove obsolete recovery records when their outcome is confirmed; keep uncertain delivery explicit and never infer success from missing callbacks. Runtime display state is rebuilt from Codex after restart.

Question and approval details, answers, callback identities, live messages/output, and bounded notification buffers are runtime memory only. Release callbacks when their turn ends; evict live content after native persistence is confirmed or its buffer limit is reached, and release all volatile content with its runtime. Browser refresh must not invalidate a pending callback, but daemon restart must invalidate callbacks tied to the previous native process. Persist the associated request receipt before responding to a native callback; do not replay approvals automatically. Reconnection restores managed bindings and the saved configuration, then reads actual native state. A stopped or interrupted native turn must never be presented as continuing solely because it was active before shutdown.

Historical command output is exactly what Codex retained; Dewbow does not keep an independent complete-output archive. Treat potentially truncated native output as having unknown completeness. Do not restore a separate content database, durable event stream, or content cache without an explicitly authorized change to this boundary. Evolve supported Dewbow storage through the compatibility process above; do not migrate, erase, or reset native Codex data.

## Validation Guidelines

Choose validation that matches the change and the repository's existing practices. Run relevant checks and inspect the affected behavior directly.

Write only the minimum necessary unit tests. Add a unit test only when it protects critical behavior or a meaningful regression that existing checks do not cover. Reuse or extend existing tests before adding new ones. Do not add tests for trivial code, simple getters or formatting, or tests that merely repeat the implementation. Do not increase test count or coverage for its own sake.

For visual changes, inspect the result in the target application or browser. Check relevant viewport sizes, interaction states, and accessibility behavior. Use manual visual review where automated checks cannot establish correctness.

Record the commands run, their results, and any checks that were skipped. Distinguish local verification, simulated observations, real environment execution, and deployed acceptance. Do not claim broader success than the available evidence supports.

## Local Preview

When the task includes a local preview, open it for the user and share its URL. Prefer a loopback address and use an available port.

Starting a preview does not authorize a push, merge, or deployment.

## Git Workflow & Cleanup

Before editing, inspect the current branch, working tree, upstream, and remote default branch. Refresh remote references when available. Preserve uncommitted changes and unrelated work; do not reset or overwrite them to obtain a clean checkout.

Keep commits focused on the requested change.

After a pull request is merged, remove its local and remote feature branches:

1. Confirm the pull request is merged and neither branch contains new or unmerged work. For squash merges, verify that all branch changes are present in the remote default branch.
2. Delete the remote feature branch, then run `git fetch --prune <remote>`.
3. Switch away from the local feature branch. In a primary clone, switch to the default branch and update it with `git merge --ff-only <remote>/<default-branch>`. In a linked worktree, use `git switch --detach <remote>/<default-branch>`.
4. Delete the local feature branch and verify that both feature branches are gone.

Preserve branches used by other worktrees. If cleanup would affect unrelated work, leave the affected branch in place and report the reason.

As part of post-merge cleanup, stop local preview servers started for that pull request. Verify that the processes have exited and their listening ports have been released. Preserve previews still used by other ongoing work or explicitly requested to remain running.

## Commit & Pull Request Guidelines

Use Conventional Commits for commit messages and pull request titles: `type(scope): description`, with an optional scope.

The project has no affiliation with any GitHub user named `dewbow`. To avoid sending that person unintended notifications, do not include `@dewbow` in commit message titles or bodies, including when describing the npm namespace or scoped packages. Use wording such as "the dewbow npm scope" or unscoped package names instead.

Describe the problem, resulting behavior, and purpose of the change. Include relevant validation results, disclose omitted checks, and link issues when applicable. Keep descriptions focused on the final implementation.

Review staged files before committing. Honor repository-specific restrictions on reports, measurements, screenshots, logs, and other outputs before including them in commits or pull requests.

Stage only the files required for the current change. Inspect `git diff --cached --name-status` and `git diff --cached` before committing. Keep unrelated or unfinished work uncommitted.

## Security & Configuration

Never commit credentials, tokens, cookies, private profiles, personal data, or machine-specific configuration. Use synthetic data and placeholders in examples. Redact sensitive information before sharing logs, screenshots, URLs, or reports.

Never include machine-specific absolute filesystem paths from a real local environment in committed content. Use repository-relative paths, environment variables, or generic placeholders instead. Standard platform paths required by code or tooling, including system library paths and interpreter shebangs, and clearly synthetic paths used in tests or examples are allowed.

Never include the current local operating system user's real name or username in committed content. Redact it or use a generic placeholder instead. This rule applies to all files included in a commit, including source files, documentation, configuration examples, fixtures, and retained generated assets.

Keep local environment files, Codex session exports, databases, machine paths, runtime state, raw logs, screenshots, and measured results out of commits and pull requests. Use the ignored local output directories listed in `CONTRIBUTING.md`. Commit only synthetic fixtures and configuration examples with placeholder values. Publishing local results requires explicit user authorization and a separate review for sensitive data.

Run all configured commit hooks and security checks. Missing required tools, scan errors, or findings block commits. Do not bypass hooks with `--no-verify`; fix the issue, restage changes, and rerun the checks.

Every commit must pass the versioned pre-commit hook, including `git diff --cached --check` and `gitleaks git --pre-commit --staged --redact`. Gitleaks scans for secrets; it does not replace the staged-file review for personal data, machine-specific paths, or local results. Do not weaken the scan or add exclusions to make a finding pass.

Review relevant security policies when changing resource loading, permissions, or external integrations. Keep development-only exceptions out of production configuration.

Treat publishing, deployment, shared environment changes, and release configuration as separate operations. Perform them only within the user's authorized scope.
