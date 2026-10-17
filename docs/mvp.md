# Current Dewbow scope

Dewbow provides a single `dewbow` executable containing a Rust CLI, local daemon and embedded operator Web. Codex remains independently installed and owns native conversations, messages and credentials.

The operator initializes private state, checks native capabilities with `doctor`, and opens authenticated Web with `web`. The daemon manages local execution independently of browser lifetime. [Network operation and acceptance](network-acceptance.md) defines decentralized membership and recovery, and separates synthetic validation from physical LAN/VPN and live native acceptance.

This version includes native discovery and bounded history, explicit adoption of an existing native ID, creation with frozen execution settings, Default and Plan turns, steering, question cards, single-request approvals, interruption, tool output/diffs, durable request deduplication and conservative restart recovery. One session has at most one active or unresolved turn; independent sessions may execute concurrently.

Web retains its existing React/TypeScript UI and `v1` camelCase API/SSE contracts. All browser calls use operator authority. The production executable needs no Node.js. Operator Web listens on loopback; the optional separate HTTPS Peer listener uses explicitly configured LAN/VPN addresses. CLI launches a user background process, without installing a system service or boot startup.

Standalone release installers and an explicit `dewbow upgrade` command support local installation and upgrades. Upgrade checks and downloads use GitHub Releases; automatic background updates and package-registry publication are deferred.

Network creation, confirmed joining, membership synchronization and removal/self-exit are available through the CLI over reachable LAN/VPN connections. Direct cross-machine native-session reads and subscriptions are available through the operator API. Typed remote execution and scoped receipt recovery are also available through the operator API. The operator Web exposes Network lifecycle management and remote conversations from any member. Relay and MCP/external agent management remain deferred. Team channels, DingTalk and member workspace profiles are not supported.

The TypeScript Control Plane and Host Daemon have been removed. Their private local state is preserved and is not migrated. The retained SDK, UI and protocol packages continue to have independent uses.

See [CLI](cli.md), [daemon](daemon.md) and [Web API](interfaces.md) for concrete behavior and limits.
