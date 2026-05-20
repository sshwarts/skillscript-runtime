import type {
  McpConnector,
  McpDispatchCtx,
  Capabilities,
} from "./types.js";

/**
 * Callback-based McpConnector. Wraps a user-supplied dispatch function and
 * surfaces it through the McpConnector contract. Useful for:
 *
 *   - Test rigs that want to assert on tool calls
 *   - Embedders that hand-roll their own MCP transport
 *   - The bundled `init` scaffold's commented example
 *
 * T1 baseline ships with no servers wired by default. The v1 spec defers
 * the real HTTP-bridge `McpHttpConnector` to a follow-up — for v1, the
 * minimum is "compile and run a skill, possibly without `$` ops at all."
 */
export type DispatchFn = (
  toolName: string,
  args: Record<string, unknown>,
  ctxOverrides?: McpDispatchCtx,
) => Promise<unknown>;

export class CallbackMcpConnector implements McpConnector {
  constructor(private readonly dispatchFn: DispatchFn) {}

  call(
    toolName: string,
    args: Record<string, unknown>,
    ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown> {
    return this.dispatchFn(toolName, args, ctxOverrides);
  }

  capabilities(): Capabilities {
    return { kind: "callback" };
  }
}
