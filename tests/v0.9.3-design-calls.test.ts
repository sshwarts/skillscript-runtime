/**
 * v0.9.3 — deferred design calls (P1.2 + P1.3).
 *
 * P1.2: numeric subscripts in dotted refs (${VAR.0}) — tier-2 lint
 * surfaces silent-fail; foreach is the canonical iteration shape.
 * Per R8 minion #5 finding in dec3ca8a.
 *
 * P1.3: `recipients=[...]` is the canonical bundled-bridge kwarg;
 * `addressed_to="..."` is doc-bug history that parses but silently
 * drops in default deployments. Tier-2 lint catches.
 * Per R8 minion #4 finding in dec3ca8a.
 */
import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

describe("v0.9.3 — P1.2 numeric subscript lint", () => {
  it("fires `numeric-subscript` on ${ARR.0}", async () => {
    const src = `# Skill: t
# Status: Approved
m:
    emit(text="\${ITEMS.0}")
default: m
`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "numeric-subscript");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("fires on multi-segment ${LATEST.items.0}", async () => {
    const src = `# Skill: t
# Status: Approved
m:
    emit(text="\${LATEST.items.0}")
default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "numeric-subscript")).toBeDefined();
  });

  it("does NOT fire on legitimate dotted field access ${VAR.field}", async () => {
    const src = `# Skill: t
# Status: Approved
m:
    emit(text="\${ISSUE.summary}")
default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "numeric-subscript")).toBeUndefined();
  });

  it("does NOT fire when the var name itself contains digits but no .NUMBER segment", async () => {
    const src = `# Skill: t
# Status: Approved
m:
    emit(text="\${VAR1}")
default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "numeric-subscript")).toBeUndefined();
  });
});

describe("v0.9.3 — P1.3 deprecated-addressed-to lint", () => {
  it("fires on `$ data_write ... addressed_to=...`", async () => {
    const src = `# Skill: t
# Status: Approved
m:
    $ data_write content="hello" addressed_to="oncall" -> R
default: m
`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "deprecated-addressed-to");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("does NOT fire on canonical `recipients=[...]` form", async () => {
    const src = `# Skill: t
# Status: Approved
m:
    $ data_write content="hello" recipients=[oncall] -> R
default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "deprecated-addressed-to")).toBeUndefined();
  });

  it("does NOT fire on other `$ data_write`-shaped tools that aren't data_write", async () => {
    const src = `# Skill: t
# Status: Approved
m:
    $ custom_tool content="x" addressed_to="oncall" -> R
default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "deprecated-addressed-to")).toBeUndefined();
  });
});
