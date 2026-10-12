import { fail } from "./index.js";

interface Field {
  type: "string" | "boolean" | "integer" | "object";
  nullable?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Field>;
  required?: string[];
}

const id: Field = { type: "string", minLength: 1, maxLength: 200 };
const name: Field = { ...id };
const description: Field = { type: "string", minLength: 0, maxLength: 4096 };
const selection: Field = { type: "string", minLength: 0, maxLength: 200, nullable: true };
const bool: Field = { type: "boolean" };
const options: Field = { type: "object", properties: {
  model: id, reasoningEffort: id,
  instructionsAppend: { type: "string", minLength: 0, maxLength: 100000 },
} };
const object = (properties: Record<string, Field>, required: string[] = []): Field => ({ type: "object", properties, required });
const workDir: Field = { type: "string", minLength: 1, maxLength: 4096 };

export const inputSchemas: Record<string, Field> = {
  listAgentDefinitions: object({}),
  getAgentDefinition: object({ definitionId: selection }),
  createAgentDefinition: object({ name, description, sessionOptions: options, requestId: id }, ["name", "requestId"]),
  updateAgentDefinition: object({ definitionId: id, name, description, sessionOptions: options, expectedRevision: id, requestId: id }, ["definitionId", "expectedRevision", "requestId"]),
  deleteAgentDefinition: object({ definitionId: id, expectedRevision: id, requestId: id }, ["definitionId", "expectedRevision", "requestId"]),
  listTeams: object({ includeArchived: bool }),
  getTeam: object({ teamId: id, includeArchived: bool }, ["teamId"]),
  createTeam: object({ name, description, requestId: id }, ["name", "requestId"]),
  updateTeam: object({ teamId: id, name, description, requestId: id }, ["teamId", "requestId"]),
  archiveTeam: object({ teamId: id, requestId: id }, ["teamId", "requestId"]),
  addTeamMember: object({ teamId: id, name, definitionId: selection, requestId: id }, ["teamId", "name", "requestId"]),
  updateTeamMember: object({ memberId: id, name, definitionId: selection, requestId: id }, ["memberId", "requestId"]),
  archiveTeamMember: object({ memberId: id, requestId: id }, ["memberId", "requestId"]),
  getServiceInfo: object({}),
  listHosts: object({}),
  createMemberSession: object({ memberId: id, hostId: workDir, workDir, requestId: id }, ["memberId", "hostId", "workDir", "requestId"]),
  listSessionBindings: object({ teamId: id, memberId: id }),
  getSessionBinding: object({ bindingId: id }, ["bindingId"]),
  retryMemberSessionCreation: object({ bindingId: id }, ["bindingId"]),
  connectMemberSession: object({ bindingId: id, requestId: id }, ["bindingId", "requestId"]),
  sendMemberMessage: object({ bindingId: id, message: { type: "string", minLength: 1, maxLength: 100000 }, requestId: id }, ["bindingId", "message", "requestId"]),
  interruptMemberTurn: object({ bindingId: id, turnId: id, requestId: id }, ["bindingId", "turnId", "requestId"]),
  readMemberSessionHistory: object({ bindingId:id,cursor:{ type:"integer",minimum:0 },beforeCursor:workDir,afterCursor:workDir,updateCursor:workDir,limit:{ type:"integer",minimum:1,maximum:500 } },["bindingId"]),
  getMemberSessionActivity: object({ bindingId:id,itemId:workDir },["bindingId","itemId"]),
  readMemberSessionContent: object({ bindingId:id,contentId:workDir,contentCursor:workDir,limitBytes:{ type:"integer",minimum:4,maximum:262144 } },["bindingId","contentId"]),
};

function validate(field: Field, value: unknown, path: string): unknown {
  if (value === null && field.nullable) return null;
  if (field.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT", `${path} must be an object.`);
    const input = value as Record<string, unknown>;
    for (const key of field.required ?? []) if (!Object.hasOwn(input, key)) fail("INVALID_INPUT", `${path}.${key} is required.`);
    return Object.fromEntries(Object.entries(input).map(([key, item]) => {
      const child = field.properties && Object.hasOwn(field.properties, key) ? field.properties[key] : undefined;
      if (!child) fail("INVALID_INPUT", `Unknown field: ${path}.${key}.`);
      return [key, validate(child, item, `${path}.${key}`)];
    }));
  }
  if (field.type === "string" && (typeof value !== "string" || value.length < (field.minLength ?? 1)
    || value.length > (field.maxLength ?? 4096) || ((field.minLength ?? 1) > 0 && !value.trim()))) fail("INVALID_INPUT", `Invalid ${path}.`);
  if (field.type === "boolean" && typeof value !== "boolean") fail("INVALID_INPUT", `${path} must be a boolean.`);
  if (field.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < (field.minimum ?? 0) || value > (field.maximum ?? Number.MAX_SAFE_INTEGER))) fail("INVALID_INPUT", `Invalid ${path}.`);
  return value;
}

export function validateInput(operation: string, input: unknown): Record<string, unknown> {
  const schema = Object.hasOwn(inputSchemas, operation) ? inputSchemas[operation] : undefined;
  if (!schema) fail("NOT_FOUND", "Unknown operation.");
  return validate(schema, input, "input") as Record<string, unknown>;
}

export function normalizeDefinitionId(value: unknown): string | null {
  return value === undefined || value === null || value === "" || value === "default" ? null : value as string;
}
