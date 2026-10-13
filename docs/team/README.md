# Dewbow Team documentation

Dewbow Team is the agent organization workspace. It owns agent definitions, teams, members, and session bindings. A member is an agent position, and a binding associates it with a Core session.

Dewbow Core is the execution platform. It owns hosts, native conversations, execution configuration snapshots, execution, recovery, and approvals. Team requests session actions through Core's authenticated HTTP API; the Core credential stays on the Team backend. Team has its own storage, startup commands, and operator authentication. See [Dewbow boundaries and projects](../README.md) for the ownership map.

The built-in default definition lives in code. Custom definitions live in Team storage. Session creation freezes the selected definition; recovery uses the original Core session and its saved configuration.

Dewbow-owned contracts remain `v1` during early development.

- [Workspace development](workspace.md)
- [Data model and management API](data-model.md)
- [Member sessions and Core integration](sessions.md)
- [Operator Web interface](web.md)

- [Agent chat channels and isolated workspaces](channels.md)
