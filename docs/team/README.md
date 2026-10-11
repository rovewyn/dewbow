# Dewbow Team documentation

Dewbow Team owns agent definitions, teams, members, and session bindings. Dewbow Core owns hosts, native conversations, execution, and recovery.

The built-in default definition lives in code. Custom definitions live in Team storage. Session creation freezes the selected definition; recovery uses the original Core session and its saved configuration.

Dewbow-owned contracts remain `v1` during early development.

- [Workspace development](workspace.md)
- [Data model and management API](data-model.md)
- [Member sessions and Core integration](sessions.md)
- [Operator Web interface](web.md)
