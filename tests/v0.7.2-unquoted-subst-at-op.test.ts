import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

// v0.7.2 — unquoted-substitution-in-kwarg-value lint extended to legacy
// @ shell ops. Closes R4 minion 4 finding where `@ printf %b ${REPORT}`
// silently word-split when REPORT contained whitespace.

describe("v0.7.2 — unquoted-substitution lint extended to @ ops", () => {
  it("fires on `@ cmd ${VAR}` where VAR is suspect (var with whitespace)", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: REPORT=line one
run:
    @ printf %b \${REPORT}
default: run
`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unquoted-substitution-in-kwarg-value");
    expect(um.length).toBeGreaterThanOrEqual(1);
    expect(um[0]!.message).toMatch(/word-splitting/);
    expect(um[0]!.extras).toMatchObject({ op: "@" });
  });

  it("fires on legacy `@ cmd $(VAR)` form", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: REPORT=multi word
run:
    @ printf %b $(REPORT)
default: run
`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unquoted-substitution-in-kwarg-value");
    expect(um.length).toBeGreaterThanOrEqual(1);
  });

  it("silent on `@ cmd \"${VAR}\"` (quoted)", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: REPORT=line one
run:
    @ printf %b "\${REPORT}"
default: run
`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unquoted-substitution-in-kwarg-value");
    expect(um).toEqual([]);
  });

  it("silent when variable origin has no whitespace risk", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: NAME=alice
run:
    @ echo \${NAME}
default: run
`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unquoted-substitution-in-kwarg-value");
    expect(um).toEqual([]);
  });

  it("fires on ~ op output bound then used in @ shell", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    ~ prompt="generate a summary" -> SUMMARY
    @ printf %b \${SUMMARY}
default: run
`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unquoted-substitution-in-kwarg-value");
    expect(um.length).toBeGreaterThanOrEqual(1);
  });

  it("dedupes per-var in same target", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: Q=multi word
run:
    @ tool1 \${Q}
    @ tool2 \${Q}
default: run
`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unquoted-substitution-in-kwarg-value");
    expect(um).toHaveLength(1);
  });

  it("still fires on $ op kwargs (original v0.5.0 coverage intact)", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: Q=multi word
run:
    $ search query=\${Q} -> R
default: run
`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unquoted-substitution-in-kwarg-value");
    expect(um.length).toBeGreaterThanOrEqual(1);
    expect(um[0]!.extras).toMatchObject({ op: "$" });
  });
});
