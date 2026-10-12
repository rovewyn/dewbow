import { canonicalJson, fail } from "@dewbow-core/protocol";
import type { ResolvedSessionConfig, SessionOptions, WorkspaceSandbox } from "@dewbow-core/protocol";
import type { ConnectSessionOptions } from "@dewbow-core/sdk";
import type { Runtime } from "./runtime.js";

interface Model {
  model: string; isDefault: boolean; defaultReasoningEffort: string | null;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}

async function readModels(runtime: Runtime): Promise<Model[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const page = await runtime.request("model/list", { includeHidden: true, ...(cursor ? { cursor } : {}) });
    models.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  return models;
}

/** Read native configuration locally; persist only the session fields Dewbow manages. */
export async function resolveSessionConfig(runtime: Runtime, cwd: string, options: SessionOptions, hostModel?: string): Promise<ResolvedSessionConfig> {
  const { config } = await runtime.request("config/read", { cwd, includeLayers: false });
  const models = await readModels(runtime);
  const modelName = options.model ?? hostModel ?? config.model ?? models.find(model => model.isDefault)?.model;
  const model = models.find(model => model.model === modelName);
  if (!model) fail("INVALID_INPUT", "The selected session model is unavailable on this host.");
  const reasoningEffort = options.reasoningEffort ?? config.model_reasoning_effort ?? model.defaultReasoningEffort ?? null;
  if (reasoningEffort !== null && !model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === reasoningEffort)) fail("INVALID_INPUT", "The selected reasoning effort is unsupported by this model.");
  const workspace = config.sandbox_workspace_write ?? {};
  return {
    model: model.model, modelProvider: config.model_provider ?? "openai", reasoningEffort,
    developerInstructions: [config.developer_instructions ?? "", options.instructionsAppend ?? ""].filter(Boolean).join("\n\n"),
    approvalPolicy: "on-request", approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: workspace.writable_roots ?? [], networkAccess: workspace.network_access ?? false,
      excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var ?? false, excludeSlashTmp: workspace.exclude_slash_tmp ?? false },
  };
}

export async function checkSavedModel(runtime: Runtime, config: ResolvedSessionConfig): Promise<void> {
  const model = (await readModels(runtime)).find(model => model.model === config.model);
  if (!model || (config.reasoningEffort !== null && !model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === config.reasoningEffort))) fail("RECOVERY_REQUIRED", "The saved model or reasoning effort is no longer available on this host.");
}

/** Native config keys belong at this adapter boundary, never in the public overrides. */
export function sessionThreadOptions(cwd: string, config: ResolvedSessionConfig): ConnectSessionOptions {
  if (config.approvalPolicy !== "on-request" || config.approvalsReviewer !== "user" || config.sandbox.type !== "workspaceWrite") fail("RECOVERY_REQUIRED", "Saved session execution policy is unsupported.");
  return { cwd, model: config.model, modelProvider: config.modelProvider, developerInstructions: config.developerInstructions,
    approvalPolicy: config.approvalPolicy, approvalsReviewer: config.approvalsReviewer, sandbox: "workspace-write",
    config: {
      ...(config.reasoningEffort === null ? {} : { model_reasoning_effort: config.reasoningEffort }),
      sandbox_workspace_write: { writable_roots: config.sandbox.writableRoots, network_access: config.sandbox.networkAccess,
        exclude_tmpdir_env_var: config.sandbox.excludeTmpdirEnvVar, exclude_slash_tmp: config.sandbox.excludeSlashTmp },
    },
  };
}

function observedSandbox(value: any): WorkspaceSandbox {
  if (value?.type !== "workspaceWrite" || !Array.isArray(value.writableRoots) || value.writableRoots.some((root: unknown) => typeof root !== "string") ||
      [value.networkAccess, value.excludeTmpdirEnvVar, value.excludeSlashTmp].some(flag => typeof flag !== "boolean")) fail("RECOVERY_REQUIRED", "Codex returned an unsupported sandbox policy.");
  return { type: "workspaceWrite", writableRoots: value.writableRoots, networkAccess: value.networkAccess,
    excludeTmpdirEnvVar: value.excludeTmpdirEnvVar, excludeSlashTmp: value.excludeSlashTmp };
}

/** A changed model or policy is an error, not an implicit fallback during recovery. */
export function confirmSessionConfig(config: ResolvedSessionConfig, result: any): void {
  if (result.model !== config.model || result.modelProvider !== config.modelProvider || result.reasoningEffort !== config.reasoningEffort ||
      result.approvalPolicy !== config.approvalPolicy || result.approvalsReviewer !== config.approvalsReviewer ||
      canonicalJson(observedSandbox(result.sandbox)) !== canonicalJson(config.sandbox)) fail("RECOVERY_REQUIRED", "Codex did not retain the saved session model or execution policy.");
}
