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

The root Cargo workspace builds Rust. The private `@dewbow/workspace` npm workspace builds retained TypeScript packages and Web. Dewbow-owned contracts remain `v1`. The earlier TypeScript Control Plane and Host Daemon have been removed. Network enrollment and membership management are available through the CLI; direct Network native reads and subscriptions are available through the operator API. Remote native mutations and scoped receipt recovery are also available through the operator API. Network management and remote conversations are available in the operator Web. MCP and external agent management remain deferred.

## Guides

- [Install and upgrade](installation.md)
- [CLI setup and commands](cli.md)
- [Daemon ownership and recovery](daemon.md)
- [Management storage and compatibility](storage.md)
- [Workspace development and CI](workspace.md)
- [Versioning and releases](releasing.md)
- [Versioned upgrade acceptance](upgrade-acceptance.md)
- [Network operation, recovery and acceptance](network-acceptance.md)
- [Release notes](release-notes/README.md)
- [Local operations](operations.md)
- [Current scope](mvp.md)
- [Web API](interfaces.md)
- [OpenAPI contract](openapi.yaml)
- [SDK](sdk.md)
- [Operator Web](web.md)
- [Chat UI](chat-ui.md)
- [Session update subscriptions](session-updates.md)
- [Network membership engine](network-membership-engine.md) describes the independent Rust validator, candidate transitions and caller commit contract.
- [Network peer transport](network-peers.md) describes authenticated connections, membership reconciliation, configuration and CLI lifecycle recovery.
- [Remote Network execution](network-execution.md) describes direct typed operations, scoped receipts, authority and conservative recovery.

## Network design and contracts

- [Decentralized Network design](network-design.md) defines membership, automatic merges, forks and offline return behavior.
- [Network protocol v1](network-protocol.md) specifies signed records, validation, peer exchange, departure delivery and request admission.
- [Network storage, keys and crash recovery](network-storage-design.md) defines implemented local tables, protected keys, transaction boundaries and interrupted-state recovery.

These documents specify the implemented first-scope Network. Use the operational guides for CLI/Web workflows and [Network acceptance](network-acceptance.md) for validation coverage and limits. Check the target release's notes for publication status and supported transitions.
