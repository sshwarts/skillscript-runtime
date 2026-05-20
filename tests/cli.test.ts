import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "dist", "cli.js");

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

describe("skillfile CLI", () => {
  it("prints usage on --help", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout).toMatch(/skillfile init/);
  });

  it("runs hello.skill end-to-end with bundled example", () => {
    const r = runCli(["run", "examples/hello.skill"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hello, world!/);
  });

  it("threads --input overrides", () => {
    const r = runCli(["run", "examples/hello.skill", "--input", "WHO=Scott"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hello, Scott!/);
  });

  it("compile emits the rendered artifact", () => {
    const r = runCli(["compile", "examples/hello.skill"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/# Skill: hello/);
    expect(r.stdout).toMatch(/Tell the user: Hello, world!/);
  });

  it("lint reports no findings on the bundled example", () => {
    const r = runCli(["lint", "examples/hello.skill"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK: no findings/);
  });

  it("init scaffolds the tree", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    const r = runCli(["init"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Initialized/);
    // hello.skill should be discoverable after init.
    const r2 = runCli(["run", "examples/hello.skill"], { SKILLSCRIPT_HOME: home });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/Hello, world!/);
  });
});
