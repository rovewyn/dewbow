import { useState, type FormEvent } from "react";
import type { AgentDefinition, ApiError, SessionOptions } from "@dewbow/team-protocol";
import { call, errorDetail } from "./api.js";
import { Badge, ConfirmAction, Empty, ErrorNotice, Modal, PageHeading, field } from "./ui.js";
import { useMutation } from "./useMutation.js";

function DefinitionForm({ definition, onClose, onSaved }: { definition: AgentDefinition | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [baseline, setBaseline] = useState(definition);
  const [reloadError, setReloadError] = useState<ApiError | null>(null);
  const mutation = useMutation<{ definition: AgentDefinition }>(async () => { onClose(); await onSaved(); });
  const builtin = baseline?.source === "builtin";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const model = field(form, "model").trim();
    const effort = field(form, "reasoningEffort").trim();
    const instructions = field(form, "instructionsAppend");
    const sessionOptions: SessionOptions = { ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}), ...(instructions ? { instructionsAppend: instructions } : {}) };
    await mutation.send(baseline ? "updateAgentDefinition" : "createAgentDefinition", {
      name: field(form, "name"), description: field(form, "description"), sessionOptions,
      ...(baseline ? { definitionId: baseline.definitionId, expectedRevision: baseline.revision } : {}),
    });
  }
  return <Modal title={builtin ? "Default Codex" : baseline ? "Edit definition" : "New definition"} onClose={onClose} busy={mutation.busy}>
    {builtin ? <div className="form-body"><Badge tone="purple">Built-in · read-only</Badge><p className="lead">Use the host's Codex baseline, with no session overrides.</p><p className="muted">Create a custom definition to choose a model, reasoning effort, or additional instructions.</p><div className="info-grid"><div><span>Model</span><strong>From host</strong></div><div><span>Reasoning</span><strong>From host</strong></div></div></div>
      : <form onSubmit={event => void submit(event)}>
        <div className="form-body"><fieldset disabled={mutation.busy || mutation.retryRequired} key={baseline?.revision ?? "new"}>
          <label>Name<input name="name" defaultValue={baseline?.name} required maxLength={200} placeholder="Editor" autoFocus /></label>
          <label>Description<input name="description" defaultValue={baseline?.description} maxLength={4096} placeholder="Reviews drafts before publication" /></label>
          <div className="two-columns"><label>Model<input name="model" defaultValue={baseline?.sessionOptions.model} maxLength={200} placeholder="Inherit host default" /></label><label>Reasoning effort<input name="reasoningEffort" defaultValue={baseline?.sessionOptions.reasoningEffort} maxLength={200} placeholder="Inherit host default" /></label></div>
          <label>Additional instructions<textarea name="instructionsAppend" rows={7} defaultValue={baseline?.sessionOptions.instructionsAppend} maxLength={100000} placeholder="Review the draft. Preserve the author's meaning." /></label>
          <p className="field-hint">Applied once to new sessions. Existing sessions keep their original configuration.</p>
        </fieldset><ErrorNotice error={mutation.error} onRetry={mutation.retryRequired ? mutation.retry : undefined} />
        <ErrorNotice error={reloadError} />{mutation.error?.code === "REVISION_CONFLICT" && baseline && <button type="button" className="button secondary" onClick={() => void call<{ definition: AgentDefinition }>("getAgentDefinition", { definitionId: baseline.definitionId }).then(result => { setBaseline(result.definition); mutation.resetError(); setReloadError(null); }).catch(cause => setReloadError(errorDetail(cause)))}>Reload latest definition</button>}</div>
        <footer className="form-footer"><button type="button" className="button secondary" disabled={mutation.busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={mutation.busy || mutation.retryRequired}>{mutation.busy ? "Saving…" : "Save definition"}</button></footer>
      </form>}
  </Modal>;
}

export function DefinitionsPage({ definitions, refresh }: { definitions: AgentDefinition[]; refresh: () => Promise<void> }) {
  const [editor, setEditor] = useState<AgentDefinition | "new" | null>(null);
  const [deleting, setDeleting] = useState<AgentDefinition | null>(null);
  return <>
    <PageHeading eyebrow="AGENT LIBRARY" title="Agent definitions" description="Reusable behavior for the agents in your teams." actions={<button className="button primary" onClick={() => setEditor("new")}>+ New definition</button>} />
    <div className="notice subtle"><span className="notice-symbol" aria-hidden="true">↗</span><div><strong>Start from Codex. Override what you need.</strong><p>Default inherits the host configuration. Custom definitions add the behavior for each role.</p></div></div>
    <div className="card-grid">{definitions.map(definition => <article className="definition-card card" key={definition.definitionId}>
      <div className="card-top"><span className={`avatar ${definition.source === "builtin" ? "default-avatar" : ""}`}>{definition.name.slice(0, 1)}</span><Badge tone={definition.source === "builtin" ? "purple" : "neutral"}>{definition.source === "builtin" ? "Built-in" : `Revision ${definition.revision}`}</Badge></div>
      <h2>{definition.name}</h2><p className="card-description">{definition.description || "Custom Codex behavior."}</p>
      <div className="definition-options"><span>Model <strong>{definition.sessionOptions.model ?? "From host"}</strong></span><span>Reasoning <strong>{definition.sessionOptions.reasoningEffort ?? "From host"}</strong></span></div>
      <footer className="card-actions"><button className="button secondary small" onClick={() => setEditor(definition)}>{definition.source === "builtin" ? "View definition" : "Edit definition"}</button>{definition.source === "custom" && <button className="text-button danger-text" onClick={() => setDeleting(definition)}>Delete</button>}</footer>
    </article>)}</div>
    {!definitions.length && <Empty title="Loading definitions">Your built-in default will appear here.</Empty>}
    {editor && <DefinitionForm definition={editor === "new" ? null : editor} onClose={() => setEditor(null)} onSaved={refresh} />}
    {deleting && <ConfirmAction title="Delete definition" operation="deleteAgentDefinition" input={{ definitionId: deleting.definitionId, expectedRevision: deleting.revision }} actionLabel="Delete definition" danger onClose={() => setDeleting(null)} onSaved={refresh}><p>Delete <strong>{deleting.name}</strong>? Members must switch to another definition first. Existing sessions keep their saved configuration.</p></ConfirmAction>}
  </>;
}
