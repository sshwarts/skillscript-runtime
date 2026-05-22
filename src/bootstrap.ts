// Long-lived runtime bootstrap — wires the connector registry, scheduler,
// and MCP server that `skillfile dashboard` (today) and `skillfile serve`
// (v0.3) both depend on. Extracted so the v0.3 split between headless
// scheduler+MCP host and SPA-mounting variant is a trivial new entry point
// rather than a refactor.

import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { Registry } from "./connectors/registry.js";
import { FilesystemSkillStore } from "./connectors/skill-store.js";
import { OllamaLocalModel } from "./connectors/local-model.js";
import { SqliteMemoryStore } from "./connectors/memory-store.js";
import { FilesystemTraceStore } from "./trace.js";
import { Scheduler, type ResolvableTriggerSource } from "./scheduler.js";
import type { TraceConfig } from "./trace.js";
import { McpServer } from "./mcp-server.js";
import { parse } from "./parser.js";
import type { SkillStore } from "./connectors/types.js";

export interface BootstrapOpts {
  skillsDir: string;
  traceDir: string;
  /** When set + existing, register `SqliteMemoryStore` as primary memory_store. */
  memoryDbPath?: string;
  /** Override `OLLAMA_BASE_URL` env default. */
  ollamaBaseUrl?: string;
  /** Scheduler poll interval (default 30s). */
  pollIntervalSeconds?: number;
  /** Forwarded to scheduler/runtime. Default false. */
  enableUnsafeShell?: boolean;
  /** When set, scheduler-driven fires record traces via the result's traceStore. */
  trace?: TraceConfig;
}

export interface BootstrapResult {
  registry: Registry;
  scheduler: Scheduler;
  mcpServer: McpServer;
  skillStore: FilesystemSkillStore;
  traceStore: FilesystemTraceStore;
  /** Read back so runtime_capabilities can surface the active mode. */
  enableUnsafeShell: boolean;
}

const VALID_TRIGGER_SOURCES: ReadonlyArray<ResolvableTriggerSource> = [
  "cron", "session", "event", "agent-event", "file-watch", "sensor",
];

export interface DefaultRegistryOpts {
  skillsDir: string;
  memoryDbPath?: string;
  ollamaBaseUrl?: string;
}

/**
 * Build the default connector registry: primary SkillStore + primary
 * MemoryStore (if the db file/directory exists) + three named LocalModels
 * pointed at Ollama. Used by both `bootstrap()` (long-lived host) and the
 * `skillfile run` one-shot path so both surfaces wire the same defaults.
 */
export function defaultRegistry(opts: DefaultRegistryOpts): { registry: Registry; skillStore: FilesystemSkillStore } {
  const registry = new Registry();
  const skillStore = new FilesystemSkillStore(opts.skillsDir);
  registry.registerSkillStore("primary", skillStore);

  if (opts.memoryDbPath !== undefined && (existsSync(opts.memoryDbPath) || existsSync(dirname(opts.memoryDbPath)))) {
    registry.registerMemoryStore("primary", new SqliteMemoryStore({ dbPath: opts.memoryDbPath }));
  }

  const ollamaUrl = opts.ollamaBaseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
  registry.registerLocalModel("default", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "gemma2:9b" }));
  registry.registerLocalModel("gemma2", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "gemma2:9b" }));
  registry.registerLocalModel("qwen", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "qwen2.5:7b" }));

  return { registry, skillStore };
}

/**
 * Construct the long-lived runtime surface. Caller is expected to:
 *   1. Optionally call `wireDeclarativeTriggers(result)` to register
 *      `# Triggers:` headers from already-Approved skills.
 *   2. Call `result.scheduler.start()` to arm the tick loop.
 *   3. Mount any additional surfaces (e.g., `DashboardServer`) on top of
 *      `result.mcpServer`.
 */
export function bootstrap(opts: BootstrapOpts): BootstrapResult {
  const { registry, skillStore } = defaultRegistry(opts);
  const traceStore = new FilesystemTraceStore(opts.traceDir);
  const enableUnsafeShell = opts.enableUnsafeShell ?? false;

  const scheduler = new Scheduler({
    registry,
    skillStore,
    traceStore,
    ...(opts.pollIntervalSeconds !== undefined ? { pollIntervalSeconds: opts.pollIntervalSeconds } : {}),
    ...(opts.trace !== undefined ? { trace: opts.trace, traceStore } : {}),
    enableUnsafeShell,
  });

  const mcpServer = new McpServer({ skillStore, scheduler, traceStore, registry, enableUnsafeShell });

  return { registry, scheduler, mcpServer, skillStore, traceStore, enableUnsafeShell };
}

/**
 * Walk the SkillStore for Approved skills with declared `# Triggers:`
 * headers and register each into the scheduler. Returns the number of
 * triggers registered. Skips skills whose body fails to parse rather
 * than crashing boot — operators can fix the offender and restart.
 *
 * Implementation note: the SkillStore's `query()` returns SkillMeta with
 * an *optional* `triggers` field; not all impls populate it (the bundled
 * FilesystemSkillStore does not). This helper loads + parses each skill
 * source directly so it works against any SkillStore.
 */
export async function wireDeclarativeTriggers(
  result: Pick<BootstrapResult, "scheduler" | "skillStore">,
  log: (msg: string) => void = (msg) => process.stderr.write(`[bootstrap] ${msg}\n`),
): Promise<{ registered: number; skipped: number }> {
  let registered = 0;
  let skipped = 0;
  const approved = await safeQueryApproved(result.skillStore, log);
  for (const meta of approved) {
    let triggers: ReadonlyArray<{ source: string; name: string }>;
    try {
      const loaded = await result.skillStore.load(meta.name);
      const parsed = parse(loaded.source);
      triggers = parsed.triggers;
    } catch (err) {
      log(`skill '${meta.name}': skipped (parse failed: ${(err as Error).message})`);
      skipped++;
      continue;
    }
    for (const t of triggers) {
      if (!VALID_TRIGGER_SOURCES.includes(t.source as ResolvableTriggerSource)) {
        log(`skill '${meta.name}': skipped trigger '${t.source}: ${t.name}' (unknown source)`);
        skipped++;
        continue;
      }
      result.scheduler.registerTrigger({
        skillName: meta.name,
        source: t.source as ResolvableTriggerSource,
        name: t.name,
        declarative: true,
      });
      registered++;
    }
  }
  if (registered > 0 || skipped > 0) {
    log(`wired ${registered} declarative trigger(s)${skipped > 0 ? `, skipped ${skipped}` : ""} from ${approved.length} Approved skill(s)`);
  }
  return { registered, skipped };
}

async function safeQueryApproved(store: SkillStore, log: (msg: string) => void): Promise<Array<Awaited<ReturnType<SkillStore["query"]>>[number]>> {
  try {
    return await store.query({ status: "Approved" });
  } catch (err) {
    log(`declarative-trigger scan: SkillStore query failed (${(err as Error).message}); proceeding with empty set`);
    return [];
  }
}
