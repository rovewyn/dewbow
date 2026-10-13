import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fail, type Session, type SessionWorkspace, type WorkspaceProfile } from "@dewbow/core-protocol";

const execute = promisify(execFile);
async function directoryIdentity(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail("RECOVERY_REQUIRED", "Workspace must remain its original directory.");
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}
interface Profile extends WorkspaceProfile { repository?: string; baseRef?: string }
export interface WorkspaceConfig { root: string; profiles: Profile[] }

export function readWorkspaceConfig(path?: string): WorkspaceConfig | undefined {
  if (!path) return undefined;
  let value: WorkspaceConfig;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Invalid workspace profile configuration."); }
  if (!value || !isAbsolute(value.root ?? "") || !Array.isArray(value.profiles)) throw new Error("Workspace profiles require an absolute root.");
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (!profile || !/^[a-zA-Z0-9_-]{1,100}$/.test(profile.profileId) || ids.has(profile.profileId)
      || typeof profile.name !== "string" || !profile.name.trim() || !["emptyDirectory", "gitWorktree"].includes(profile.kind)
      || (profile.kind === "gitWorktree" && (!isAbsolute(profile.repository ?? "") || !profile.baseRef || profile.baseRef.startsWith("-")))) {
      throw new Error("Invalid or duplicate workspace profile.");
    }
    ids.add(profile.profileId);
  }
  return value;
}

const inside = (root: string, path: string) => {
  const tail = relative(root, path);
  return tail !== "" && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
};
async function git(repository: string, args: string[]): Promise<string> {
  try { return (await execute("git", ["-C", repository, ...args], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim(); }
  catch { fail("WORKSPACE_ERROR", "Git workspace operation failed. Inspect the configured repository locally."); }
}

export class Workspaces {
  constructor(private readonly config: WorkspaceConfig | undefined) {}

  list(): { profiles: WorkspaceProfile[] } {
    return { profiles: (this.config?.profiles ?? []).map(({ profileId, name, kind }) => ({ profileId, name, kind })) };
  }

  async prepare(session: Session, profileId: string, save: () => void): Promise<string> {
    if (!this.config || !/^[a-zA-Z0-9-]{1,200}$/.test(session.sessionId)) fail("INVALID_INPUT", "Workspace provisioning is not configured.");
    if (session.workspace) { await this.verify(session); return session.workspace.workDir; }
    const profile = this.config.profiles.find(item => item.profileId === profileId);
    if (!profile) fail("INVALID_INPUT", "Workspace profile is unavailable on this host.");
    await mkdir(this.config.root, { recursive: true });
    const root = await realpath(this.config.root);
    const directory = join(root, session.sessionId);
    if (!inside(root, directory)) fail("INVALID_WORKDIR", "Workspace path is outside its configured root.");
    try { await lstat(directory); fail("RECOVERY_REQUIRED", "Workspace destination already exists without an ownership record."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let repository: string | null = null, baseCommit: string | null = null, branch: string | null = null;
    if (profile.kind === "gitWorktree") {
      repository = await realpath(profile.repository!);
      if (root === repository || inside(repository, root)) fail("INVALID_WORKDIR", "Workspace root must be outside the source working tree.");
      baseCommit = await git(repository, ["rev-parse", "--verify", `${profile.baseRef}^{commit}`]);
      branch = `dewbow/session-${session.sessionId}`;
    }
    const workspace: SessionWorkspace = { profileId, kind: profile.kind, workDir: directory, directoryIdentity: null, repository, baseCommit, branch, status: "preparing" };
    session.workspace = workspace;
    save(); // Freeze source and destination before any filesystem or Git mutation.
    try {
      if (repository) await git(repository, ["worktree", "add", "-b", branch!, directory, baseCommit!]);
      else await mkdir(directory);
      session.workDir = await realpath(directory);
      if (session.workDir !== directory) fail("RECOVERY_REQUIRED", "Workspace destination changed during preparation.");
      workspace.workDir = session.workDir;
      workspace.directoryIdentity = await directoryIdentity(directory);
      workspace.status = "ready";
      await this.verify(session);
      save();
      return session.workDir;
    } catch (error) { workspace.status = "error"; save(); throw error; }
  }

  async verify(session: Session): Promise<void> {
    const workspace = session.workspace;
    if (!workspace) return;
    if (workspace.status !== "ready" || session.workDir !== workspace.workDir) fail("RECOVERY_REQUIRED", "Workspace preparation is unresolved.");
    try {
      const entry = await lstat(workspace.workDir);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(workspace.workDir) !== workspace.workDir) throw new Error();
      if (!workspace.directoryIdentity || await directoryIdentity(workspace.workDir) !== workspace.directoryIdentity) throw new Error();
      if (workspace.kind === "gitWorktree") {
        const common = await git(workspace.workDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        const source = await git(workspace.repository!, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        const branch = await git(workspace.workDir, ["symbolic-ref", "--short", "HEAD"]);
        if (await realpath(common) !== await realpath(source) || branch !== workspace.branch) throw new Error();
      }
    } catch { fail("RECOVERY_REQUIRED", "Saved workspace is missing or inconsistent. Restore it without replacing the native session."); }
  }
}
