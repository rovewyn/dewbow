# Team data model and management API

The v1 contract uses camelCase JSON and verb-first operations at `POST /api/<operation>`. Responses are `{ result: ... }` or `{ error: { code, message, retryable } }`. IDs are opaque strings; timestamps are ISO 8601 UTC. Every new write requires `requestId`, scoped to caller and operation. Explicit creation retries use the ID already recorded for their binding. Identical input returns the original result across restarts; changed input returns `REQUEST_CONFLICT`.

## Definitions and members

`AgentDefinition` contains `definitionId`, `name`, `description`, `source`, `revision`, `sessionOptions`, `createdAt`, and `updatedAt`. The built-in `default` is immutable code data with revision `1`, empty options, and null timestamps. It has no database row. Reads of default never query the definitions table. Lists combine code data with custom rows.

Custom definitions use server-generated IDs and revisions. `sessionOptions` permits only `model`, `reasoningEffort`, and `instructionsAppend`, matching Core limits. Model availability is checked by Core on the host. A custom definition with empty options remains custom. Updating requires `expectedRevision`; a stale revision fails with `REVISION_CONFLICT`. The revision increments on every accepted update, independently of the `v1` API contract. Default writes fail with `DEFAULT_READ_ONLY`.

`Team` groups `TeamMember` records. A member stores a name and nullable `definitionId`; the member is an agent position, not a human account. On creation, an omitted, null, empty, or `default` selection becomes null and selects the code default. On update, omission preserves the existing selection; an explicit empty selection resets to default. Missing custom IDs fail rather than fall back. A definition may serve multiple members. Member references prevent definition deletion, including archived member references.

Teams and members use `archivedAt` rather than hard deletion. Archived teams reject new members. Session integration also rejects new sessions for archived teams or members; existing bindings remain readable and reconnectable.

| Operations | Input beyond `requestId` for writes | Result |
| --- | --- | --- |
| `listAgentDefinitions` | none | `{ definitions }` |
| `getAgentDefinition` | optional `definitionId` | `{ definition }` |
| `createAgentDefinition` | `name`, optional `description`, `sessionOptions` | `{ definition }` |
| `updateAgentDefinition` | `definitionId`, `expectedRevision`, optional changed fields | `{ definition }` |
| `deleteAgentDefinition` | `definitionId`, `expectedRevision` | `{ definitionId }` |
| `listTeams` | optional `includeArchived` | `{ teams }` |
| `getTeam` | `teamId`, optional `includeArchived` for members | `{ team, members }` |
| `createTeam` | `name`, optional `description` | `{ team }` |
| `updateTeam` | `teamId`, optional `name`, `description` | `{ team }` |
| `archiveTeam` | `teamId` | `{ team }` |
| `addTeamMember` | `teamId`, `name`, optional `definitionId` | `{ member }` |
| `updateTeamMember` | `memberId`, optional `name`, `definitionId` | `{ member }` |
| `archiveTeamMember` | `memberId` | `{ member }` |

## Storage

SQLite tables are `agent_definitions`, `teams`, `team_members`, `session_bindings`, and `operation_requests`. Columns use snake_case; stored JSON uses camelCase. Storage maps SQL columns to public objects. Foreign keys protect member references. Local mutations and their deduplication results commit in one transaction. Request fingerprints are SHA-256 digests. Bindings retain historical `agentRef` metadata without a foreign key to a mutable definition.

No migration or compatibility layer is provided. Stop Team before replacing an obsolete Team database, and preserve Core state and native Codex conversations. Use fresh synthetic databases for verification. Team does not store Core credentials, native messages, or execution configuration authority in its database.
