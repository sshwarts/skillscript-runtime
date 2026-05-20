# Architecture

One-page map of the `skillscript-runtime` codebase. Per ERD §1, the core stays ≤ 5K LOC across < 20 source files. Tests count separately.

## Top-level layout

```
src/
  index.ts              — library entrypoint; named exports for embedders
  cli.ts                — `skillfile` CLI entrypoint
  parser.ts             — source text → AST
  compile.ts            — AST → resolved skill model → rendered artifact
  lint.ts               — structural validation (compiler preflight + standalone)
  runtime.ts            — executor: walks compiled artifact, dispatches ops
  scheduler.ts          — trigger registry + cron scan
  output.ts             — output dispatch (text, prompt-context, none)
  connectors/
    types.ts            — contracts: SkillStore, MemoryStore, LocalModel, McpConnector
    registry.ts         — per-kind instance registry + three-layer resolution
    skill-store.ts      — bundled default: filesystem at ~/.skillscript/skills/
    memory-store.ts     — bundled default: SQLite + FTS at ~/.skillscript/memory.db
    local-model.ts      — bundled default: Ollama at localhost:11434
    mcp.ts              — bundled default: stub; no servers wired by default
```

Target: 14 source files. Budget for future growth: 5 more.

## What each file owns

| File | Responsibility |
| --- | --- |
| `parser.ts` | Tokenize and parse skill source. Header lines, target blocks, op grammar, conditionals, `foreach`, variable interpolation. Produces AST. Syntax errors only — semantic checks are downstream. |
| `compile.ts` | Three subsystems: (1) variable resolution against `# Requires:` cascade + caller inputs; (2) data-skill compile-time inlining; (3) topo-sort + render. Output formats: `prompt` (canonical), `prose`, `test`. Produces compiled artifact + provenance. |
| `lint.ts` | Structural rules: undeclared vars, missing deps, malformed ops, lifecycle status enforcement, `@@` opt-in flagging. Used by `compile.ts` as preflight and exposed as `skillfile lint`. Structured diagnostics. |
| `runtime.ts` | Executor that walks the compiled artifact and dispatches ops through connector instances. Handles error propagation, per-op timeout chain, `foreach` iteration, conditionals, `$set`, output binding. |
| `scheduler.ts` | Trigger registry. Cron firing in v1; event/agent-event/file-watch/sensor are parse-only. Status-aware: skips `Draft` / `Disabled` skills at fire time. |
| `output.ts` | Routes the goal target's output by `# Output:` header. Kinds: `text` (stdout), `prompt-context` (returns to caller), `none`. |
| `connectors/types.ts` | The four contract interfaces. The integration boundary — every external system (skill storage, memory, local model, MCP) plugs in through one of these. |
| `connectors/registry.ts` | Maps connector names to instances. Three-layer resolution: per-call override > skill-declared > primary default. Multi-instance support. |
| `connectors/skill-store.ts` | Filesystem-backed `SkillStore`. Reads/writes skills as `*.skill` files under `~/.skillscript/skills/`. Status transitions produce git-friendly file history. |
| `connectors/memory-store.ts` | SQLite-backed `MemoryStore` with FTS5. Schema: `memories(id, summary, detail, tags, created_at)`. PortableMemory shape + metadata bag. |
| `connectors/local-model.ts` | Ollama HTTP client. Bundled instances: `default` and `gemma2` (both `gemma2:9b`), `qwen` (`qwen2.5:7b`). |
| `connectors/mcp.ts` | MCP connector scaffold. v1: no servers wired by default; `connectors.json` has commented example. |

## Non-source

```
docs/                   — spec documentation (PRD, Language Reference, ERD)
examples/               — bundled example skills (incl. `hello.skill`)
scaffold/               — files copied by `skillfile init` into ~/.skillscript/
scripts/loc-ceiling.mjs — CI check; fails if core exceeds budget
tests/                  — vitest specs
.github/workflows/      — CI: tests + loc-ceiling on push/PR
Dockerfile              — multi-arch image base
docker-compose.yml      — runtime + Ollama + SQLite volume
```

## Out-of-scope for T1

Defers to later threads per the v1 plan:

- **T2** — full connector contract surface, capabilities discovery, identity propagation
- **T3** — data-skill inlining in `compile.ts` (T1 ports the existing simpler compile path)
- **T4** — 20-rule v1 lint set + adversarial library
- **T5** — autonomous trigger dispatch (T1 has parse-only `# Triggers:`)
- **T6** — browser dashboard
- **T7** — full CLI (`diagram`, `audit`, `sign`/`verify`, etc.), MCP server contract
- **T8** — backend-specific adapters for the four contracts
