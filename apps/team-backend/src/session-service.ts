import { randomUUID } from "node:crypto";
import { fail, TeamError, type ApiError, type CoreOperation, type CoreSessionDetails, type SessionBindingResult, type SessionBinding, type SessionBindingDetails, type SessionOptions } from "@dewbow/team-protocol";
import type { CoreApi, CoreOperationName } from "./core-client.js";
import { fingerprintInput, TeamStore, type RequestRecord } from "./store.js";

const mutations: Record<string, CoreOperationName> = {
  createMemberSession: "createSession", createAgentSession: "createSession", connectSessionBinding: "connectSession",
  sendBindingMessage: "sendMessage", interruptBindingTurn: "interruptTurn",
  steerBindingTurn:"steerTurn",answerBindingQuestions:"answerQuestions",
};

function publicOperation(raw: CoreOperation): CoreOperation {
  if (!raw || typeof raw.commandId !== "string" || typeof raw.sessionId !== "string" || typeof raw.requestId !== "string"
    || !["accepted", "delivered", "error", "unknown"].includes(raw.status)) fail("DELIVERY_UNCERTAIN", "Core returned an incomplete operation. Retry the original request.", true);
  return { commandId: raw.commandId, operation: raw.operation, sessionId: raw.sessionId, turnId: raw.turnId,
    requestId: raw.requestId, status: raw.status, createdAt: raw.createdAt, error: raw.error };
}

const detail = (error: unknown): ApiError => error instanceof TeamError ? error.detail
  : { code: "DELIVERY_UNCERTAIN", message: "Delivery is uncertain. Retry the original request.", retryable: true };

export class SessionService {
  private readonly inFlight = new Map<string, Promise<SessionBindingResult>>();

  constructor(private readonly store: TeamStore, readonly core: CoreApi) {}

  async execute(operation: string, input: Record<string, unknown>, caller: string): Promise<unknown> {
    switch (operation) {
      case "listWorkspaceProfiles": return this.core.call("listWorkspaceProfiles", { hostId: input.hostId });
      case "listHosts": return this.core.call("listHosts", {});
      case "listSessionBindings": return { bindings: this.store.listBindings(input.teamId as string | undefined, input.memberId as string | undefined) };
      case "getSessionBinding": return this.getDetails(this.store.getBinding(input.bindingId as string), caller);
      case "retrySessionBindingCreation": {
        const binding = this.store.getBinding(input.bindingId as string);
        const record = this.assertTarget(binding, caller);
        if (record.result && (record.result as CoreOperation).status === "delivered") return { binding, operation: record.result, error: record.error };
        const key = JSON.stringify([record.caller, record.operation, record.requestId]);
        const pending = this.inFlight.get(key);
        if (pending) return pending;
        const dispatch = this.dispatch(record, "createSession", {});
        this.inFlight.set(key, dispatch);
        try { return await dispatch; }
        finally { this.inFlight.delete(key); }
      }
      case "readBindingHistory":
      case "getBindingActivity":
      case "readBindingContent": {
        const binding = this.store.getBinding(input.bindingId as string);
        this.assertTarget(binding, caller);
        if (!binding.sessionId) fail("SESSION_NOT_READY", "Session creation has not returned an ID. Retry its original request.", true);
        const { bindingId: _bindingId, ...cursors } = input;
        const coreOperation = operation === "readBindingHistory" ? "readSessionHistory" : operation === "getBindingActivity" ? "getSessionActivity" : "readSessionContent";
        return this.core.call(coreOperation, { sessionId:binding.sessionId,...cursors });
      }
      default: return this.mutate(operation, input, caller);
    }
  }

  private assertTarget(binding: SessionBinding, caller: string): RequestRecord {
    if (!this.core.url) fail("CORE_NOT_CONFIGURED", "Configure Dewbow Core on the Team backend.");
    const creation = this.store.findRequest(binding.createCaller, binding.createOperation, binding.createRequestId);
    if (!creation?.coreInput || !creation.coreRequestId) fail("RECOVERY_REQUIRED", "The original creation request is missing.");
    if (creation.coreUrl !== this.core.url) fail("CORE_TARGET_CHANGED", "This binding belongs to a different Core endpoint. Restore its original endpoint.");
    return creation;
  }

  private async mutate(operation: string, input: Record<string, unknown>, caller: string): Promise<SessionBindingResult> {
    const coreOperation = Object.hasOwn(mutations, operation) ? mutations[operation] : undefined;
    if (!coreOperation) fail("NOT_FOUND", "Unknown session operation.");
    if (!this.core.url) fail("CORE_NOT_CONFIGURED", "Configure Dewbow Core on the Team backend.");
    const fingerprint = fingerprintInput(input);
    const requestId = input.requestId as string;
    const saved = this.store.transaction(() => {
      const existing = this.store.findRequest(caller, operation, requestId, fingerprint);
      if (existing) return existing;
      const timestamp = new Date().toISOString();
      const coreRequestId = randomUUID();
      let binding: SessionBinding;
      let coreInput: Record<string, unknown>;
      if (operation === "createMemberSession" || operation === "createAgentSession") {
        const member = operation === "createMemberSession" ? this.store.getMember(input.memberId as string) : null;
        if (member && (member.archivedAt || this.store.getTeam(member.teamId).archivedAt)) fail("TEAM_ARCHIVED", "Archived teams or members cannot create new sessions.");
        const definition = this.store.getDefinition(member ? member.definitionId : input.definitionId as string);
        binding = { bindingId: randomUUID(), memberId: member?.memberId ?? null, createCaller: caller, createOperation: operation as SessionBinding["createOperation"], workspaceProfileId: input.workspaceProfileId as string ?? null, sessionId: null, hostId: input.hostId as string,
          workDir: input.workDir as string ?? null, agentRef: { id: definition.definitionId, revision: definition.revision },
          createRequestId: requestId, createdAt: timestamp };
        coreInput = { hostId: binding.hostId, ...(binding.workspaceProfileId ? { workspaceProfileId: binding.workspaceProfileId } : { workDir: binding.workDir }), requestId: coreRequestId,
          agentRef: binding.agentRef, sessionOptions: definition.sessionOptions };
        this.store.putBinding(binding);
      } else {
        binding = this.store.getBinding(input.bindingId as string);
        this.assertTarget(binding, caller);
        if (!binding.sessionId) fail("SESSION_NOT_READY", "Session creation has not returned an ID.", true);
        coreInput = { sessionId: binding.sessionId, requestId: coreRequestId,
          ...(operation === "sendBindingMessage" ? {mode:input.mode??"default"} : ["interruptBindingTurn","steerBindingTurn","answerBindingQuestions"].includes(operation) ? {turnId:input.turnId} : {}),
          ...(operation === "answerBindingQuestions" ? {interactionId:input.interactionId} : {}) };
      }
      const record: RequestRecord = { caller, operation, requestId, fingerprint, coreRequestId, coreUrl: this.core.url,
        coreInput, bindingId: binding.bindingId, result: null, error: null, createdAt: timestamp, updatedAt: timestamp };
      this.store.putRequest(record);
      return record;
    });
    if (saved.coreUrl !== this.core.url) fail("CORE_TARGET_CHANGED", "Restore the Core endpoint used by this request.");
    const binding = this.store.getBinding(saved.bindingId!);
    const result = saved.result as CoreOperation | null;
    if (result && ["delivered", "error"].includes(result.status)) return { binding, operation: result, error: saved.error };
    if (!result && saved.error && !saved.error.retryable) return { binding, operation: null, error: saved.error };
    const key = JSON.stringify([caller, operation, requestId]);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const dispatch = this.dispatch(saved, coreOperation, input);
    this.inFlight.set(key, dispatch);
    try { return await dispatch; }
    finally { this.inFlight.delete(key); }
  }

  private async dispatch(record: RequestRecord, operation: CoreOperationName, input: Record<string, unknown>): Promise<SessionBindingResult> {
    let binding = this.store.getBinding(record.bindingId!);
    try {
      const payload={...record.coreInput,...(["sendMessage","steerTurn"].includes(operation) ? {message:input.message} : {}),...(operation === "answerQuestions" ? {answers:input.answers} : {})};
      const result = publicOperation(await this.core.call<CoreOperation>(operation, payload, true));
      if (result.requestId !== record.coreRequestId || result.operation !== operation || (binding.sessionId && result.sessionId !== binding.sessionId)) {
        fail("DELIVERY_UNCERTAIN", "Core returned an operation for a different request. Retry the original request.", true);
      }
      if (operation === "createSession") binding = { ...binding, sessionId: result.sessionId };
      this.store.transaction(() => {
        this.store.putBinding(binding);
        this.store.putRequest({ ...record, result, error: result.error, updatedAt: new Date().toISOString() });
      });
      return { binding, operation: result, error: result.error };
    } catch (cause) {
      const error = detail(cause);
      this.store.putRequest({ ...record, error, updatedAt: new Date().toISOString() });
      return { binding: this.store.getBinding(record.bindingId!), operation: record.result as CoreOperation | null, error };
    }
  }

  private async getDetails(binding: SessionBinding, caller: string): Promise<SessionBindingDetails> {
    let core: CoreSessionDetails | null = null;
    let coreError: ApiError | null = null;
    const savedCreation = this.store.findRequest(binding.createCaller, binding.createOperation, binding.createRequestId);
    const requestedOptions = savedCreation?.coreInput?.sessionOptions as SessionOptions | undefined ?? null;
    try {
      this.assertTarget(binding, caller);
      if (binding.sessionId) {
        const observed = await this.core.call<CoreSessionDetails>("getSession", { sessionId: binding.sessionId });
        if (observed?.session?.sessionId !== binding.sessionId || !Array.isArray(observed.operations)) fail("CORE_PROTOCOL_ERROR", "Core returned an invalid session view.");
        core = observed;
        if (binding.workDir !== observed.session.workDir) { binding = { ...binding, workDir: observed.session.workDir }; this.store.putBinding(binding); }
        for (const record of this.store.bindingRequests(caller, binding.bindingId)) {
          const result = core.operations.find(item => item.requestId === record.coreRequestId && item.operation === mutations[record.operation]);
          if (result) this.store.putRequest({ ...record, result: publicOperation(result), error: result.error, updatedAt: new Date().toISOString() });
        }
      }
    } catch (error) { coreError = detail(error); }
    const requests = this.store.bindingRequests(caller, binding.bindingId).map(record => ({
      operation: record.operation, requestId: record.requestId, result: record.result as CoreOperation | null,
      turnId: typeof record.coreInput?.turnId === "string" ? record.coreInput.turnId : null,
      interactionId:typeof record.coreInput?.interactionId === "string" ? record.coreInput.interactionId : null,
      mode:record.coreInput?.mode === "plan" ? "plan" as const : record.coreInput?.mode === "default" ? "default" as const : null,
      error: record.error, createdAt: record.createdAt, updatedAt: record.updatedAt,
    }));
    return { binding, requestedOptions, requests, core, coreError };
  }
}
