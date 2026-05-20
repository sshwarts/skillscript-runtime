// Recompile-staleness detection. Reads a previously-recorded provenance
// block and compares its `data_skills_inlined[].content_hash` to the
// current content_hash of each referenced skill via the SkillStore.
// Surfaces stale entries (source changed since compile) and missing ones
// (referenced skill deleted/renamed).
//
// Agent-first JSON output: every audit produces a structured `AuditResult`
// with typed findings keyed by rule ID. Human-readable display is a
// pretty-printer over the same shape.

import type { SkillStore } from "./connectors/types.js";
import { SkillNotFoundError } from "./errors.js";
import type { ProvenanceBlock } from "./provenance.js";

export type AuditRule = "stale-data-skill" | "missing-data-skill";

export interface AuditFinding {
  rule: AuditRule;
  severity: "warning" | "error";
  skill_name: string;
  recorded_content_hash: string;
  /** Absent when the skill couldn't be found in the store. */
  current_content_hash?: string;
  message: string;
}

export interface AuditResult {
  audited_at: string;
  /** The provenance block that was audited (echoed for cross-reference). */
  provenance: ProvenanceBlock;
  findings: AuditFinding[];
  /** True if any finding has severity error OR any stale-data-skill. */
  is_stale: boolean;
}

/**
 * Audit a provenance block against current SkillStore state. Returns a
 * structured report; never throws on missing/stale skills — those become
 * findings, not exceptions. Throws only on unexpected SkillStore errors
 * (e.g., substrate down).
 */
export async function audit(
  provenance: ProvenanceBlock,
  store: SkillStore,
): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  for (const recorded of provenance.data_skills_inlined) {
    try {
      const meta = await store.metadata(recorded.name);
      if (meta.content_hash !== recorded.content_hash) {
        findings.push({
          rule: "stale-data-skill",
          severity: "warning",
          skill_name: recorded.name,
          recorded_content_hash: recorded.content_hash,
          current_content_hash: meta.content_hash,
          message:
            `Data-skill '${recorded.name}' has been updated since this artifact ` +
            `was compiled (recorded ${recorded.content_hash.slice(0, 12)}..., ` +
            `current ${meta.content_hash.slice(0, 12)}...). Recompile to pick up the new content.`,
        });
      }
    } catch (err) {
      if (err instanceof SkillNotFoundError) {
        findings.push({
          rule: "missing-data-skill",
          severity: "error",
          skill_name: recorded.name,
          recorded_content_hash: recorded.content_hash,
          message:
            `Data-skill '${recorded.name}' (recorded ${recorded.content_hash.slice(0, 12)}...) ` +
            `is no longer present in the SkillStore. The compiled artifact references ` +
            `content that can no longer be re-derived.`,
        });
        continue;
      }
      throw err;
    }
  }
  return {
    audited_at: new Date().toISOString(),
    provenance,
    findings,
    is_stale: findings.length > 0,
  };
}

/**
 * Pretty-print an AuditResult for human display. JSON output is the canonical
 * form; this is a thin formatter for CLI/dashboard surfaces.
 */
export function formatAuditResult(result: AuditResult): string {
  const lines: string[] = [];
  const sourceName = result.provenance.source_skill.name ?? "(unnamed)";
  lines.push(`Audit of '${sourceName}' (${result.findings.length} finding${result.findings.length === 1 ? "" : "s"})`);
  if (result.findings.length === 0) {
    lines.push(`  OK: no stale or missing references. ${result.provenance.data_skills_inlined.length} data-skill(s) audited.`);
  } else {
    for (const f of result.findings) {
      lines.push(`  [${f.severity}] ${f.rule} (${f.skill_name}): ${f.message}`);
    }
  }
  return lines.join("\n");
}
