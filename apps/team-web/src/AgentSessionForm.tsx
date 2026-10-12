import { useEffect, useState } from "react";
import type { CoreHost, SessionBindingResult, SessionBinding } from "@dewbow/team-protocol";
import { call, errorDetail } from "./api.js";
import type { Catalog } from "./model.js";
import { ErrorNotice, Modal, field } from "./ui.js";
import { useMutation } from "./useMutation.js";

export function WorkspaceTarget({ hostId, workspaceProfileId }: { hostId?: string; workspaceProfileId?: string }) {
  const [hosts, setHosts] = useState<CoreHost[]>([]), [selected, setSelected] = useState(hostId ?? "");
  const [profiles, setProfiles] = useState<{ profileId: string; name: string; kind: string }[]>([]);
  const [error, setError] = useState<ReturnType<typeof errorDetail> | null>(null);
  useEffect(() => { const controller = new AbortController(); void call<{ hosts: CoreHost[] }>("listHosts", {}, controller.signal).then(value => setHosts(value.hosts)).catch(cause => { if (!controller.signal.aborted) setError(errorDetail(cause)); }); return () => controller.abort(); }, []);
  useEffect(() => {
    setProfiles([]); if (!selected) return; const controller = new AbortController();
    void call<{ profiles: { profileId: string; name: string; kind: string }[] }>("listWorkspaceProfiles", { hostId: selected }, controller.signal).then(value => { setProfiles(value.profiles); setError(null); }).catch(cause => { if (!controller.signal.aborted) setError(errorDetail(cause)); });
    return () => controller.abort();
  }, [selected]);
  return <><label>Host<select name="hostId" required value={selected} onChange={event => setSelected(event.target.value)}><option value="">Select a host</option>{hosts.map(host => <option key={host.hostId} value={host.hostId} disabled={host.status !== "connected"}>{host.name} · {host.status}</option>)}</select></label><label>Workspace profile<select key={selected + profiles.map(value => value.profileId).join()} name="workspaceProfileId" required defaultValue={workspaceProfileId ?? ""}><option value="">Select an isolated workspace</option>{profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.name} · {profile.kind === "gitWorktree" ? "Git worktree" : "Empty directory"}</option>)}</select></label>{selected && !profiles.length && !error && <p className="field-hint">This host has no available workspace profiles.</p>}<ErrorNotice error={error} /></>;
}

export function AgentSessionForm({ catalog, onClose, onCreated }: { catalog: Catalog; onClose: () => void; onCreated: (binding: SessionBinding) => Promise<void> }) {
  const mutation = useMutation<SessionBindingResult>(async result => { onClose(); await onCreated(result.binding); });
  return <Modal title="New agent session" onClose={onClose} busy={mutation.busy}><form onSubmit={event => { event.preventDefault(); void mutation.send("createAgentSession", { definitionId: field(event.currentTarget, "definitionId"), hostId: field(event.currentTarget, "hostId"), workspaceProfileId: field(event.currentTarget, "workspaceProfileId") }); }}><div className="form-body"><fieldset disabled={mutation.busy || mutation.retryRequired}><label>Agent definition<select name="definitionId" required>{catalog.definitions.map(value => <option key={value.definitionId} value={value.definitionId}>{value.name}</option>)}</select></label><WorkspaceTarget /><p className="field-hint">Core prepares a separate workspace for this session. Its configuration is frozen at creation.</p></fieldset><ErrorNotice error={mutation.error} onRetry={mutation.retryRequired ? mutation.retry : undefined} /></div><footer className="form-footer"><button type="button" className="button secondary" onClick={onClose} disabled={mutation.busy}>Cancel</button><button className="button primary" disabled={mutation.busy || mutation.retryRequired}>Create session</button></footer></form></Modal>;
}
