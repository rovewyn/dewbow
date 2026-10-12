# Dewbow documentation

Dewbow has two applications: Core is the Codex execution platform, and Team is the agent organization workspace. The root `@dewbow/workspace` package coordinates their builds and dependencies.

## Ownership and integration

| Concern | Owner | Boundary |
| --- | --- | --- |
| Hosts and native conversation inventory | Core | Team reads available hosts through Core's HTTP API; it has no host registry. |
| Conversation execution, turns, interruption, and recovery | Core | Team requests actions for a member's bound session; Core owns runtime state and recovery. |
| Effective execution configuration | Core | Core resolves and persists the creation snapshot and reuses it when reconnecting. |
| Agent definitions and revisions | Team | A reusable definition supplies the model, reasoning effort, and additional instructions requested for a new session. |
| Teams, members, and session bindings | Team | A member is an agent position. Its bindings associate that position with Core sessions. |
| Conversation history | Core and native Codex storage | Team reads history through Core rather than keeping another conversation store. |
| Execution approval decisions | Core | Team shows pending state and links to Core. Team administration grants no approval authority. |
| Service storage and operator authentication | Each application | Core and Team retain separate databases, credentials, startup commands, and login flows. |

Team's backend holds the Core management credential and calls the authenticated Core HTTP API. Its Web client never receives that credential or imports Core server or SDK implementations. Shared public protocol types do not transfer domain ownership.

Creating a member session freezes the selected definition's revision and requested options. Core records the actual resolved execution configuration. Changing the definition affects future sessions. Existing sessions reconnect using their original configuration. Core treats `agentRef` as provenance and does not resolve Team definitions or memberships.

Core can be used directly by an external API or MCP client without Team. Team can manage definitions, teams, and members without Core, while session execution requires Core. Current Team behavior organizes members and their sessions; task scheduling, member-to-member handoffs, and shared task state are outside its current scope.

## Projects and names

All npm packages share the `@dewbow` scope. Core directories and package names use the `core-` prefix; Team directories and package names use `team-`. The private root coordinator is `@dewbow/workspace`. Root application commands use `core:*` or `team:*`; commands that load local environment files use `local:core:*` or `local:team:*`. Contract versions remain `v1`.

| Project | Package | Responsibility |
| --- | --- | --- |
| `packages/core-protocol` | `@dewbow/core-protocol` | Core management contracts and service journal |
| `packages/core-sdk` | `@dewbow/core-sdk` | Local Codex discovery, saved history, and runtime integration |
| `apps/core-host-daemon` | `@dewbow/core-host-daemon` | Host-side Codex runtime ownership and Core connection |
| `apps/core-control-plane` | `@dewbow/core-control-plane` | Core API, MCP, host gateway, and management state |
| `apps/core-web` | `@dewbow/core-web` | Core operator interface for hosts, conversations, and approvals |
| `packages/team-protocol` | `@dewbow/team-protocol` | Team domain contracts and public Core type projections |
| `apps/team-backend` | `@dewbow/team-backend` | Definitions, teams, members, bindings, and Core API integration |
| `apps/team-web` | `@dewbow/team-web` | Team operator workspace for agents and member sessions |

## Guides

- [Workspace development and CI](workspace.md)
- [Local installation and operations](operations.md)
- [Core MVP](mvp.md)
- [Core API and MCP interfaces](interfaces.md)
- [Core SDK](sdk.md)
- [Core host daemon](host-daemon.md)
- [Core Control Plane](control-plane.md)
- [Core operator Web](web.md)
- [Team documentation](team/)
