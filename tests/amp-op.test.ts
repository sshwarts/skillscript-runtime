import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "../src/parser.js";
import { extractReferences, deleteSkill, ReferenceIndex, ReferentialIntegrityError } from "../src/skill-manager.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";

describe("Parser — & op", () => {
  it("parses bare reference", () => {
    const src = `# Skill: caller
t:
    & voice-guide

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const op = p.targets.get("t")!.ops[0]!;
    expect(op.kind).toBe("&");
    expect(op.ampParams).toEqual({ skillName: "voice-guide", args: {} });
    expect(op.outputVar).toBeUndefined();
  });

  it("parses reference with key=value args + output binding", () => {
    const src = `# Skill: caller
t:
    & summarize style=formal max_words=100 -> RESULT

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const op = p.targets.get("t")!.ops[0]!;
    expect(op.kind).toBe("&");
    expect(op.ampParams).toEqual({
      skillName: "summarize",
      args: { style: "formal", max_words: "100" },
    });
    expect(op.outputVar).toBe("RESULT");
  });

  it("rejects malformed & (missing skill name)", () => {
    const src = `# Skill: caller
t:
    &

default: t
`;
    const p = parse(src);
    // Bare `&` doesn't match the regex; parser silently drops per existing
    // convention (the leading `&` isn't followed by a space + name).
    expect(p.targets.get("t")!.ops).toHaveLength(0);
  });

  it("walks foreach + if bodies for references", () => {
    const src = `# Skill: caller
t:
    $set ITEMS = [a, b]
    foreach I in $(ITEMS):
        & voice-guide
    if $(MODE) == "formal":
        & formal-tone
    else:
        & casual-tone

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const refs = extractReferences(src);
    expect(refs).toEqual(["casual-tone", "formal-tone", "voice-guide"]);
  });
});

describe("Parser — # Type: header", () => {
  it("defaults to procedural when header absent", () => {
    const p = parse(`# Skill: t\nt:\n    ! hi\ndefault: t\n`);
    expect(p.type).toBe("procedural");
  });

  it("parses # Type: data", () => {
    const p = parse(`# Skill: voice-guide\n# Type: data\nt:\n    ! content body\ndefault: t\n`);
    expect(p.type).toBe("data");
  });

  it("parses # Type: procedural explicitly", () => {
    const p = parse(`# Skill: t\n# Type: procedural\nt:\n    ! hi\ndefault: t\n`);
    expect(p.type).toBe("procedural");
  });

  it("rejects unknown # Type: values", () => {
    const p = parse(`# Skill: t\n# Type: bogus\nt:\n    ! hi\ndefault: t\n`);
    expect(p.parseErrors.length).toBeGreaterThan(0);
    expect(p.parseErrors[0]).toMatch(/must be 'procedural' or 'data'/);
  });
});

describe("extractReferences — T3 grammar produces real edges", () => {
  it("returns empty for skill with no & ops", () => {
    expect(extractReferences(`t:\n    ! hi\ndefault: t\n`)).toEqual([]);
  });

  it("returns sorted deduplicated refs", () => {
    const src = `t:
    & beta
    & alpha
    & beta

default: t
`;
    expect(extractReferences(src)).toEqual(["alpha", "beta"]);
  });

  it("walks across all targets, not just the entry target", () => {
    const src = `helper:
    & helper-skill

t:
    & main-skill

default: t
`;
    const refs = extractReferences(src);
    expect(refs.sort()).toEqual(["helper-skill", "main-skill"]);
  });
});

describe("T2 integration — reference index lights up via T3 grammar", () => {
  let dir: string;
  let registry: Registry;
  let index: ReferenceIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skillscript-t3-"));
    registry = new Registry();
    registry.registerSkillStore("primary", new FilesystemSkillStore(dir));
    index = new ReferenceIndex();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deleteSkill throws ReferentialIntegrityError when a real & reference exists", async () => {
    const VOICE_GUIDE = `# Skill: voice-guide
# Type: data

t:
    ! formal tone, technical accuracy, second-person

default: t
`;
    const SUPPORT = `# Skill: support-response
t:
    & voice-guide
    ! generate response

default: t
`;
    await registry.getSkillStore().store("voice-guide", VOICE_GUIDE);
    await registry.getSkillStore().store("support-response", SUPPORT);
    // Manually populate the index as storeSkill would (we're testing the
    // integrity machinery, not the wiring through storeSkill — that has
    // its own test).
    index.setOutgoing("support-response", extractReferences(SUPPORT));

    // Delete should throw because support-response references voice-guide.
    try {
      await deleteSkill("voice-guide", { registry, index });
      expect.fail("should have thrown ReferentialIntegrityError");
    } catch (err) {
      expect(err).toBeInstanceOf(ReferentialIntegrityError);
      expect((err as ReferentialIntegrityError).referenced_by).toEqual(["support-response"]);
    }

    // Force-delete bypasses the check.
    await deleteSkill("voice-guide", { registry, index, force: true });
  });
});

describe("Runtime — & op rejects unresolved execution", () => {
  it("throws clear error when an & op reaches the runtime", async () => {
    const src = `# Skill: caller
t:
    & voice-guide
    ! after

default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
    });
    // The `&` op should error; the subsequent `!` should not execute
    // because the op chain bails on the error.
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("&");
    expect(result.errors[0]!.message).toMatch(/unresolved|compile/i);
  });
});
