import { randomUUID } from "node:crypto";
import { defaultDefinition, fail, normalizeDefinitionId, validateInput, type AgentDefinition, type SessionOptions, type Team, type TeamMember } from "@dewbow/team-protocol";
import { TeamStore } from "./store.js";

export class TeamManagement {
  constructor(readonly store: TeamStore) {}

  execute(operation: string, rawInput: unknown, caller = "operator"): unknown {
    const input = validateInput(operation, rawInput);
    switch (operation) {
      case "listAgentDefinitions": return { definitions: this.store.listDefinitions() };
      case "getAgentDefinition": return { definition: this.store.getDefinition(normalizeDefinitionId(input.definitionId)) };
      case "listTeams": return { teams: this.store.listTeams(input.includeArchived === true) };
      case "getTeam": return { team: this.store.getTeam(input.teamId as string), members: this.store.listMembers(input.teamId as string, input.includeArchived === true) };
      default: return this.store.mutate(caller, operation, input, () => this.write(operation, input));
    }
  }

  private write(operation: string, input: Record<string, unknown>): unknown {
    const timestamp = new Date().toISOString();
    switch (operation) {
      case "createAgentDefinition": {
        const definition: AgentDefinition = {
          definitionId: randomUUID(), name: (input.name as string).trim(), description: input.description as string ?? "",
          source: "custom", revision: "1", sessionOptions: input.sessionOptions as SessionOptions ?? {}, createdAt: timestamp, updatedAt: timestamp,
        };
        this.store.putDefinition(definition);
        return { definition };
      }
      case "updateAgentDefinition":
      case "deleteAgentDefinition": {
        if (input.definitionId === defaultDefinition.definitionId) fail("DEFAULT_READ_ONLY", "The built-in default definition is read-only.");
        const old = this.store.getDefinition(input.definitionId as string);
        if (old.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "The definition changed. Reload it before editing.");
        if (operation === "deleteAgentDefinition") {
          this.store.deleteDefinition(old.definitionId);
          return { definitionId: old.definitionId };
        }
        const definition: AgentDefinition = {
          ...old, name: (input.name as string | undefined)?.trim() ?? old.name,
          description: input.description as string ?? old.description,
          sessionOptions: input.sessionOptions as SessionOptions ?? old.sessionOptions,
          revision: (BigInt(old.revision) + 1n).toString(), updatedAt: timestamp,
        };
        this.store.putDefinition(definition);
        return { definition };
      }
      case "createTeam": {
        const team: Team = { teamId: randomUUID(), name: (input.name as string).trim(), description: input.description as string ?? "", createdAt: timestamp, updatedAt: timestamp, archivedAt: null };
        this.store.putTeam(team);
        return { team };
      }
      case "updateTeam":
      case "archiveTeam": {
        const old = this.store.getTeam(input.teamId as string);
        const team: Team = { ...old, name: (input.name as string | undefined)?.trim() ?? old.name,
          description: input.description as string ?? old.description, updatedAt: timestamp,
          archivedAt: operation === "archiveTeam" ? old.archivedAt ?? timestamp : old.archivedAt };
        this.store.putTeam(team);
        return { team };
      }
      case "addTeamMember": {
        const team = this.store.getTeam(input.teamId as string);
        if (team.archivedAt) fail("TEAM_ARCHIVED", "The team is archived.");
        const definitionId = normalizeDefinitionId(input.definitionId);
        this.store.getDefinition(definitionId);
        const member: TeamMember = { memberId: randomUUID(), teamId: team.teamId, name: (input.name as string).trim(), definitionId, createdAt: timestamp, updatedAt: timestamp, archivedAt: null };
        this.store.putMember(member);
        return { member };
      }
      case "updateTeamMember":
      case "archiveTeamMember": {
        const old = this.store.getMember(input.memberId as string);
        const definitionId = Object.hasOwn(input, "definitionId") ? normalizeDefinitionId(input.definitionId) : old.definitionId;
        if (Object.hasOwn(input, "definitionId")) this.store.getDefinition(definitionId);
        const member: TeamMember = { ...old, name: (input.name as string | undefined)?.trim() ?? old.name, definitionId,
          updatedAt: timestamp, archivedAt: operation === "archiveTeamMember" ? old.archivedAt ?? timestamp : old.archivedAt };
        this.store.putMember(member);
        return { member };
      }
      default: fail("NOT_FOUND", "Unknown operation.");
    }
  }
}
