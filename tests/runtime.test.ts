import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

async function run(source: string, inputs: Record<string, string> = {}, registry = new Registry()) {
  // Tests in this file exercise runtime behavior directly; bypass the
  // tier-1 lint preflight so test sources that intentionally violate
  // (out-of-scope vars, etc.) reach the runtime layer being tested.
  const compiled = await compile(source, { skipLintPreflight: true });
  return execute(compiled.parsed, { ...compiled.resolvedVariables, ...inputs }, compiled.targetOrder, { registry });
}

describe("runtime", () => {
  it("executes a simple skill end-to-end", async () => {
    const src = `# Skill: hello
# Vars: WHO=world

greet:
    ! Hello, $(WHO)!

default: greet
`;
    const result = await run(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hello, world!"]);
    expect(result.outputs["text"]).toBeDefined();
  });

  it("threads $set into substitutions", async () => {
    const src = `t:
    $set X = hello
    ! $(X) world

default: t
`;
    const result = await run(src);
    expect(result.emissions).toEqual(["hello world"]);
  });

  it("iterates foreach over bracket-list var", async () => {
    const src = `t:
    $set ITEMS = [a, b, c]
    foreach I in $(ITEMS):
        ! item $(I)

default: t
`;
    const result = await run(src);
    expect(result.emissions).toEqual(["item a", "item b", "item c"]);
  });

  it("foreach scope is loop-local", async () => {
    const src = `t:
    $set ITEMS = [x]
    foreach I in $(ITEMS):
        $set Y = inside
    ! $(I)

default: t
`;
    const result = await run(src);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toMatch(/Unresolved variable reference/);
  });

  it("evaluates if/elif/else", async () => {
    const src = `t:
    $set MODE = slow
    if $(MODE) == "fast":
        ! fast path
    elif $(MODE) == "slow":
        ! slow path
    else:
        ! default

default: t
`;
    const result = await run(src);
    expect(result.emissions).toEqual(["slow path"]);
  });

  it("else: error handler fires on op failure", async () => {
    const src = `t:
    ?? this fails fast
    ! never
else:
    ! handled

default: t
`;
    const result = await run(src);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.emissions).toContain("handled");
  });

  it("emits @ shell ops without executing", async () => {
    const src = `t:
    @ ls -la /tmp

default: t
`;
    const result = await run(src);
    expect(result.emissions).toEqual(["Run shell: ls -la /tmp"]);
    expect(result.errors).toEqual([]);
  });

  it("surfaces inner-tool isError:true as op error (c580de5)", async () => {
    // Error-propagation contract: when an inner MCP tool returns
    // {isError:true}, the runtime throws an op error rather than silently
    // binding the error text to the output var. Without this, skills mask
    // failures and continue.
    const registry = new Registry();
    registry.registerMcpConnector("primary", new CallbackMcpConnector(async () => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    })));
    const src = `t:
    $ failing_tool arg=x

default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("$");
    expect(result.errors[0]!.message).toMatch(/isError:.*boom/);
  });

  it("unwraps CallToolResult content[0].text", async () => {
    const registry = new Registry();
    registry.registerMcpConnector("primary", new CallbackMcpConnector(async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, count: 3 }) }],
    })));
    const src = `t:
    $ some_tool -> RESULT
    ! $(RESULT.count)

default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["3"]);
  });

  it("`??` interactive mode binds response when user approves", async () => {
    const src = `t:
    ?? approve fix? -> APPROVED
    ! got $(APPROVED)

default: t
`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      askUser: async () => "yes",
    });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["got yes"]);
  });

  it("`??` decline ('no') binds response AND short-circuits dependent target via else:", async () => {
    // Footgun #20: decline binds the value AND throws soft op-error so
    // `else:` fires. Closes the silent-fall-through to subsequent `apply:`.
    const src = `apply:
    ?? proceed? -> CONFIRMED
    ! applying $(CONFIRMED)
else:
    ! declined, no-op

default: apply
`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      askUser: async () => "no",
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("??");
    expect(result.errors[0]!.message).toMatch(/User declined/);
    expect(result.emissions).toEqual(["declined, no-op"]);
    expect(result.finalVars["CONFIRMED"]).toBe("no");
  });

  it("`??` decline treats empty/n/false/0 as falsey", async () => {
    const declineInputs = ["", "n", "no", "NO", "false", "0", "  "];
    for (const input of declineInputs) {
      const src = `t:
    ?? confirm -> R
else:
    ! declined

default: t
`;
      const compiled = await compile(src, { skipLintPreflight: true });
      const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
        registry: new Registry(),
        askUser: async () => input,
      });
      expect(result.errors.length, `decline expected for input ${JSON.stringify(input)}`).toBe(1);
      expect(result.emissions, `else: expected to fire for input ${JSON.stringify(input)}`).toEqual(["declined"]);
    }
  });

  it("`??` without askUser still fails fast in autonomous mode", async () => {
    const src = `t:
    ?? prompt -> R

default: t
`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/autonomous execution/);
  });

  it("mechanical mode skips $/~/> dispatch", async () => {
    const src = `t:
    $ would_dispatch x=1
    ! after

default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      mechanical: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toMatch(/Would call tool.*mechanical/);
  });
});
