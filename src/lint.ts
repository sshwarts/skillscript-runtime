import { parse } from "./parser.js";

/**
 * Lint diagnostics. T1 baseline surfaces parser errors as structured
 * findings. The full 20-rule v1 lint set (Tier-1 hard fails, Tier-2 opt-in
 * gates, Tier-3 style nits) lands in T4 along with the adversarial example
 * library. Authors and tooling consume `LintFinding[]`; CI gates on
 * `severity === "error"`.
 */
export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Optional location info (line numbers added in T4). */
  block?: string;
}

export interface LintResult {
  findings: LintFinding[];
  errorCount: number;
  warningCount: number;
}

export function lint(source: string): LintResult {
  const findings: LintFinding[] = [];
  const parsed = parse(source);

  for (const msg of parsed.parseErrors) {
    findings.push({
      rule: "parse-error",
      severity: "error",
      message: msg,
    });
  }

  // Structural sanity. These are conditions the compiler also fails on,
  // but the lint surface lets authors discover them without invoking compile.
  if (parsed.targets.size === 0 && parsed.parseErrors.length === 0) {
    findings.push({
      rule: "no-targets",
      severity: "error",
      message: "Skill defines no targets. A skill needs at least one target with ops.",
    });
  }
  if (parsed.targets.size > 0 && parsed.entryTarget === null) {
    findings.push({
      rule: "no-entry-target",
      severity: "error",
      message: "Skill has no entry target. Declare one with `default: <target-name>`.",
    });
  }

  // Orphan-target warning — targets that aren't reachable from the entry.
  if (parsed.entryTarget !== null && parsed.targets.has(parsed.entryTarget)) {
    const reached = new Set<string>();
    function walk(name: string): void {
      if (reached.has(name)) return;
      reached.add(name);
      const t = parsed.targets.get(name);
      if (!t) return;
      for (const dep of t.deps) walk(dep);
    }
    walk(parsed.entryTarget);
    for (const name of parsed.targets.keys()) {
      if (!reached.has(name)) {
        findings.push({
          rule: "orphan-target",
          severity: "warning",
          message: `Target '${name}' is not reachable from entry target '${parsed.entryTarget}'. ` +
            `Declare a dependency, change \`default:\`, or fold the steps into the entry target.`,
          block: name,
        });
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  return { findings, errorCount, warningCount };
}
