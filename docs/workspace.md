# Workspace layout

The repository uses npm workspaces with one root lockfile and shared compiler settings in `tsconfig.base.json`.

| Directory | Package | Responsibility |
| --- | --- | --- |
| `packages/protocol/` | `@dewbow/protocol` | Private management records, schemas, and SQLite service journal |
| `packages/sdk/` | `@dewbow/sdk` | Local Codex discovery, saved history, and explicit execution |
| `apps/host-daemon/` | `@dewbow/host-daemon` | Owned Codex runtime, command journal, and outbound Control Plane transport |
| `apps/control-plane/` | `@dewbow/control-plane` | Authenticated management API, MCP, host gateway, and persistent records |
| `apps/web/` | `@dewbow/web` | React/TypeScript operator client with Vite development and static builds |
| `docs/` | None | Repository setup, API, and architecture documentation |

Each workspace owns its source and compiled `dist/` output. The SDK owns its tests and examples; protocol and service workspaces own their critical persistence and integration tests. Build outputs and dependencies are ignored. The root is a private workspace coordinator, not an SDK package.

## Development

Use Node.js 24.21.0 (LTS) and npm 12.2.0. `.node-version` pins Node.js, and the root `packageManager` field pins npm. If your installed npm differs, install the pinned version before installing dependencies:

```sh
npm install --global npm@12.2.0
```

From the repository root:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm pack --workspace @dewbow/sdk --dry-run
```

npm 12 uses the root `allowScripts` field for dependency lifecycle scripts. The reviewed Koffi version may run its native setup; optional `fsevents` uses its shipped binary without install scripts. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) when reviewing script permissions during upgrades.

The explicit workspace order builds protocol and SDK before services. Typechecking builds their declarations first because the services resolve workspace package exports. To build one workspace, use `npm run build --workspace <package-name>`; build protocol first and SDK before a clean daemon build. The Control Plane has no SDK or daemon package dependency. Host execution stays behind its gateway.

The Web workspace uses browser-specific TypeScript settings and a separate typecheck for its Vite configuration. It imports only protocol types and has no server implementation dependencies. `npm run web` starts its loopback development server; `npm run web:preview` serves an existing static build locally. The root daemon startup command builds protocol, SDK and daemon. Control Plane startup builds protocol and its own workspace. Neither service startup builds the Web interface.

The SDK package name changed from `dewbow` to `@dewbow/sdk`. Its discovery and history reads remain read-only. `CodexRuntime` supplies explicit connection and execution. Update consuming imports and packing commands. See [Install and operate the MVP](operations.md), [MVP interfaces](interfaces.md), [SDK guide](sdk.md), [Host daemon](host-daemon.md), [Control Plane](control-plane.md), and [Web](web.md). Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for commit hooks and local-data handling.

## Continuous integration

The [CI workflow](../.github/workflows/ci.yml) runs for pull requests targeting `main`, pushes to `main`, and manual dispatches. Pull requests and manual dispatches run Linux and macOS jobs. Pushes to `main` run only the Linux job.

Both jobs install the pinned Node.js and npm versions and run `npm ci`. Each job builds its required workspaces once, then runs the SDK tests against the compiled output:

| Job | Build | Additional checks |
| --- | --- | --- |
| Linux | All workspaces | SDK, journal, daemon, service and Web projection tests; SDK package contents; service configuration checks |
| macOS | Protocol and SDK | Journal and SDK tests, including the native writer lock test that Linux skips |

The TypeScript builds perform the server workspaces' type checks, and the Web build includes type checks for browser code and the Vite configuration. CI does not repeat the separate `typecheck` command. SDK tests run with `node --test tests/*.test.mjs` from `packages/sdk/` to reuse the build output. Linux checks package contents with `npm pack --workspace @dewbow/sdk --dry-run --ignore-scripts`; `--ignore-scripts` avoids repeating the SDK's `prepack` build. The local `typecheck`, `test`, and packing commands retain their existing behavior when run independently.

The Linux job validates the host daemon and Control Plane configuration using the compiled CLIs and synthetic configuration:

```sh
DEWBOW_HOST_ID=example-host node apps/host-daemon/dist/cli.js --check
node apps/control-plane/dist/cli.js --check
```

These configuration checks do not access local Codex data, start services, or validate a deployed environment. The protocol journal test runs on both platforms. Linux also exercises the management service with a synthetic host and the daemon with a synthetic app-server subprocess. These checks do not establish live Codex execution. The workflow has read-only repository permissions and does not publish packages or deploy applications. New runs cancel older runs for the same ref, and each job has a 15-minute timeout.
