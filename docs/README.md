# Dewbow documentation

Dewbow manages local Codex conversations, execution, recovery and approvals through a Rust CLI and daemon with an embedded Web interface.

## Ownership and projects

Codex owns native conversations, history, tool content, execution status and credentials. The daemon owns local management references, configuration snapshots, request identities and execution control. Each private [state directory](operations.md#state-directory) holds its configuration, management storage, runtime ownership files and daemon diagnostics. Its single database retains only management and recovery records; pending interactions and live content stay in memory. Web is an operator client; closing it does not stop a turn.

| Directory | Project | Responsibility |
| --- | --- | --- |
| `apps/cli` | `dewbow-cli` | The single `dewbow` executable, initialization, diagnosis, independent upgrade supervision and recovery, and user background processes |
| `apps/daemon` | `dewbow-daemon` | Local management, persistence, owned Codex runtime and embedded Web |
| `packages/protocol` | `@dewbow/protocol`, `rust/dewbow-protocol` | TypeScript and Rust management contracts and shared helpers |
| `packages/sdk` | `@dewbow/sdk`, `rust/dewbow-sdk` | Native Codex integration, read-only discovery and history |
| `packages/ui` | `@dewbow/ui` | Shared controlled ChatView, presentation and theme |
| `apps/web` | `@dewbow/web` | React/TypeScript operator interface |

The root Cargo workspace builds Rust. The private `@dewbow/workspace` npm workspace builds retained TypeScript packages and Web. Dewbow-owned contracts remain `v1`. The earlier TypeScript Control Plane and Host Daemon have been removed. Network enrollment, remote routing, MCP and external agent management are deferred.

## Guides

- [Install and upgrade](installation.md)
- [CLI setup and commands](cli.md)
- [Daemon ownership and recovery](daemon.md)
- [Management storage and compatibility](storage.md)
- [Workspace development and CI](workspace.md)
- [Versioning and releases](releasing.md)
- [Release notes](release-notes/README.md)
- [Local operations](operations.md)
- [Current scope](mvp.md)
- [Web API](interfaces.md)
- [OpenAPI contract](openapi.yaml)
- [SDK](sdk.md)
- [Operator Web](web.md)
- [Chat UI](chat-ui.md)
- [Session update subscriptions](session-updates.md)

## Design proposals

- [Decentralized Network design](network-design.md) records the agreed product behavior; Network functionality is not implemented.
