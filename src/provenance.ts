// Provenance: structured record of what was inlined into a compiled
// artifact + when + by what version of the compiler. Phase 4's `skillfile
// audit` reads this to detect recompile-staleness — when a referenced
// data-skill's source has changed since compile time, the artifact is stale.
//
// Agent-first JSON shape — provenance is machine-consumable metadata, not
// human narrative. The sidecar default keeps the rendered prompt artifact
// focused on dispatch shape; agents that need provenance fetch the sidecar.
// `--inline-provenance` is an audit-priority option that embeds the block
// at the bottom of the rendered artifact.

import type { InlinedDataSkillRef } from "./compile.js";

/** Bumped on breaking changes to the provenance schema. */
export const PROVENANCE_VERSION = "1.0";

/** Tracks the skillscript language grammar version targeted by this artifact. */
export const LANGUAGE_VERSION = "1.0";

/** Bumped on breaking changes to the compiler's render output. */
export const COMPILER_VERSION = "0.1.0-dev";

export interface SourceSkillRef {
  name: string | null;
  /** Substrate-declared opaque label. Equality-comparison only. */
  version?: string;
  /** Substrate-independent SHA-256 of canonical source. */
  content_hash?: string;
}

export interface ProvenanceBlock {
  provenance_version: string;
  language_version: string;
  compiler_version: string;
  /** ISO-8601. The render time, not the source's `# Vars:` resolution time. */
  compiled_at: string;
  source_skill: SourceSkillRef;
  data_skills_inlined: InlinedDataSkillRef[];
}

export interface BuildProvenanceInput {
  sourceSkillName: string | null;
  sourceVersion?: string;
  sourceContentHash?: string;
  dataSkillsInlined: InlinedDataSkillRef[];
}

export function buildProvenance(input: BuildProvenanceInput): ProvenanceBlock {
  const sourceSkill: SourceSkillRef = { name: input.sourceSkillName };
  if (input.sourceVersion !== undefined) sourceSkill.version = input.sourceVersion;
  if (input.sourceContentHash !== undefined) sourceSkill.content_hash = input.sourceContentHash;
  return {
    provenance_version: PROVENANCE_VERSION,
    language_version: LANGUAGE_VERSION,
    compiler_version: COMPILER_VERSION,
    compiled_at: new Date().toISOString(),
    source_skill: sourceSkill,
    data_skills_inlined: input.dataSkillsInlined,
  };
}

/**
 * Render a provenance block as inline trailer markdown for embed at the
 * bottom of a compiled artifact. The agent-readable JSON appears inside
 * a fenced code block so it round-trips cleanly through markdown tools
 * without escaping shenanigans.
 */
export function renderInlineProvenance(block: ProvenanceBlock): string {
  return [
    "",
    "---",
    "",
    "## Provenance",
    "",
    "```json",
    JSON.stringify(block, null, 2),
    "```",
    "",
  ].join("\n");
}

/**
 * Stringify a provenance block for the `.provenance.json` sidecar file.
 * Trailing newline so editors don't complain.
 */
export function renderSidecarProvenance(block: ProvenanceBlock): string {
  return JSON.stringify(block, null, 2) + "\n";
}
