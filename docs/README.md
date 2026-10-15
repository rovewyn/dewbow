# Dewbow documentation

Dewbow manages local Codex conversations, execution, recovery and approvals through a Rust CLI and daemon with an embedded Web interface.

## Ownership and projects

Codex owns native conversations, messages and credentials. The daemon owns local management references, configuration snapshots, request identities, tool content and execution. Web is an operator client; closing it does not stop a turn.

| Directory | Project | Responsibility |
| --- | --- | --- |
| `apps/cli` | `dewbow-cli` | The single `dewbow` executable, initialization, diagnosis, upgrades and user background processes |
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
- [Workspace development and CI](workspace.md)
- [Versioning and releases](releasing.md)
- [Local operations](operations.md)
- [Current scope](mvp.md)
- [Web API](interfaces.md)
- [SDK](sdk.md)
- [Operator Web](web.md)
- [Chat UI](chat-ui.md)
- [Session update subscriptions](session-updates.md)
