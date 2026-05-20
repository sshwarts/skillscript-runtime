import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

async function run(source: string, inputs: Record<string, string> = {}, registry = new Registry()) {
  const compiled = await compile(source);
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
