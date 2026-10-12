# Workspace layout

See [Dewbow boundaries and projects](README.md) for Core and Team ownership. All npm packages share the `@dewbow` scope: Core workspace names use `@dewbow/core-*` and `core-` directories; Team uses `@dewbow/team-*` and `team-` directories. The root remains the private `@dewbow/workspace` coordinator.

The repository uses npm workspaces with one root lockfile and shared compiler settings in `tsconfig.base.json`.

| Directory | Package | Responsibility |
| --- | --- | --- |
| `packages/core-protocol/` | `@dewbow/core-protocol` | Private management records, schemas, and SQLite service journal |
| `packages/core-sdk/` | `@dewbow/core-sdk` | Local Codex discovery, saved history, and explicit execution |
| `packages/team-protocol/` | `@dewbow/team-protocol` | Team domain contract and type-only public Core projections |
| `apps/core-host-daemon/` | `@dewbow/core-host-daemon` | Owned Codex runtime, command journal, and outbound Control Plane transport |
| `apps/core-control-plane/` | `@dewbow/core-control-plane` | Authenticated management API, MCP, host gateway, and persistent records |
| `apps/core-web/` | `@dewbow/core-web` | React/TypeScript operator client with Vite development and static builds |
| `apps/team-backend/` | `@dewbow/team-backend` | Definitions, teams, members, bindings, and authenticated Core HTTP client |
| `apps/team-web/` | `@dewbow/team-web` | Independent React/TypeScript Team operator client |
| `docs/` | None | Repository setup, API, and architecture documentation |

Each workspace owns its source and compiled `dist/` output. The SDK owns its tests and examples; protocol and service workspaces own their critical persistence and integration tests. Build outputs and dependencies are ignored. The root is a private workspace coordinator, not an SDK package.

## Development

Use Node.js 24.21.0 (LTS) and npm 12.2.0. `.node-version` pins Node.js, and the root `packageManager` field pins npm. If your installed npm differs, install the pinned version before installing dependencies:

```sh
npm install --global npm@12.2.0
```

From the repository root:

With mise, enable `.node-version` support, install `node@24.21.0`, and run commands through `mise exec --`. Verify `mise exec -- node --version` and `mise exec -- npm --version` before installing dependencies. Pin npm inside that Node installation with `mise exec -- npm install --global npm@12.2.0` when required. A shell's unqualified Node or npm can resolve a different installation; use the mise prefix consistently for builds, service startup, and commits that run tool-dependent hooks.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm pack --workspace @dewbow/core-sdk --dry-run
```

npm 12 uses the root `allowScripts` field for dependency lifecycle scripts. The reviewed Koffi version may run its native setup; optional `fsevents` uses its shipped binary without install scripts. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) when reviewing script permissions during upgrades.

The explicit workspace order builds Core protocol and SDK, then Team protocol, before services. Typechecking builds their declarations first because the services resolve workspace package exports. To build one workspace, use `npm run build --workspace <package-name>`; build Core protocol first, SDK before a clean daemon build, and Team protocol before its backend or Web. The Control Plane has no SDK or daemon package dependency. Host execution stays behind its gateway.

The Web workspace uses browser-specific TypeScript settings and a separate typecheck for its Vite configuration. It imports only protocol types and has no server implementation dependencies. `npm run core:web` starts its loopback development server; `npm run core:web:preview` serves an existing static build locally. The root daemon startup command builds protocol, SDK and daemon. Control Plane startup builds protocol and its own workspace. Neither service startup builds the Web interface.

Team keeps its own backend, Web build, operator login, and SQLite database. `npm run team:backend` builds its prerequisite protocols and backend, then starts it without starting Core or a daemon. `npm run team:web` and `npm run team:web:preview` select its independent development and static preview servers. Root build, typecheck, and test commands cover both applications. See [Team documentation](team/) for its data model and operations. The imported Team workspaces originate from Dewbow Team commit `f93f120481f3c14113d38de620846db4ac1d0587`; repository configuration and local state are managed here.

The SDK package is `@dewbow/core-sdk`. Its discovery and history reads remain read-only. `CodexRuntime` supplies explicit connection and execution. Use the current Core names in consuming imports and packing commands. See [Install and operate the MVP](operations.md), [MVP interfaces](interfaces.md), [SDK guide](sdk.md), [Host daemon](host-daemon.md), [Control Plane](control-plane.md), and [Web](web.md). Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for commit hooks and local-data handling.

## Continuous integration

The [CI workflow](../.github/workflows/ci.yml) runs for pull requests targeting `main`, pushes to `main`, and manual dispatches. Pull requests and manual dispatches run Linux, macOS, and Windows jobs. Pushes to `main` run only the Linux job.

All jobs install the pinned Node.js and npm versions and run `npm ci`. Each job builds its required workspaces once, then runs the tests against the compiled output:

| Job | Build | Additional checks |
| --- | --- | --- |
| Linux | All workspaces | SDK, journal, daemon, Core and Team service/Web tests; Team-to-Core HTTP integration; SDK package contents; service configuration checks |
| macOS | All workspaces | SDK, journal, daemon, Core and Team service/Web tests, native writer lock inspection, local configuration and Team-to-Core integration |
| Windows | All workspaces | SDK, journal, daemon, Core and Team service/Web tests; private ACL, junction and environment path checks; Team-to-Core HTTP integration |

The TypeScript builds perform the server workspaces' type checks, and the Web build includes type checks for browser code and the Vite configuration. CI does not repeat the separate `typecheck` command. SDK tests run with `node --test tests/*.test.mjs` from `packages/core-sdk/` to reuse the build output. Linux checks package contents with `npm pack --workspace @dewbow/core-sdk --dry-run --ignore-scripts`; `--ignore-scripts` avoids repeating the SDK's `prepack` build. The local `typecheck`, `test`, and packing commands retain their existing behavior when run independently.

The Linux job validates the host daemon and Control Plane configuration using the compiled CLIs and synthetic configuration:

```sh
DEWBOW_HOST_ID=example-host node apps/core-host-daemon/dist/cli.js --check
node apps/core-control-plane/dist/cli.js --check
DEWBOW_TEAM_OPERATOR_TOKEN=synthetic-team-operator-credential node apps/team-backend/dist/cli.js --check
```

These configuration checks do not access local Codex data, start services, or validate a deployed environment. All platforms exercise the journal, management service with a synthetic host, and daemon with a synthetic app-server subprocess. Windows skips Unix socket fixtures; macOS writer inspection runs only on macOS. These checks do not establish live Codex execution. The workflow has read-only repository permissions and does not publish packages or deploy applications. New runs cancel older runs for the same ref, and each job has a 15-minute timeout.
