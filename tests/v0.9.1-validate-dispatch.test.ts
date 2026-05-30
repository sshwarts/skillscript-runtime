/**
 * v0.9.1 — validateQualifiedDispatch structural fix (P0.1 + P1.5).
 *
 * Closes the multi-layer-promise pattern's third recurrence (v0.7.2 →
 * v0.7.3 → v0.9.0). Lint and runtime share a single validator; both
 * surface the same diagnostic for `$ ref.unknown_tool`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { Registry } from "../src/connectors/registry.js";
import { LocalModelMcpConnector } from "../src/connectors/local-model-mcp.js";
import { DataStoreMcpConnector } from "../src/connectors/data-store-mcp.js";
import { OllamaLocalModel } from "../src/connectors/local-model.js";
import { SqliteDataStore } from "../src/connectors/data-store.js";
import { validateQualifiedDispatch } from "../src/dispatch-validate.js";
import { lint } from "../src/lint.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemTraceStore } from "../src/trace.js";
import type { McpConnector } from "../src/connectors/types.js";

function rpc(method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params } as JsonRpcRequest;
}

async function callTool(srv: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await srv.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.9.1 — validateQualifiedDispatch", () => {
  let dir: string;
  let registry: Registry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v0.9.1-validate-"));
    registry = new Registry();
    registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
    registry.registerLocalModel("default", new OllamaLocalModel({ baseUrl: "http://localhost:11434", defaultModelTag: "gemma2:9b" }));
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(registry.getLocalModel("default")));
    registry.registerDataStore("primary", new SqliteDataStore({ dbPath: join(dir, "mem.db") }));
    const memBridge = new DataStoreMcpConnector(registry.getDataStore("primary"));
    registry.registerMcpConnector("data_read", memBridge);
    registry.registerMcpConnector("data_write", memBridge);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("unit — direct validator calls", () => {
    it("returns no diagnostics for valid qualified dispatch", () => {
      const d = validateQualifiedDispatch({ toolName: "prompt", qualifiedConnector: "llm", registry });
      expect(d).toEqual([]);
    });

    it("returns unknown-tool-on-connector for invalid tool on bundled bridge", () => {
      const d = validateQualifiedDispatch({ toolName: "tweet_post", qualifiedConnector: "llm", registry });
      expect(d).toHaveLength(1);
      expect(d[0]!.code).toBe("unknown-tool-on-connector");
      expect(d[0]!.severity).toBe("error");
      expect((d[0]! as { message: string }).message).toMatch(/'tweet_post' is not declared on connector class/);
    });

    it("returns unknown-connector when connector not wired", () => {
      const d = validateQualifiedDispatch({ toolName: "anything", qualifiedConnector: "nope", registry });
      expect(d).toHaveLength(1);
      expect(d[0]!.code).toBe("unknown-connector");
    });

    it("returns unverified-qualified-tool advisory for connector class without staticTools", () => {
      // Make a stub class without staticTools()
      class StubConnector implements McpConnector {
        static staticCapabilities() {
          return {
            connector_type: "mcp_connector" as const,
            implementation: "StubConnector",
            contract_version: "1.0.0",
            features: {},
          };
        }
        async call(): Promise<unknown> { return {}; }
        async manifest(): Promise<{ capabilities_version: string; manifest: Record<string, unknown> }> {
          return { capabilities_version: "1", manifest: {} };
        }
      }
      registry.registerMcpConnector("stub", new StubConnector());
      const d = validateQualifiedDispatch({ toolName: "any_tool", qualifiedConnector: "stub", registry });
      expect(d).toHaveLength(1);
      expect(d[0]!.code).toBe("unverified-qualified-tool");
      expect(d[0]!.severity).toBe("advisory");
    });

    it("bare dispatch (qualifiedConnector: undefined) skips validation", () => {
      const d = validateQualifiedDispatch({ toolName: "anything", qualifiedConnector: undefined, registry });
      expect(d).toEqual([]);
    });

    it("returns disallowed-tool when allow-list excludes the tool (no double-report with unknown-tool)", () => {
      // Re-wire llm with an explicit allowlist
      registry.registerMcpConnector("llm-restricted", new LocalModelMcpConnector(registry.getLocalModel("default")), ["something_else"]);
      const d = validateQualifiedDispatch({ toolName: "prompt", qualifiedConnector: "llm-restricted", registry });
      expect(d).toHaveLength(1);
      expect(d[0]!.code).toBe("disallowed-tool");
    });
  });

  describe("lint integration — qualified dispatch", () => {
    it("lint fires unknown-tool-on-connector on `$ llm.tweet_post`", async () => {
      const src = `# Skill: bad
# Status: Approved

m:
    $ llm.tweet_post text="hi" -> R

default: m
`;
      const result = await lint(src, { registry });
      const finding = result.findings.find((f) => f.rule === "unknown-tool-on-connector");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("error");
      expect(finding!.message).toMatch(/'tweet_post' is not declared on connector/);
    });

    it("lint passes `$ llm.prompt` clean (no unknown-tool finding)", async () => {
      const src = `# Skill: ok
# Status: Approved

m:
    $ llm.prompt prompt="hi" -> R

default: m
`;
      const result = await lint(src, { registry });
      const finding = result.findings.find((f) => f.rule === "unknown-tool-on-connector");
      expect(finding).toBeUndefined();
    });

    it("lint passes `$ data_read.query` and `$ data_read.data_write` clean", async () => {
      const src = `# Skill: ok
# Status: Approved

m:
    $ data_read.query query="x" -> Q
    $ data_read.data_write content="y" -> W

default: m
`;
      const result = await lint(src, { registry });
      const finding = result.findings.find((f) => f.rule === "unknown-tool-on-connector");
      expect(finding).toBeUndefined();
    });
  });

  describe("runtime integration — same validator catches at dispatch time", () => {
    let mcpServer: McpServer;

    beforeEach(() => {
      mcpServer = new McpServer({
        skillStore: registry.getSkillStore("primary"),
        registry,
        traceStore: new FilesystemTraceStore(join(dir, "traces")),
      });
    });

    it("execute_skill via inline source — runtime rejects `$ llm.tweet_post`", async () => {
      const src = `# Skill: bad
m:
    $ llm.tweet_post text="hi" -> R
    emit(text="unreachable")
default: m
`;
      const r = await callTool(mcpServer, "execute_skill", { source: src });
      const errors = r["errors"] as Array<{ message: string }>;
      expect(errors.length).toBeGreaterThan(0);
      // The defense-in-depth runtime check fires; message preserves the
      // structural validator output.
      expect(errors.some((e) => /tweet_post.*is not declared/.test(e.message))).toBe(true);
    });
  });
});
