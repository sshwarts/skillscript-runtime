// Connector contracts — the integration boundary between the runtime and
// external state. Four kinds: SkillStore (where skills live), MemoryStore
// (queryable knowledge), LocalModel (local LLM inference), McpConnector
// (MCP tool dispatch).
//
// T1 baseline: contracts plus bundled-default impls. T2 fleshes out
// capability discovery, identity propagation, the full SkillStore surface
// (status transitions, lifecycle hooks).

/**
 * A skill as seen by the SkillStore — body text plus the minimum metadata
 * required to compile against it. `list()` returns lighter shapes; `load()`
 * returns the full body.
 */
export interface SkillRecord {
  name: string;
  body: string;
  /** Lifecycle state — `Draft` | `Approved` | `Disabled` | unset. */
  status?: string;
  /** Coarse content-fingerprint for provenance. Unix seconds. */
  createdAt?: number;
  description?: string;
}

export interface SkillSummary {
  name: string;
  status?: string;
  description?: string;
}

export interface SkillStore {
  load(name: string): Promise<SkillRecord | null>;
  exists(name: string): Promise<boolean>;
  list(filter?: { status?: string }): Promise<SkillSummary[]>;
  capabilities(): Capabilities;
}

/**
 * Portable memory shape. Field-access semantics (4-tier resolution):
 *   1. Core fields — id, summary, detail, score
 *   2. Curated substrate subset — top-level fields whose concept is portable
 *   3. Substrate-specific — accessed via metadata.X
 *   4. Ambient passthrough — literal $(MEMORY.field) for unknowns
 *
 * Connector duplication discipline: a curated-subset field must be at
 * top-level only, never also in metadata. Silent divergence otherwise.
 */
export interface PortableMemory {
  id: string;
  summary: string;
  detail?: string;
  /** Normalized to 0–1 when possible; otherwise the connector's native scale. */
  score?: number;

  // Curated substrate subset.
  thread_status?: string;
  pinned?: boolean;
  confidence?: number;
  domain_tags?: string[];
  payload_type?: string;
  knowledge_type?: string;
  recipients?: string[];
  expires_at?: number;
  created_at?: number;
  agent_id?: string;
  vault?: string;

  metadata?: Record<string, unknown>;
}

export interface QueryFilters {
  query: string;
  limit: number;
  mode: "fts" | "semantic" | "rerank" | string;
  [key: string]: unknown;
}

export interface Capabilities {
  supportedModes?: string[];
  scoreRange?: "normalized" | "unbounded";
  supportedFilters?: string[];
  [key: string]: unknown;
}

export interface MemoryStore {
  query(filters: QueryFilters): Promise<PortableMemory[]>;
  capabilities(): Capabilities;
}

export interface LocalModel {
  run(prompt: string, opts: { maxTokens?: number; model?: string }): Promise<string>;
  capabilities(): Capabilities;
}

/** Identity overrides threaded through `$` op dispatch. Per-call > registry > intrinsic. */
export interface McpDispatchCtx {
  agentId?: string;
  isAdmin?: boolean;
}

export interface McpConnector {
  call(
    toolName: string,
    args: Record<string, unknown>,
    ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown>;
  capabilities(): Capabilities;
}

/** Eleven curated substrate fields. Connectors route equivalents here at top level; everything else flows into metadata. */
export const CURATED_MEMORY_FIELDS = [
  "thread_status",
  "pinned",
  "confidence",
  "domain_tags",
  "payload_type",
  "knowledge_type",
  "recipients",
  "expires_at",
  "created_at",
  "agent_id",
  "vault",
] as const;

export type CuratedMemoryField = (typeof CURATED_MEMORY_FIELDS)[number];
