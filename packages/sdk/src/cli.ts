import { checkAbort, emptySession, isMissing, object, report, runCommand, uuid } from "./internal.js";
import type { Context } from "./internal.js";
import type { CodexSession, SourceReport } from "./types.js";

export async function inspectCli(ctx: Context): Promise<{ report: SourceReport; sessions: CodexSession[] }> {
  const status = report("cli", ctx.home);
  try {
    const result = await runCommand(ctx.codexExecutable, ["migrate-rollouts", "--json"], ctx, { ...process.env, CODEX_HOME: ctx.home });
    if (result.code !== 0) throw new Error("CLI inspection failed.");
    const payload = object(JSON.parse(result.stdout));
    if (!Array.isArray(payload.outcomes)) throw new Error("Invalid report.");
    const sessions = new Map<string, CodexSession>();
    for (const raw of payload.outcomes) {
      checkAbort(ctx.signal);
      const row = object(raw), id = uuid(row.thread_id);
      if (!id) throw new Error("Invalid session ID.");
      const session = sessions.get(id) ?? emptySession(id, ctx.home);
      session.sources = ["cli"];
      const state = typeof row.status === "string" && /^[a-z_]{1,40}$/.test(row.status) ? row.status : "unknown";
      if (!session.cliInspectionStates.includes(state)) session.cliInspectionStates.push(state);
      sessions.set(id, session);
      if (sessions.size > ctx.maxSessions) throw new Error("Session limit.");
    }
    status.counts.sessions = sessions.size;
    return { report: status, sessions: [...sessions.values()] };
  } catch (error) {
    checkAbort(ctx.signal);
    status.state = isMissing(error) ? "unavailable" : "error";
    status.error = isMissing(error) ? "Codex CLI was not found." : "Codex CLI inspection failed, timed out, or returned an invalid report.";
    status.counts.sessions = null;
    return { report: status, sessions: [] };
  }
}
