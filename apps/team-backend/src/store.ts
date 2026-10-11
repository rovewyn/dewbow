import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { canonicalJson, defaultDefinition, fail, type AgentDefinition, type ApiError, type SessionBinding, type Team, type TeamMember } from "@dewbow-team/protocol";

type Row = Record<string, string | number | bigint | Uint8Array | null>;

export const fingerprintInput = (input: unknown): string => createHash("sha256").update(canonicalJson(input)).digest("hex");

export interface RequestRecord {
  caller: string;
  operation: string;
  requestId: string;
  fingerprint: string;
  coreRequestId: string | null;
  coreUrl: string | null;
  coreInput: Record<string, unknown> | null;
  bindingId: string | null;
  result: unknown;
  error: ApiError | null;
  createdAt: string;
  updatedAt: string;
}

export class TeamStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const version = this.db.prepare("PRAGMA user_version").get() as Row;
    if (version.user_version !== 0 && version.user_version !== 1) {
      this.db.close();
      fail("RECOVERY_REQUIRED", "Use a fresh Team database for the v1 contract.");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_definitions (
        definition_id TEXT PRIMARY KEY CHECK (definition_id != 'default'),
        name TEXT NOT NULL, description TEXT NOT NULL, revision TEXT NOT NULL,
        session_options_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS teams (
        team_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS team_members (
        member_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(team_id),
        name TEXT NOT NULL, definition_id TEXT REFERENCES agent_definitions(definition_id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS team_members_team_id ON team_members(team_id);
      CREATE TABLE IF NOT EXISTS session_bindings (
        binding_id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES team_members(member_id),
        session_id TEXT UNIQUE, host_id TEXT NOT NULL, work_dir TEXT NOT NULL,
        agent_ref_json TEXT NOT NULL, create_request_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_bindings_member_id ON session_bindings(member_id);
      CREATE TABLE IF NOT EXISTS operation_requests (
        caller TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, core_request_id TEXT, core_url TEXT, core_input_json TEXT,
        binding_id TEXT, result_json TEXT, error_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (caller, operation, request_id)
      );
      PRAGMA user_version = 1;
    `);
  }

  close(): void { this.db.close(); }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getDefinition(definitionId: string | null): AgentDefinition {
    if (!definitionId || definitionId === "default") return structuredClone(defaultDefinition);
    const row = this.db.prepare("SELECT * FROM agent_definitions WHERE definition_id = ?").get(definitionId) as Row | undefined;
    if (!row) fail("NOT_FOUND", "Agent definition was not found.");
    return this.definition(row);
  }

  listDefinitions(): AgentDefinition[] {
    const rows = this.db.prepare("SELECT * FROM agent_definitions ORDER BY name COLLATE NOCASE, definition_id").all() as Row[];
    return [structuredClone(defaultDefinition), ...rows.map(row => this.definition(row))];
  }

  private definition(row: Row): AgentDefinition {
    return {
      definitionId: row.definition_id as string, name: row.name as string, description: row.description as string,
      source: "custom", revision: row.revision as string, sessionOptions: JSON.parse(row.session_options_json as string),
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    };
  }

  putDefinition(value: AgentDefinition): void {
    this.db.prepare(`INSERT INTO agent_definitions VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(definition_id) DO UPDATE SET name=excluded.name, description=excluded.description,
      revision=excluded.revision, session_options_json=excluded.session_options_json, updated_at=excluded.updated_at`)
      .run(value.definitionId, value.name, value.description, value.revision, JSON.stringify(value.sessionOptions), value.createdAt, value.updatedAt);
  }

  deleteDefinition(definitionId: string): void {
    if (this.db.prepare("SELECT 1 FROM team_members WHERE definition_id = ? LIMIT 1").get(definitionId)) fail("DEFINITION_IN_USE", "A team member still references this definition.");
    this.db.prepare("DELETE FROM agent_definitions WHERE definition_id = ?").run(definitionId);
  }

  getTeam(teamId: string): Team {
    const row = this.db.prepare("SELECT * FROM teams WHERE team_id = ?").get(teamId) as Row | undefined;
    if (!row) fail("NOT_FOUND", "Team was not found.");
    return this.team(row);
  }

  listTeams(includeArchived = false): Team[] {
    return (this.db.prepare(`SELECT * FROM teams ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at, team_id`).all() as Row[]).map(row => this.team(row));
  }

  private team(row: Row): Team {
    return {
      teamId: row.team_id as string, name: row.name as string, description: row.description as string,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string, archivedAt: row.archived_at as string | null,
    };
  }

  putTeam(value: Team): void {
    this.db.prepare(`INSERT INTO teams VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET name=excluded.name, description=excluded.description,
      updated_at=excluded.updated_at, archived_at=excluded.archived_at`)
      .run(value.teamId, value.name, value.description, value.createdAt, value.updatedAt, value.archivedAt);
  }

  getMember(memberId: string): TeamMember {
    const row = this.db.prepare("SELECT * FROM team_members WHERE member_id = ?").get(memberId) as Row | undefined;
    if (!row) fail("NOT_FOUND", "Team member was not found.");
    return this.member(row);
  }

  listMembers(teamId: string, includeArchived = false): TeamMember[] {
    return (this.db.prepare(`SELECT * FROM team_members WHERE team_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY created_at, member_id`).all(teamId) as Row[]).map(row => this.member(row));
  }

  private member(row: Row): TeamMember {
    return {
      memberId: row.member_id as string, teamId: row.team_id as string, name: row.name as string,
      definitionId: row.definition_id as string | null, createdAt: row.created_at as string,
      updatedAt: row.updated_at as string, archivedAt: row.archived_at as string | null,
    };
  }

  putMember(value: TeamMember): void {
    this.db.prepare(`INSERT INTO team_members VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_id) DO UPDATE SET name=excluded.name, definition_id=excluded.definition_id,
      updated_at=excluded.updated_at, archived_at=excluded.archived_at`)
      .run(value.memberId, value.teamId, value.name, value.definitionId, value.createdAt, value.updatedAt, value.archivedAt);
  }

  putBinding(value: SessionBinding): void {
    this.db.prepare(`INSERT INTO session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET session_id=excluded.session_id`)
      .run(value.bindingId, value.memberId, value.sessionId, value.hostId, value.workDir,
        JSON.stringify(value.agentRef), value.createRequestId, value.createdAt);
  }

  getBinding(bindingId: string): SessionBinding {
    const row = this.db.prepare("SELECT * FROM session_bindings WHERE binding_id = ?").get(bindingId) as Row | undefined;
    if (!row) fail("NOT_FOUND", "Session binding was not found.");
    return this.binding(row);
  }

  private binding(row: Row): SessionBinding {
    return {
      bindingId: row.binding_id as string, memberId: row.member_id as string,
      sessionId: row.session_id as string | null, hostId: row.host_id as string, workDir: row.work_dir as string,
      agentRef: JSON.parse(row.agent_ref_json as string), createRequestId: row.create_request_id as string,
      createdAt: row.created_at as string,
    };
  }

  listBindings(teamId?: string, memberId?: string): SessionBinding[] {
    const rows = this.db.prepare(`SELECT b.* FROM session_bindings b JOIN team_members m ON b.member_id = m.member_id
      WHERE (? IS NULL OR m.team_id = ?) AND (? IS NULL OR b.member_id = ?) ORDER BY b.created_at, b.binding_id`)
      .all(teamId ?? null, teamId ?? null, memberId ?? null, memberId ?? null) as Row[];
    return rows.map(row => this.binding(row));
  }

  bindingRequests(caller: string, bindingId: string): RequestRecord[] {
    const keys = this.db.prepare("SELECT operation, request_id FROM operation_requests WHERE caller = ? AND binding_id = ? ORDER BY created_at, rowid").all(caller, bindingId) as Row[];
    return keys.map(row => this.findRequest(caller, row.operation as string, row.request_id as string)!);
  }

  findRequest(caller: string, operation: string, requestId: string, fingerprint?: string): RequestRecord | null {
    const row = this.db.prepare("SELECT * FROM operation_requests WHERE caller = ? AND operation = ? AND request_id = ?").get(caller, operation, requestId) as Row | undefined;
    if (!row) return null;
    if (fingerprint !== undefined && row.fingerprint !== fingerprint) fail("REQUEST_CONFLICT", "Request ID was already used with different input.");
    return {
      caller, operation, requestId, fingerprint: row.fingerprint as string,
      coreRequestId: row.core_request_id as string | null, coreUrl: row.core_url as string | null,
      coreInput: row.core_input_json ? JSON.parse(row.core_input_json as string) : null,
      bindingId: row.binding_id as string | null,
      result: row.result_json ? JSON.parse(row.result_json as string) : null,
      error: row.error_json ? JSON.parse(row.error_json as string) : null,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    };
  }

  putRequest(value: RequestRecord): void {
    this.db.prepare(`INSERT INTO operation_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(caller, operation, request_id) DO UPDATE SET
      result_json=excluded.result_json, error_json=excluded.error_json, updated_at=excluded.updated_at`)
      .run(value.caller, value.operation, value.requestId, value.fingerprint, value.coreRequestId, value.coreUrl,
        value.coreInput ? JSON.stringify(value.coreInput) : null, value.bindingId,
        value.result === null ? null : JSON.stringify(value.result), value.error ? JSON.stringify(value.error) : null,
        value.createdAt, value.updatedAt);
  }

  mutate(caller: string, operation: string, input: Record<string, unknown>, work: () => unknown): unknown {
    const fingerprint = fingerprintInput(input);
    const requestId = input.requestId as string;
    return this.transaction(() => {
      const saved = this.findRequest(caller, operation, requestId, fingerprint);
      if (saved) return saved.result;
      const result = work();
      const timestamp = new Date().toISOString();
      this.putRequest({ caller, operation, requestId, fingerprint, coreRequestId: null, coreUrl: null,
        coreInput: null, bindingId: null, result, error: null, createdAt: timestamp, updatedAt: timestamp });
      return result;
    });
  }
}
