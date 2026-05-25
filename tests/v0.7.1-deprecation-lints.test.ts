import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

// v0.7.1 — tier-2 deprecation visibility nudges.
// `deprecated-symbol-op` fires on legacy ~/>/@/!/??/&; canonical
// function-call form is silent. `deprecated-substitution-shape` fires on
// $(VAR); canonical ${VAR} is silent. Both lints are visibility-only
// during grace period; tier-1 promotion lands in v0.8/v0.9.

describe("v0.7.1 — deprecated-symbol-op tier-2 lint", () => {
  it("fires on legacy `!` op", async () => {
    const src = `# Skill: t\nrun:\n    ! hi\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-symbol-op");
    expect(dep).toHaveLength(1);
    expect(dep[0]!.severity).toBe("warning");
    expect(dep[0]!.message).toMatch(/Op '!'/);
    expect(dep[0]!.message).toMatch(/emit\(text=/);
  });

  it("silent on canonical `emit(text=\"...\")` op", async () => {
    const src = `# Skill: t\nrun:\n    emit(text="hi")\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-symbol-op");
    expect(dep).toEqual([]);
  });

  it("fires on `~`, `>`, `@`, `??`, `&`", async () => {
    const src = `# Skill: t\nrun:\n    ~ prompt="hi" -> R\n    > mode=fts query="x" limit=5 -> M\n    @ echo hi\n    ?? "go?"\n    & helper\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-symbol-op");
    const kinds = dep.map((f) => (f.extras as { legacy_op: string }).legacy_op).sort();
    expect(kinds).toEqual(["&", "??", "@", ">", "~"].sort());
  });

  it("dedupes per-kind-per-target", async () => {
    const src = `# Skill: t\nrun:\n    ! one\n    ! two\n    ! three\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-symbol-op");
    expect(dep).toHaveLength(1);
  });

  it("mixed legacy + canonical only fires on legacy", async () => {
    const src = `# Skill: t\nrun:\n    emit(text="canonical")\n    ! legacy\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-symbol-op");
    expect(dep).toHaveLength(1);
  });
});

describe("v0.7.1 — deprecated-substitution-shape tier-2 lint", () => {
  it("fires on `$(VAR)` substitution", async () => {
    const src = `# Skill: t\n# Vars: NAME=world\nrun:\n    emit(text="hi $(NAME)")\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-substitution-shape");
    expect(dep).toHaveLength(1);
    expect(dep[0]!.message).toMatch(/\$\(NAME\)/);
    expect(dep[0]!.message).toMatch(/\$\{NAME\}/);
  });

  it("silent on `${VAR}` canonical form", async () => {
    const src = `# Skill: t\n# Vars: NAME=world\nrun:\n    emit(text="hi \${NAME}")\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-substitution-shape");
    expect(dep).toEqual([]);
  });

  it("dedupes per-var-per-target", async () => {
    const src = `# Skill: t\n# Vars: A=x\nrun:\n    emit(text="$(A)")\n    emit(text="$(A) again")\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-substitution-shape");
    expect(dep).toHaveLength(1);
  });

  it("fires once per var when multiple vars used", async () => {
    const src = `# Skill: t\n# Vars: A=x, B=y\nrun:\n    emit(text="$(A) $(B)")\n\ndefault: run\n`;
    const r = await lint(src);
    const dep = r.findings.filter((f) => f.rule === "deprecated-substitution-shape");
    const names = dep.map((f) => (f.extras as { var_name: string }).var_name).sort();
    expect(names).toEqual(["A", "B"]);
  });
});

describe("v0.7.1 — unconfirmed-mutation broadening", () => {
  it("fires on file_write without approved=", async () => {
    const src = `# Skill: t\nrun:\n    file_write(path="/tmp/x", content="y")\n\ndefault: run\n`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unconfirmed-mutation");
    expect(um).toHaveLength(1);
    expect(um[0]!.message).toMatch(/file_write/);
  });

  it("silent on file_write with approved=", async () => {
    const src = `# Skill: t\nrun:\n    file_write(path="/tmp/x", content="y", approved="test reason")\n\ndefault: run\n`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unconfirmed-mutation");
    expect(um).toEqual([]);
  });

  it("silent on file_write under # Autonomous: true", async () => {
    const src = `# Skill: t\n# Autonomous: true\nrun:\n    file_write(path="/tmp/x", content="y")\n\ndefault: run\n`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unconfirmed-mutation");
    expect(um).toEqual([]);
  });

  it("fires on $ memory_write without approved=", async () => {
    const src = `# Skill: t\nrun:\n    $ memory_write content="x" -> R\n\ndefault: run\n`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unconfirmed-mutation");
    expect(um.length).toBeGreaterThanOrEqual(1);
    expect(um.some((f) => /memory_write/.test(f.message))).toBe(true);
  });

  it("silent on $ memory_write preceded by ask(...) gate", async () => {
    const src = `# Skill: t\nrun:\n    ask(prompt="proceed?") -> OK\n    $ memory_write content="x" -> R\n\ndefault: run\n`;
    const r = await lint(src);
    const um = r.findings.filter((f) => f.rule === "unconfirmed-mutation");
    expect(um).toEqual([]);
  });
});
