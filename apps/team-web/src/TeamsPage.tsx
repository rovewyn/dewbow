import { useState } from "react";
import type { AgentDefinition, SessionBindingResult, SessionBinding, Team, TeamMember } from "@dewbow/team-protocol";
import type { Catalog, Route } from "./model.js";
import { Badge, ConfirmAction, Empty, ErrorNotice, Modal, PageHeading, field, shortId } from "./ui.js";
import { WorkspaceTarget } from "./AgentSessionForm.js";
import { useMutation } from "./useMutation.js";

function TeamForm({ team, onClose, onSaved }: { team: Team | null; onClose: () => void; onSaved: (team: Team) => Promise<void> }) {
  const mutation = useMutation<{ team: Team }>(async result => { onClose(); await onSaved(result.team); });
  return <Modal title={team ? "Edit team" : "New team"} onClose={onClose} busy={mutation.busy}><form onSubmit={event => {
    event.preventDefault();
    void mutation.send(team ? "updateTeam" : "createTeam", { name: field(event.currentTarget, "name"), description: field(event.currentTarget, "description"), ...(team ? { teamId: team.teamId } : {}) });
  }}><div className="form-body"><fieldset disabled={mutation.busy || mutation.retryRequired}>
    <label>Team name<input name="name" required maxLength={200} defaultValue={team?.name} placeholder="Editorial team" autoFocus /></label>
    <label>Description<textarea name="description" rows={3} maxLength={4096} defaultValue={team?.description} placeholder="The agents that turn an idea into a finished article." /></label>
  </fieldset><ErrorNotice error={mutation.error} onRetry={mutation.retryRequired ? mutation.retry : undefined} /></div><footer className="form-footer"><button type="button" className="button secondary" disabled={mutation.busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={mutation.busy || mutation.retryRequired}>{mutation.busy ? "Saving…" : "Save team"}</button></footer></form></Modal>;
}

function MemberForm({ teamId, member, definitions, onClose, onSaved }: { teamId: string; member: TeamMember | null; definitions: AgentDefinition[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const mutation = useMutation(async () => { onClose(); await onSaved(); });
  return <Modal title={member ? "Edit member" : "Add member"} onClose={onClose} busy={mutation.busy}><form onSubmit={event => {
    event.preventDefault();
    void mutation.send(member ? "updateTeamMember" : "addTeamMember", { name: field(event.currentTarget, "name"), definitionId: field(event.currentTarget, "definitionId") || null, ...(member ? { memberId: member.memberId } : { teamId }) });
  }}><div className="form-body"><fieldset disabled={mutation.busy || mutation.retryRequired}>
    <label>Member name<input name="name" required maxLength={200} defaultValue={member?.name} placeholder="Writer" autoFocus /></label>
    <label>Agent definition<select name="definitionId" defaultValue={member?.definitionId ?? ""}>{definitions.map(definition => <option key={definition.definitionId} value={definition.source === "builtin" ? "" : definition.definitionId}>{definition.name}{definition.source === "builtin" ? " · host defaults" : ` · revision ${definition.revision}`}</option>)}</select></label>
    <p className="field-hint">Changing this selection affects new sessions. Existing sessions keep their saved configuration.</p>
  </fieldset><ErrorNotice error={mutation.error} onRetry={mutation.retryRequired ? mutation.retry : undefined} /></div><footer className="form-footer"><button type="button" className="button secondary" disabled={mutation.busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={mutation.busy || mutation.retryRequired}>{mutation.busy ? "Saving…" : "Save member"}</button></footer></form></Modal>;
}

function CreateSessionForm({ member, onClose, onCreated }: { member: TeamMember; onClose: () => void; onCreated: (binding: SessionBinding) => Promise<void> }) {
  const mutation = useMutation<SessionBindingResult>(async result => { onClose(); await onCreated(result.binding); });
  return <Modal title={`New session · ${member.name}`} onClose={onClose} busy={mutation.busy}><form onSubmit={event => {
    event.preventDefault(); void mutation.send("createMemberSession", { memberId: member.memberId, hostId: field(event.currentTarget, "hostId"), workspaceProfileId: field(event.currentTarget, "workspaceProfileId") });
  }}><div className="form-body"><fieldset disabled={mutation.busy || mutation.retryRequired}><WorkspaceTarget /><p className="field-hint">Core prepares an isolated workspace and freezes this member's current definition.</p></fieldset><ErrorNotice error={mutation.error} onRetry={mutation.retryRequired ? mutation.retry : undefined} /></div><footer className="form-footer"><button type="button" className="button secondary" disabled={mutation.busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={mutation.busy || mutation.retryRequired}>Create session</button></footer></form></Modal>;
}

export function BindingList({ bindings, catalog, navigate }: { bindings: SessionBinding[]; catalog: Catalog; navigate: (route: Route) => void }) {
  if (!bindings.length) return <Empty title="No sessions yet">Create an agent session or start one from a team member.</Empty>;
  return <div className="session-list">{bindings.map(binding => {
    const member = catalog.members.find(item => item.memberId === binding.memberId);
    const definition = catalog.definitions.find(item => item.definitionId === binding.agentRef.id);
    return <button className="session-row" key={binding.bindingId} onClick={() => navigate({ page: "sessions", bindingId: binding.bindingId, ...(member ? { teamId: member.teamId } : {}) })}>
      <span className="session-icon" aria-hidden="true">↗</span><span className="session-row-main"><strong>{member?.name ?? definition?.name ?? "Agent session"}</strong><span>{binding.workDir ?? "Preparing workspace"}</span></span>
      <span className="session-row-meta"><span>{definition?.name ?? "Historical definition"} · r{binding.agentRef.revision}</span><span>{binding.hostId} · {shortId(binding.sessionId)}</span></span><span className="row-arrow" aria-hidden="true">→</span>
    </button>;
  })}</div>;
}

type Editor = { type: "team"; team: Team | null } | { type: "member"; member: TeamMember | null } | { type: "session"; member: TeamMember } | null;

export function TeamsPage({ catalog, teamId, refresh, navigate }: { catalog: Catalog; teamId?: string | undefined; refresh: () => Promise<void>; navigate: (route: Route) => void }) {
  const [editor, setEditor] = useState<Editor>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archive, setArchive] = useState<{ operation: string; input: Record<string, unknown>; name: string } | null>(null);
  const team = catalog.teams.find(item => item.teamId === teamId);
  const members = catalog.members.filter(member => member.teamId === teamId && (showArchived || !member.archivedAt));
  const bindings = catalog.bindings.filter(binding => catalog.members.some(member => member.teamId === teamId && member.memberId === binding.memberId));
  if (teamId && !team) return <Empty title="Team unavailable">Refresh the workspace to load this team.</Empty>;
  return <>
    <PageHeading eyebrow={team ? "TEAM" : "WORKSPACE"} title={team?.name ?? "Teams"} description={team?.description || (team ? "Give each agent a role, then start a session." : "Bring your agents together around the work.")}
      actions={team ? <><button className="button secondary" onClick={() => navigate({ page: "teams" })}>← All teams</button><button className="button secondary" onClick={() => setEditor({ type: "team", team })}>Edit team</button><button className="button primary" disabled={Boolean(team.archivedAt)} onClick={() => setEditor({ type: "member", member: null })}>+ Add member</button></> : <button className="button primary" onClick={() => setEditor({ type: "team", team: null })}>+ New team</button>} />
    {team ? <>
      {team.archivedAt && <div className="notice subtle"><Badge tone="warning">Archived</Badge><p>Existing sessions remain available. This team cannot create new sessions.</p></div>}
      <div className="section-heading"><h2>Members <span className="count">{members.length}</span></h2><label className="checkbox-label"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived</label></div>
      {!members.length ? <Empty title="Build your team">Add a member and select an agent definition.</Empty> : <div className="card-grid">{members.map(member => {
        const definition = catalog.definitions.find(item => item.definitionId === (member.definitionId ?? "default"));
        const count = catalog.bindings.filter(binding => binding.memberId === member.memberId).length;
        return <article className="member-card card" key={member.memberId}><div className="card-top"><span className="avatar">{member.name.slice(0, 1)}</span>{member.archivedAt ? <Badge tone="warning">Archived</Badge> : <Badge tone="purple">Agent</Badge>}</div><h3>{member.name}</h3><p className="member-definition">{definition?.name ?? "Definition unavailable"}</p><p className="muted">{count} {count === 1 ? "session" : "sessions"}</p><footer className="card-actions"><button className="button primary small" disabled={Boolean(member.archivedAt || team.archivedAt || !catalog.service.coreConfigured)} onClick={() => setEditor({ type: "session", member })}>New session</button><button className="text-button" onClick={() => setEditor({ type: "member", member })}>Edit</button>{!member.archivedAt && <button className="text-button" onClick={() => setArchive({ operation: "archiveTeamMember", input: { memberId: member.memberId }, name: member.name })}>Archive</button>}</footer></article>;
      })}</div>}
      <div className="section-heading"><h2>Sessions <span className="count">{bindings.length}</span></h2><span className="muted">Configuration is fixed at creation</span></div><BindingList bindings={bindings} catalog={catalog} navigate={navigate} />
      {!team.archivedAt && <div className="team-footer"><button className="text-button" onClick={() => setArchive({ operation: "archiveTeam", input: { teamId: team.teamId }, name: team.name })}>Archive team</button></div>}
    </> : <>
      <div className="workspace-stats"><div><strong>{catalog.teams.filter(item => !item.archivedAt).length}</strong><span>Teams</span></div><div><strong>{catalog.members.filter(item => !item.archivedAt).length}</strong><span>Members</span></div><div><strong>{catalog.bindings.length}</strong><span>Sessions</span></div></div>
      <div className="section-heading"><h2>Your teams</h2><label className="checkbox-label"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived</label></div>
      {!catalog.teams.filter(item => showArchived || !item.archivedAt).length ? <Empty title="Start with a small team">Create a team, add your agents, and choose how each one works.</Empty> : <div className="card-grid">{catalog.teams.filter(item => showArchived || !item.archivedAt).map(item => <button className="team-card card" key={item.teamId} onClick={() => navigate({ page: "teams", teamId: item.teamId })}><div className="card-top"><span className="avatar team-avatar">{item.name.slice(0, 1)}</span>{item.archivedAt && <Badge tone="warning">Archived</Badge>}<span className="row-arrow">↗</span></div><h2>{item.name}</h2><p className="card-description">{item.description || "A team of Codex agents."}</p><footer>{catalog.members.filter(member => member.teamId === item.teamId && !member.archivedAt).length} members<span>Open team →</span></footer></button>)}</div>}
    </>}
    {editor?.type === "team" && <TeamForm team={editor.team} onClose={() => setEditor(null)} onSaved={async saved => { await refresh(); navigate({ page: "teams", teamId: saved.teamId }); }} />}
    {editor?.type === "member" && team && <MemberForm teamId={team.teamId} member={editor.member} definitions={catalog.definitions} onClose={() => setEditor(null)} onSaved={refresh} />}
    {editor?.type === "session" && <CreateSessionForm member={editor.member} onClose={() => setEditor(null)} onCreated={async binding => { await refresh(); navigate({ page: "sessions", bindingId: binding.bindingId, teamId: editor.member.teamId }); }} />}
    {archive && <ConfirmAction title={`Archive ${archive.name}`} operation={archive.operation} input={archive.input} actionLabel="Archive" onClose={() => setArchive(null)} onSaved={refresh}><p>New sessions will be disabled. Existing sessions and their history remain available.</p></ConfirmAction>}
  </>;
}
