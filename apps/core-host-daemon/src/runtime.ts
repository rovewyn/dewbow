import { CodexRuntime, CodexRuntimeError } from "@dewbow-core/sdk";
import { ManagementError } from "@dewbow-core/protocol";
export type { RpcMessage } from "@dewbow-core/sdk";

/** Map SDK errors to the management wire format without exposing native diagnostics. */
export class Runtime extends CodexRuntime {
  override async request(method: string, params: Record<string, unknown>): Promise<any> {
    try { return await super.request(method, params); }
    catch (error) {
      if (error instanceof CodexRuntimeError) throw new ManagementError({ code: error.code, message: error.message, retryable: error.code !== "EXECUTION_FAILED" });
      throw error;
    }
  }
}
