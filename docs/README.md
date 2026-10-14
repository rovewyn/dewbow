# Dewbow documentation

Dewbow manages Codex hosts, native conversations, execution configuration snapshots, execution, recovery, and approvals. External agents use its authenticated API or MCP tools; the operator Web interface provides visibility and human intervention.

## Ownership and projects

The Control Plane owns management metadata, authenticated API/MCP access, host connections, and approval routing. Each Host Daemon owns its local Codex runtime, working directories, execution journal, private tool content, and recovery. Codex remains the source of native conversations and saved messages. The Web interface uses the same management service and does not own execution.

| Project | Package | Responsibility |
| --- | --- | --- |
| `packages/protocol` | `@dewbow/protocol` | Management contracts, service journal, private-file and streaming helpers |
| `packages/sdk` | `@dewbow/sdk` | Local Codex discovery, saved history, and runtime integration |
| `packages/ui` | `@dewbow/ui` | Controlled ChatView, model functions, shadcn primitives, and theme |
| `apps/host-daemon` | `@dewbow/host-daemon` | Host-side Codex runtime ownership and Control Plane connection |
| `apps/control-plane` | `@dewbow/control-plane` | API, MCP, host gateway, and management state |
| `apps/web` | `@dewbow/web` | Operator interface for hosts, conversations, execution, and approvals |

All packages use the `@dewbow` npm scope. The private root `@dewbow/workspace` package coordinates builds and dependencies. Application commands are `host-daemon`, `control-plane`, and `web`; local environment commands use `local:*`. Dewbow-owned contracts remain `v1`.

The `local:up`, `local:status`, and `local:down` commands coordinate the local Control Plane, Host Daemon, and their owned Codex runtime. Per-service commands remain independent. Each daemon retains the existing configured Codex home and can run independent turns for multiple sessions.

## Guides

- [Workspace development and CI](workspace.md)
- [Local installation and operations](operations.md)
- [MVP](mvp.md)
- [API and MCP interfaces](interfaces.md)
- [SDK](sdk.md)
- [Host Daemon and workspace profiles](host-daemon.md)
- [Control Plane](control-plane.md)
- [Operator Web](web.md)
- [Chat UI](chat-ui.md)
- [Session update subscriptions](session-updates.md)
