import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
export class CodexRuntimeError extends Error {
  constructor(readonly code: "EXECUTION_FAILED" | "DELIVERY_UNCERTAIN" | "SESSION_IN_USE", message: string) {
    super(message); this.name = "CodexRuntimeError";
  }
}
export interface ConnectSessionOptions {
  cwd?: string; model?: string; approvalPolicy?: "on-request" | "never" | "untrusted" | "on-failure";
  approvalsReviewer?: "user" | "guardian_subagent";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  modelProvider?: string; developerInstructions?: string; config?: Record<string, unknown>;
  excludeTurns?: boolean;
}
export interface ConnectedSession {
  thread: { id: string; cwd: string; status: { type: string }; turns: { id: string; status: string }[] };
  cwd: string;
}

export interface RpcMessage { method?: string; id?: string | number; params?: Record<string, any>; result?: any; error?: unknown }
export class CodexRuntime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: () => void = () => {};
  onSpawn: (pid: number) => void = () => {};
  async start(executable: string, home?: string): Promise<number> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEWBOW_")));
    this.child = spawn(executable, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env: { ...env, ...(home ? { CODEX_HOME: home } : {}) } });
    if (this.child.pid) this.onSpawn(this.child.pid);
    this.child.stderr.resume();
    this.child.on("error", () => this.closed());
    this.child.on("exit", () => this.closed());
    createInterface({ input: this.child.stdout }).on("line", line => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { this.child?.kill(); return; }
      if (message.method) this.onMessage(message);
      else if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) {
          const detail = message.error as { message?: string };
          const inUse = /already has an active writer/i.test(detail.message ?? "");
          request.reject(new CodexRuntimeError(inUse ? "SESSION_IN_USE" : "EXECUTION_FAILED", inUse ? "Another Codex runtime owns this conversation. Release it there before connecting." : "Codex rejected the runtime operation."));
        }
        else request.resolve(message.result);
      }
    });
    await this.request("initialize", { clientInfo: { name: "dewbow", title: "dewbow SDK", version: "0.1.0" }, capabilities: { experimentalApi: false } });
    this.write({ method: "initialized" });
    return this.child.pid!;
  }
  /** Resume the saved native ID without creating a fork or starting a model turn. */
  async connectSession(sessionId: string, options: ConnectSessionOptions = {}): Promise<ConnectedSession> {
    if (!sessionId.trim()) throw new TypeError("sessionId is required.");
    const result = await this.request("thread/resume", { threadId: sessionId, excludeTurns: true, ...options }) as ConnectedSession;
    if (result.thread.id !== sessionId) throw new CodexRuntimeError("EXECUTION_FAILED", "Codex returned a different conversation ID.");
    return result;
  }
  sendMessage(sessionId: string, text: string): Promise<{ turn: { id: string; status: string } }> {
    return this.request("turn/start", { threadId: sessionId, input: [{ type: "text", text, text_elements: [] }] });
  }
  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexRuntimeError("DELIVERY_UNCERTAIN", "Codex operation timed out. Its outcome must be reconciled.")); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  respond(id: string | number, result: unknown): void { this.write({ id, result }); }
  reject(id: string | number): void { this.write({ id, error: { code: -32601, message: "Unsupported runtime request in this MVP." } }); }
  private write(message: unknown): void { this.child?.stdin.write(JSON.stringify(message) + "\n"); }
  private closed(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new CodexRuntimeError("DELIVERY_UNCERTAIN", "Codex runtime closed before confirming the operation."));
    }
    this.pending.clear(); this.onExit();
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
    this.child = undefined;
  }
}
