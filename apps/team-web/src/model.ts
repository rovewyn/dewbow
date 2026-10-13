import type { AgentDefinition, SessionBinding, Team, TeamMember } from "@dewbow/team-protocol";

export interface Catalog {
  definitions: AgentDefinition[];
  teams: Team[];
  members: TeamMember[];
  bindings: SessionBinding[];
  service: { coreConfigured: boolean; coreUrl: string | null };
}

export interface Route {
  page: "teams" | "definitions" | "sessions" | "channels";
  teamId?: string;
  bindingId?: string;
}

export function readRoute(): Route {
  const params = new URLSearchParams(location.hash.slice(1));
  const page = params.get("page");
  return { page: page === "definitions" || page === "sessions" || page === "channels" ? page : "teams",
    ...(params.get("team") ? { teamId: params.get("team")! } : {}),
    ...(params.get("session") ? { bindingId: params.get("session")! } : {}) };
}
