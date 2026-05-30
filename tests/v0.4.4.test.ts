import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v0.4.4 — dashboard SPA Connectors view shows wired connectors from
 * the Registry (not just activity metrics). Closes the gap where a user
 * could wire a connector in `connectors.json` but the dashboard's
 * `#connectors` view appeared empty until a skill actually exercised it.
 *
 * Tests at the source-level + asset-bundling layer; full SPA exercise
 * would require a headless browser harness which isn't worth the
 * dependency surface for this UI tweak.
 */

const REPO_ROOT = join(__dirname, "..");
const APP_JS = join(REPO_ROOT, "src/dashboard/spa/app.js");
const DIST_APP_JS = join(REPO_ROOT, "dist/dashboard/spa/app.js");

describe("v0.4.4 — SPA fetches runtime_capabilities + renders wired connectors", () => {
  it("source app.js polls runtime_capabilities in its refresh loop", () => {
    const src = readFileSync(APP_JS, "utf8");
    // Verify the refresh() Promise.all chain includes runtime_capabilities.
    expect(src).toMatch(/callTool\("runtime_capabilities"/);
    expect(src).toMatch(/state\.capabilities\s*=\s*capabilities/);
  });

  it("source app.js renderConnectors uses state.capabilities for the Wired section", () => {
    const src = readFileSync(APP_JS, "utf8");
    expect(src).toMatch(/state\.capabilities/);
    expect(src).toMatch(/wiredMcp/);
    // Renders MCP + LocalModel + DataStore + SkillStore + Agent
    expect(src).toMatch(/Local model/);
    expect(src).toMatch(/Memory store/);
    expect(src).toMatch(/Skill store/);
  });

  it("source app.js shows allowed_tools per MCP connector", () => {
    const src = readFileSync(APP_JS, "utf8");
    // The MCP-extra-columns block surfaces the allowlist (v0.4.1 surface).
    expect(src).toMatch(/Allowed tools/);
    expect(src).toMatch(/allowed_tools/);
  });

  it("source app.js shows available MCP connector classes (closed-set registry)", () => {
    const src = readFileSync(APP_JS, "utf8");
    expect(src).toMatch(/mcpConnectorClasses/);
  });

  it("dist/ build carries the updated SPA after pnpm run build", () => {
    // The build script copies dashboard assets; assert the dist copy has
    // the same wiring as source so deployed dashboards (npm + GHCR) get
    // the fix.
    const dist = readFileSync(DIST_APP_JS, "utf8");
    expect(dist).toMatch(/callTool\("runtime_capabilities"/);
    expect(dist).toMatch(/wiredMcp/);
  });
});
