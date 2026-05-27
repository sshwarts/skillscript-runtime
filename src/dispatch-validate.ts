/**
 * v0.9.1 — shared dispatch validator (P0.1 + P1.5).
 *
 * Lint and runtime both call into this module so they agree on what makes
 * a dispatch op valid. Pre-v0.9.1 the two layers had their own logic and
 * drifted apart — the v0.7.2 / v0.7.3 / v0.9.0 push-blockers all had the
 * same shape: lint green-lit something the runtime then refused, OR vice
 * versa. Third recurrence of the pattern earned a structural answer.
 *
 * The validator returns diagnostics; consumers (lint, runtime) map them
 * into their respective surface (LintFinding or thrown error).
 *
 * For PR template discipline: every new dispatch shape lands with lint
 * + runtime + e2e tests covering the same shape. See docs/CONTRIBUTING.md.
 */

import type { Registry } from "./connectors/registry.js";

export interface DispatchValidationInput {
  /** The dispatch's tool name (the first token of the op body). */
  toolName: string;
  /** Explicit connector prefix from `$ <connector>.<tool>`; undefined for bare. */
  qualifiedConnector: string | undefined;
  /** Runtime registry — used to look up wired connectors + their classes. */
  registry: Registry;
}

export type DispatchDiagnostic =
  | { severity: "error"; code: "unknown-connector"; message: string; extras?: Record<string, unknown> }
  | { severity: "error"; code: "unknown-tool-on-connector"; message: string; extras?: Record<string, unknown> }
  | { severity: "error"; code: "disallowed-tool"; message: string; extras?: Record<string, unknown> }
  | { severity: "advisory"; code: "unverified-qualified-tool"; message: string; extras?: Record<string, unknown> };

/**
 * Validate a qualified `$ <connector>.<tool>` dispatch shape. Returns
 * the diagnostics that apply. Bare `$ <tool>` dispatch (no qualifier) is
 * validated by the existing `unwired-primary-connector` lint rule + the
 * v0.7.2/v0.7.3 name-match-before-primary fix; this validator focuses on
 * the qualified path that was the v0.9.0 push-blocker shape.
 *
 * Order of checks:
 *   1. Connector wired? — if no, return `unknown-connector` and stop.
 *   2. Allow-list check — if connector has `allowed_tools` AND tool not in
 *      list, return `disallowed-tool` and stop.
 *   3. Static tool surface — if class implements `staticTools()`:
 *        - tool in list → no diagnostic (clean pass)
 *        - tool not in list → `unknown-tool-on-connector`
 *      Class doesn't implement `staticTools()`, or it returns null:
 *        → `unverified-qualified-tool` advisory (lint surfaces as tier-3).
 */
export function validateQualifiedDispatch(input: DispatchValidationInput): DispatchDiagnostic[] {
  const { toolName, qualifiedConnector, registry } = input;
  if (qualifiedConnector === undefined) return [];

  if (!registry.hasMcpConnector(qualifiedConnector)) {
    const wired = registry.listMcpConnectors().map((e) => e.name);
    return [{
      severity: "error",
      code: "unknown-connector",
      message: `\`$ ${qualifiedConnector}.${toolName}\` references unknown connector '${qualifiedConnector}'. Wired connectors: ${wired.length === 0 ? "(none)" : wired.join(", ")}.`,
      extras: { referenced_connector: qualifiedConnector, tool: toolName, wired },
    }];
  }

  const allowed = registry.getMcpConnectorAllowedTools(qualifiedConnector);
  if (allowed !== undefined && !allowed.includes(toolName)) {
    return [{
      severity: "error",
      code: "disallowed-tool",
      message: `\`$ ${qualifiedConnector}.${toolName}\` is not in the allowlist for connector '${qualifiedConnector}'. ${allowed.length === 0 ? "Allowlist is empty (no tools permitted)." : `Allowed: ${allowed.join(", ")}.`}`,
      extras: { connector: qualifiedConnector, tool: toolName, allowed },
    }];
  }

  // v0.9.1 — static tool surface check (P0.1). Resolves the multi-layer
  // promise lesson: lint and runtime use the same source of truth.
  const ctor = registry.getMcpConnectorCtor(qualifiedConnector);
  const declaredTools = ctor?.staticTools !== undefined ? ctor.staticTools() : null;
  if (declaredTools !== null) {
    if (!declaredTools.includes(toolName)) {
      return [{
        severity: "error",
        code: "unknown-tool-on-connector",
        message: `\`$ ${qualifiedConnector}.${toolName}\` — tool '${toolName}' is not declared on connector class '${ctor?.name ?? "(unknown)"}'. Declared tools: ${declaredTools.length === 0 ? "(none)" : declaredTools.join(", ")}. Use a declared tool, or wire a different connector that supports '${toolName}'.`,
        extras: { connector: qualifiedConnector, tool: toolName, declared_tools: declaredTools },
      }];
    }
    return [];
  }

  // No declared surface — the class doesn't expose its tools statically
  // (e.g., RemoteMcpConnector wrapping an arbitrary upstream MCP server).
  // Tier-3 advisory: cold authors get a hint that we can't validate at
  // compile time + a remediation pointer.
  return [{
    severity: "advisory",
    code: "unverified-qualified-tool",
    message: `\`$ ${qualifiedConnector}.${toolName}\` — connector class '${ctor?.name ?? "(unknown)"}' doesn't declare its tool surface statically; the dispatch can't be validated at compile time. Verify the tool exists on the connector before relying on this; runtime will fail with a connector-specific error if it doesn't.`,
    extras: { connector: qualifiedConnector, tool: toolName },
  }];
}
