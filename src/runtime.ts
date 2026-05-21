import type { ParsedSkill, SkillOp, OutputDecl } from "./parser.js";
import { tokenizeKeywordArgs, processSetValue } from "./parser.js";
import { applyFilter } from "./filters.js";
import type { Registry } from "./connectors/registry.js";
import { spawn } from "node:child_process";

/**
 * Runtime executor. Pure mechanical execution: walks the parsed skill
 * tree, dispatches each op to its handler, threads variable state.
 *
 * Key design properties:
 *   - `$ TOOL ...` ops route through McpConnector via the registry.
 *     Without one wired, ops echo and bind null (mechanical-only mode).
 *   - `@ shell ...` is echo-only. Runtime never shell-execs; calling agent
 *     dispatches via its own Bash tool. Principle of least privilege.
 *   - `outputs` populates default-to-`lastBoundVar`, else emissions.
 *   - `??` (ask user) is fail-fast — runtime cannot pause for input.
 *   - `?` (reason) is a thought-step — emitted, doesn't bind.
 *   - Error chain: target-level `else:` → skill-level `# OnError:` fallback
 *     → bubble up.
 *   - Foreach scope is loop-local — vars introduced inside the body deleted on exit.
 */

export interface ExecuteContext {
  registry: Registry;
  /** Identity the skill runs as. Threaded through to McpConnector dispatch overrides. */
  agentId?: string;
  /** Test escape hatch: dispatch `$` ops bare-named tools through this callback when no `primary` McpConnector is registered. */
  toolDispatch?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Invoked when target ops fail with no target-level `else:` but the skill declares `# OnError:`. */
  fallbackSkillExecutor?: (
    skillName: string,
    vars: Record<string, unknown>,
  ) => Promise<ExecuteResult>;
  /** Mechanical-only preview: `$` / `~` / `>` ops skip real dispatch and bind a placeholder. */
  mechanical?: boolean;
  /**
   * Interactive-mode user-input callback. When provided, `??` ops invoke it
   * with the prompt and bind the response to the output variable. When
   * omitted, `??` fails fast (autonomous mode per decision 6). Per Section 2
   * Ops `??` decline semantics: a `no`/`n`/empty/falsey response binds the
   * value AND short-circuits downstream targets via soft op-error so
   * `else:` fires.
   */
  askUser?: (prompt: string) => Promise<string>;
  /**
   * Runtime absolute timeout (milliseconds) — the built-in fallback when no
   * per-op, skill, or connector default applies. Per ERD §6 decision 7,
   * default is 300_000ms (5 minutes). Configurable for tests + deployments
   * with shorter cancellation windows.
   */
  absoluteTimeoutMs?: number;
  /**
   * Enables `@ unsafe <command>` dispatch via full bash shell. Default
   * `false` — `@ unsafe` ops fail with `UnsafeShellDisabledError`. Per
   * Section 4 Security: operators opt in explicitly per deployment; lint
   * flags every `@ unsafe` op regardless.
   */
  enableUnsafeShell?: boolean;
}

export interface ExecutionError {
  target: string;
  opKind: string;
  message: string;
}

export interface ExecuteResult {
  finalVars: Record<string, unknown>;
  emissions: string[];
  outputs: Record<string, unknown>;
  errors: ExecutionError[];
  targetOrder: string[];
}

interface ExecOpsResult {
  lastBoundVar: string | null;
  lastValue: unknown;
}

/**
 * Execute a parsed skill against the live variable state. Walks targets in
 * the provided order. Each target's ops run sequentially; on failure the
 * chain falls back to `else:` → `# OnError:` → bubble.
 */
export async function execute(
  parsed: ParsedSkill,
  initialVars: Record<string, unknown>,
  order: string[],
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  const vars = new Map<string, unknown>();
  for (const v of parsed.vars) {
    if (v.default !== undefined) vars.set(v.name, coerceLiteralValue(v.default));
  }
  for (const [k, val] of Object.entries(initialVars)) {
    vars.set(k, typeof val === "string" ? coerceLiteralValue(val) : val);
  }
  const emissions: string[] = [];
  const errors: ExecutionError[] = [];
  let lastBoundVar: string | null = null;

  const absoluteTimeoutMs = ctx.absoluteTimeoutMs ?? DEFAULT_RUNTIME_ABSOLUTE_TIMEOUT_MS;
  for (const targetName of order) {
    const target = parsed.targets.get(targetName);
    if (!target) continue;

    let targetLastBound: string | null = null;
    let targetLastValue: unknown = undefined;

    try {
      const r = await execOps(target.ops, vars, emissions, ctx, targetName, parsed.timeout, absoluteTimeoutMs);
      targetLastBound = r.lastBoundVar;
      targetLastValue = r.lastBoundVar !== null ? vars.get(r.lastBoundVar) : r.lastValue;
    } catch (err) {
      const e = err as Error & { opKind?: string };
      errors.push({
        target: targetName,
        opKind: e.opKind ?? "?",
        message: e.message,
      });
      if (target.elseBlock !== undefined) {
        try {
          const r = await execOps(target.elseBlock, vars, emissions, ctx, targetName, parsed.timeout, absoluteTimeoutMs);
          targetLastBound = r.lastBoundVar;
          targetLastValue = r.lastBoundVar !== null ? vars.get(r.lastBoundVar) : r.lastValue;
        } catch (innerErr) {
          errors.push({
            target: targetName,
            opKind: "else",
            message: (innerErr as Error).message,
          });
        }
      } else if (parsed.onError !== null && ctx.fallbackSkillExecutor) {
        try {
          const fbResult = await ctx.fallbackSkillExecutor(
            parsed.onError,
            Object.fromEntries(vars),
          );
          for (const em of fbResult.emissions) emissions.push(em);
          for (const fe of fbResult.errors) errors.push(fe);
        } catch (fbErr) {
          errors.push({
            target: parsed.onError,
            opKind: "skill-fallback",
            message: (fbErr as Error).message,
          });
        }
        break;
      } else {
        break;
      }
    }

    vars.set(`${targetName}.output`, targetLastValue);
    if (targetLastBound !== null) lastBoundVar = targetLastBound;
  }

  // Outputs map per `# Output:` declarations. Per-kind value semantics:
  //   - Human-readable surfaces (`prompt-context:`, `slack:`, `card:`):
  //     default to joined emissions. These deliver content for an agent
  //     or human to *read*; trailing `>`/`~` JSON values are the wrong shape.
  //   - Programmatic surfaces (`text`, `file:`): default to lastBoundVar
  //     (structured), fall back to emissions array. Callers consuming
  //     `outputs.text` typically want the structured return value.
  //   - `none`: no-op marker; value irrelevant.
  const TEXT_SHAPED_KINDS = new Set<OutputDecl["kind"]>(["prompt-context", "slack", "card"]);
  const outputDecls: OutputDecl[] = parsed.outputs.length > 0
    ? parsed.outputs
    : [{ kind: "text" }];
  const outputs: Record<string, unknown> = {};
  for (const decl of outputDecls) {
    const key = decl.target !== undefined ? `${decl.kind}:${decl.target}` : decl.kind;
    if (TEXT_SHAPED_KINDS.has(decl.kind)) {
      outputs[key] = emissions.join("\n");
    } else if (lastBoundVar !== null && vars.has(lastBoundVar)) {
      outputs[key] = vars.get(lastBoundVar);
    } else {
      outputs[key] = emissions.slice();
    }
  }

  return {
    finalVars: Object.fromEntries(vars),
    emissions,
    outputs,
    errors,
    targetOrder: order,
  };
}

async function execOps(
  ops: SkillOp[],
  vars: Map<string, unknown>,
  emissions: string[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
): Promise<ExecOpsResult> {
  let lastBoundVar: string | null = null;
  let lastValue: unknown = undefined;
  for (const op of ops) {
    const r = await execOp(op, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs);
    if (r.lastBoundVar !== null) {
      lastBoundVar = r.lastBoundVar;
      lastValue = r.lastValue;
    } else if (r.lastValue !== undefined) {
      lastValue = r.lastValue;
    }
  }
  return { lastBoundVar, lastValue };
}

async function execOp(
  op: SkillOp,
  vars: Map<string, unknown>,
  emissions: string[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
): Promise<ExecOpsResult> {
  try {
    return await execOpInner(op, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs);
  } catch (err) {
    // Default-tag any escaping error with `op.kind`. Explicit makeOpError()
    // tags take precedence. Fixes the case where `~` failures classified as `?`.
    const e = err as Error & { opKind?: string };
    if (e.opKind === undefined) e.opKind = op.kind;
    throw e;
  }
}

async function execOpInner(
  op: SkillOp,
  vars: Map<string, unknown>,
  emissions: string[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
): Promise<ExecOpsResult> {
  switch (op.kind) {
    case "$set": {
      const coerced = coerceLiteralValue(op.setValue!);
      vars.set(op.setName!, coerced);
      return { lastBoundVar: op.setName!, lastValue: coerced };
    }
    case "?": {
      const body = substituteRuntime(op.body, vars);
      emissions.push(`Reason: ${body}`);
      return { lastBoundVar: null, lastValue: undefined };
    }
    case "!": {
      const body = substituteRuntime(op.body, vars);
      emissions.push(body);
      return { lastBoundVar: null, lastValue: undefined };
    }
    case "@": {
      const body = op.policy === "unsafe"
        ? substituteRuntimeUnsafe(op.body, vars)
        : substituteRuntime(op.body, vars);
      const shellTimeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
      if (ctx.mechanical === true) {
        const label = op.policy === "unsafe" ? "Would run unsafe shell" : "Would run shell";
        emissions.push(`${label}: ${body} (mechanical: true preview).`);
        return { lastBoundVar: null, lastValue: undefined };
      }
      let stdout: string;
      if (op.policy === "unsafe") {
        if (ctx.enableUnsafeShell !== true) {
          throw makeOpError(
            "@",
            `\`@ unsafe\` op refused: \`runtime.enable_unsafe_shell\` is false. Set ctx.enableUnsafeShell = true to permit (after reviewing the shell content). Command was: '${body.slice(0, 80)}${body.length > 80 ? "..." : ""}'`,
          );
        }
        stdout = await execShellCommand("bash", ["-c", body], shellTimeoutMs);
      } else {
        const tokens = tokenizeShellArgs(body);
        if (tokens.length === 0) {
          throw makeOpError("@", `Empty \`@\` op body in target '${targetName}'.`);
        }
        const [bin, ...args] = tokens;
        stdout = await execShellCommand(bin!, args, shellTimeoutMs);
      }
      const flatKey = `${targetName}.output`;
      vars.set(flatKey, stdout);
      if (op.outputVar !== undefined) vars.set(op.outputVar, stdout);
      return {
        lastBoundVar: op.outputVar ?? flatKey,
        lastValue: stdout,
      };
    }
    case "??": {
      const promptStr = substituteRuntime(op.body, vars);
      if (ctx.askUser === undefined) {
        // Autonomous mode — no interactive surface wired. Per decision 6 +
        // §6 dispatcher routing, `??` fails fast so dependent targets don't
        // silently fall through.
        throw makeOpError(
          "??",
          `\`??\` ask-user encountered in autonomous execution: ${promptStr}. ` +
          `Restructure the skill to take the value as an input or via \`# Requires:\`, ` +
          `or invoke from an interactive context that wires \`askUser\`.`,
        );
      }
      const response = await ctx.askUser(promptStr);
      const outName = op.outputVar;
      if (outName !== undefined) vars.set(outName, response);
      // Decline semantics (per Section 2 Ops + §13 Open Q #2 resolution):
      // bind the response AND short-circuit downstream via soft op-error
      // routed through else: / # OnError:. Closes the silent-fall-through
      // security bug pattern (subsequent `apply:` running on a "no").
      if (isDeclineResponse(response)) {
        throw makeOpError(
          "??",
          `User declined at \`??\` prompt: '${promptStr}' (response: '${response}'). Dependent targets short-circuited.`,
        );
      }
      return {
        lastBoundVar: outName ?? null,
        lastValue: response,
      };
    }
    case "&": {
      // `&` ops are resolved at compile time — data-skill content is
      // inlined; procedural-skill refs compile to a runtime invocation
      // shape (not this op). If we hit `&` at runtime, the executor was
      // handed a raw AST that bypassed compile().
      const skillName = op.ampParams?.skillName ?? "(unknown)";
      throw makeOpError(
        "&",
        `\`& ${skillName}\` reached the runtime unresolved. The compile() ` +
        `step inlines data-skills and lowers procedural refs to invocation ` +
        `ops; running raw parsed skills bypasses that. Call compile() ` +
        `before execute().`,
      );
    }
    case "$": {
      const body = substituteRuntime(op.body, vars);
      const m = /^([A-Za-z_][\w:-]*)\s*([\s\S]*)$/.exec(body);
      if (m === null) {
        throw makeOpError(
          "$",
          `Malformed \`$\` op body: '${body}' — expected 'TOOL_NAME key=value ...'`,
        );
      }
      const toolName = m[1]!;
      const argsStr = m[2] ?? "";
      const args = parseToolArgs(argsStr);
      const connectorLabel = op.mcpConnector !== undefined ? `${op.mcpConnector}.` : "";
      const flatKey = `${targetName}.output`;

      // Mechanical preview, registry-routed, test escape hatch, no-dispatcher.
      if (ctx.mechanical === true) {
        emissions.push(
          `Would call tool ${connectorLabel}${toolName} with ${JSON.stringify(args)} (mechanical: true preview).`,
        );
        vars.set(flatKey, null);
        if (op.outputVar !== undefined) vars.set(op.outputVar, null);
        return {
          lastBoundVar: op.outputVar ?? flatKey,
          lastValue: null,
        };
      }

      const connectorName = op.mcpConnector ?? "primary";
      let rawResult: unknown;
      let dispatched = false;
      const timeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
      if (ctx.registry.hasMcpConnector(connectorName)) {
        const connector = ctx.registry.getMcpConnector(connectorName);
        rawResult = await dispatchWithTimeout(
          () => connector.call(toolName, args, ctx.agentId !== undefined ? { agentId: ctx.agentId } : undefined),
          timeoutMs,
          "$",
        );
        dispatched = true;
      } else if (op.mcpConnector === undefined && ctx.toolDispatch) {
        rawResult = await dispatchWithTimeout(() => ctx.toolDispatch!(toolName, args), timeoutMs, "$");
        dispatched = true;
      } else if (op.mcpConnector !== undefined) {
        throw new Error(`McpConnector '${connectorName}' not registered.`);
      }

      if (!dispatched) {
        emissions.push(
          `Would call tool ${connectorLabel}${toolName} with ${JSON.stringify(args)} (no dispatcher wired).`,
        );
        vars.set(flatKey, null);
        if (op.outputVar !== undefined) vars.set(op.outputVar, null);
        return {
          lastBoundVar: op.outputVar ?? flatKey,
          lastValue: null,
        };
      }
      // c580de5: surface inner-tool `isError: true` as an op error. Otherwise
      // the error text gets bound silently to the output var and the skill
      // continues. Throw so the outer execOps catch records this in
      // `result.errors[]` and the else/OnError fallback machinery can fire.
      if (
        rawResult !== null &&
        typeof rawResult === "object" &&
        (rawResult as { isError?: unknown }).isError === true
      ) {
        const innerText = extractToolErrorText(rawResult);
        throw makeOpError(
          "$",
          `tool ${connectorLabel}${toolName} returned isError: ${innerText}`,
        );
      }
      const bindValue = unwrapToolResult(rawResult);
      vars.set(flatKey, bindValue);
      if (op.outputVar !== undefined) vars.set(op.outputVar, bindValue);
      return {
        lastBoundVar: op.outputVar ?? flatKey,
        lastValue: bindValue,
      };
    }
    case ">": {
      const p = op.retrievalParams!;
      const querySub = substituteRuntime(p.query, vars);
      const extraSub: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.extra)) {
        extraSub[k] = substituteRuntime(v, vars);
      }
      if (ctx.mechanical === true) {
        emissions.push(
          `Would query MemoryStore \`${p.connector}\` with mode=${p.mode}, ` +
          `query="${querySub}", limit=${p.limit} (mechanical: true preview). ` +
          `Binding $(${op.outputVar}) = [] (empty result set).`,
        );
        vars.set(op.outputVar!, []);
        return { lastBoundVar: op.outputVar!, lastValue: [] };
      }
      const store = ctx.registry.getMemoryStore(p.connector);
      const limitResolved = resolveIntParam(p.limit, vars, "limit");
      const filters = {
        query: querySub,
        mode: p.mode,
        limit: limitResolved,
        ...extraSub,
      };
      const retrievalTimeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
      const results = await dispatchWithTimeout(() => store.query(filters), retrievalTimeoutMs, ">");
      vars.set(op.outputVar!, results);
      return { lastBoundVar: op.outputVar!, lastValue: results };
    }
    case "~": {
      const p = op.localModelParams!;
      const promptSub = substituteRuntime(p.prompt, vars);
      if (ctx.mechanical === true) {
        const modelName = p.model ?? "default";
        const placeholder = `[mechanical: would call LocalModel ${modelName} with prompt='${promptSub}']`;
        emissions.push(`Would invoke LocalModel \`${modelName}\` (mechanical: true preview). Binding $(${op.outputVar}) = ${placeholder}`);
        vars.set(op.outputVar!, placeholder);
        return { lastBoundVar: op.outputVar!, lastValue: placeholder };
      }
      const model = ctx.registry.getLocalModel(p.model);
      const runOpts: { maxTokens?: number; model?: string } = {};
      if (p.maxTokens !== undefined) {
        runOpts.maxTokens = resolveIntParam(p.maxTokens, vars, "maxTokens");
      }
      const tildeTimeoutMs = resolveOpTimeoutMs(p.timeoutSeconds, skillTimeoutSec, absoluteTimeoutMs, vars);
      const response = await dispatchWithTimeout(() => model.run(promptSub, runOpts), tildeTimeoutMs, "~");
      vars.set(op.outputVar!, response);
      return { lastBoundVar: op.outputVar!, lastValue: response };
    }
    case "foreach": {
      const listVal = resolveListExpr(op.foreachList!, vars);
      const iterName = op.foreachIter!;
      const before = new Set<string>(vars.keys());
      let last: ExecOpsResult = { lastBoundVar: null, lastValue: undefined };
      for (const item of listVal) {
        vars.set(iterName, item);
        last = await execOps(op.foreachBody!, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs);
      }
      for (const k of Array.from(vars.keys())) {
        if (!before.has(k)) vars.delete(k);
      }
      return last;
    }
    case "if": {
      for (const branch of op.ifBranches!) {
        if (evalCondition(branch.cond, vars)) {
          return execOps(branch.body, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs);
        }
      }
      if (op.ifElseBody !== undefined) {
        return execOps(op.ifElseBody, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs);
      }
      return { lastBoundVar: null, lastValue: undefined };
    }
  }
  return { lastBoundVar: null, lastValue: undefined };
}

function makeOpError(opKind: string, message: string): Error & { opKind: string } {
  const err = new Error(message) as Error & { opKind: string };
  err.opKind = opKind;
  return err;
}

const DEFAULT_RUNTIME_ABSOLUTE_TIMEOUT_MS = 300_000;

/**
 * Per-op timeout resolution chain (ERD §6 decision 7) — top wins:
 *   1. Per-op override (`~ ... timeoutSeconds=30 ...`)
 *   2. Skill-level `# Timeout: N` header
 *   3. Connector instance default (v1: not yet declared by impls — collapses
 *      to built-in fallback when no per-op or skill-level value is present)
 *   4. Built-in language fallback (`absoluteTimeoutMs`, default 300000ms)
 *
 * Both per-op and skill-level values are in seconds (per author convention)
 * and converted to milliseconds here.
 */
function resolveOpTimeoutMs(
  perOpTimeoutSec: number | string | undefined,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  vars: Map<string, unknown>,
): number {
  if (perOpTimeoutSec !== undefined) {
    return resolveIntParam(perOpTimeoutSec, vars, "timeoutSeconds") * 1000;
  }
  if (skillTimeoutSec !== null) {
    return resolveIntParam(skillTimeoutSec, vars, "# Timeout:") * 1000;
  }
  return absoluteTimeoutMs;
}

/**
 * Race the op against a timer. On timeout, throws `OpTimeoutError`-shaped
 * op-error so the existing else: / # OnError: machinery catches it.
 *
 * v1 caveat: timeout returns control to the executor promptly, but the
 * underlying request may still complete in the background — its result is
 * discarded. v2 should thread AbortSignal through connector contracts so
 * implementations can cancel cleanly.
 */
async function dispatchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  opKind: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(makeOpError(opKind, `Op '${opKind}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Decline detection for `??` interactive responses. A response is declining
 * when trimmed-lowercase matches `no`/`n`/`false`/`0` or is empty. Anything
 * else (including "yes", "y", or any non-empty positive content) is treated
 * as approval.
 */
/**
 * Tokenize a shell-style command body into binary + args. Respects matching
 * single/double quotes; strips outer quotes. No metachar interpretation —
 * the structural-spawn sandbox forbids shell processing per decision 2.
 */
function tokenizeShellArgs(body: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * Spawn a child process and capture stdout. SIGKILL on timeout via the
 * process group (kills child + descendants). Non-zero exit → op-error with
 * stderr preserved per ERD §6 dispatcher routing.
 */
async function execShellCommand(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      // Send SIGKILL to the process group on POSIX. Windows lacks process
      // groups; fall back to direct child kill (descendants leak — out of
      // v1 scope to fix).
      if (process.platform !== "win32" && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(makeOpError("@", `Failed to spawn '${bin}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(makeOpError("@", `Op '@' timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const trimmed = stderr.trim();
        reject(makeOpError(
          "@",
          `Shell command '${bin}' exited with code ${code}${trimmed ? `: ${trimmed.slice(0, 200)}` : ""}.`,
        ));
        return;
      }
      // Strip trailing newline — convention for shell command output.
      resolve(stdout.replace(/\n$/, ""));
    });
  });
}

function isDeclineResponse(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === "" || t === "no" || t === "n" || t === "false" || t === "0";
}

/**
 * Resolve an integer parameter that may be a literal number or a string
 * containing a `$(VAR)` ref. Substitutes any refs then parseInts. Throws
 * a clear runtime error if the resolved value isn't a positive integer —
 * the parser deferred validation to here because at parse time the ref
 * couldn't be resolved.
 */
function resolveIntParam(raw: number | string, vars: Map<string, unknown>, paramName: string): number {
  if (typeof raw === "number") return raw;
  const substituted = substituteRuntime(raw, vars);
  const n = parseInt(substituted, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`'${paramName}' resolved to '${substituted}', which isn't a positive integer.`);
  }
  return n;
}

function extractToolErrorText(rawResult: unknown): string {
  if (rawResult === null || typeof rawResult !== "object") return String(rawResult);
  const obj = rawResult as { content?: unknown };
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const first = obj.content[0] as { type?: string; text?: string } | undefined;
    if (first && first.type === "text" && typeof first.text === "string") {
      return first.text;
    }
  }
  try {
    return JSON.stringify(rawResult);
  } catch {
    return "(unparseable error envelope)";
  }
}

function parseToolArgs(argsStr: string): Record<string, unknown> {
  const tokens = tokenizeKeywordArgs(argsStr);
  const args: Record<string, unknown> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq === -1) continue;
    const key = tok.slice(0, eq).trim();
    const rawValue = tok.slice(eq + 1);
    args[key] = processSetValue(rawValue);
  }
  return args;
}

function resolveListExpr(expr: string, vars: Map<string, unknown>): unknown[] {
  const trimmed = expr.trim();
  const ref = /^\$\(([^)]+)\)$/.exec(trimmed);
  if (ref) {
    const val = resolveRef(ref[1]!, vars);
    if (Array.isArray(val)) return val;
    if (val === undefined || val === null) return [];
    return [val];
  }
  const list = /^\[(.*)\]$/.exec(trimmed);
  if (list) {
    const inner = list[1]!.trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => {
      const t = s.trim();
      if (t.length >= 2) {
        const first = t[0]!;
        const last = t[t.length - 1]!;
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          return t.slice(1, -1);
        }
      }
      return t;
    });
  }
  const sub = substituteRuntime(trimmed, vars);
  try {
    const v = JSON.parse(sub);
    if (Array.isArray(v)) return v;
  } catch {
    /* not JSON — wrap */
  }
  return [sub];
}

/**
 * Unwrap `CallToolResult`-shaped values into the meaningful payload.
 * Symmetry with `>` (binds `PortableMemory[]`) and `~` (binds the response
 * string) — `$` should bind the *content*, not the wire envelope.
 *
 * Rules:
 *   1. Non-CallToolResult-shaped — bind as-is.
 *   2. `content[0].type === "text"` + JSON-parseable — bind parsed.
 *   3. `content[0].type === "text"` + non-parseable — bind the raw string.
 *   4. Non-text content — bind the content array.
 */
function unwrapToolResult(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const obj = result as { content?: unknown };
  if (!Array.isArray(obj.content)) return result;
  const first = obj.content[0] as { type?: string; text?: string } | undefined;
  if (!first) return result;
  if (first.type !== "text" || typeof first.text !== "string") {
    return obj.content;
  }
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

/**
 * Coerce a string literal into its natural JS type when the shape is
 * unambiguous. v1: bracket-list `[a, b, c]` → array. Other shapes pass through.
 */
function coerceLiteralValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return raw;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => {
    const t = s.trim();
    if (t.length >= 2) {
      const first = t[0]!;
      const last = t[t.length - 1]!;
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return t.slice(1, -1);
      }
    }
    return t;
  });
}

// ─── Substitution and condition evaluation (runtime-side) ─────────────────

/**
 * Variant for `@ unsafe` op bodies. The `$$(...)` escape lets authors send
 * `$(...)` literally to bash (for bash command-substitution); skillscript
 * substitution sees `$$` and collapses to `$`. `$(NAME)` (single `$`)
 * remains a skillscript variable substitution.
 */
export function substituteRuntimeUnsafe(text: string, vars: Map<string, unknown>): string {
  // Step 1: pull `$$(` escapes out so step 2's regex doesn't see the inner $.
  const ESCAPE = " DOLLAR_DOLLAR_PAREN ";
  const escaped = text.replace(/\$\$\(/g, ESCAPE);
  // Step 2: normal skillscript substitution against the de-escaped text.
  const substituted = substituteRuntime(escaped, vars);
  // Step 3: restore the escape as literal `$(` for bash.
  return substituted.replace(new RegExp(ESCAPE, "g"), "$(");
}

/**
 * Runtime `$(NAME[|filter])` substitution. At runtime the full variable
 * state is in scope; unresolved refs are a hard error (compile-time leaves
 * them to pass through; runtime can't).
 */
export function substituteRuntime(text: string, vars: Map<string, unknown>): string {
  return text.replace(
    /\$\(([^|)\s]+)\s*(?:\|\s*([A-Za-z_]\w*))?\s*\)/g,
    (_match: string, ref: string, filter: string | undefined) => {
      const value = resolveRef(ref, vars);
      if (value === undefined) {
        throw new Error(`Unresolved variable reference at runtime: $(${ref})`);
      }
      const s = stringifyValue(value);
      if (!filter) return s;
      return applyFilter(s, filter);
    },
  );
}

/**
 * Resolve `$(NAME)` or `$(NAME.path)` against the variable map. Two strategies:
 *   1. Flat-key match (full ref including dots). Handles `targetname.output`.
 *   2. Dot-path traversal — split, descend.
 * Returns `undefined` when unresolved.
 */
export function resolveRef(ref: string, vars: Map<string, unknown>): unknown {
  if (vars.has(ref)) return vars.get(ref);
  const path = ref.split(".");
  const root = path[0]!;
  if (!vars.has(root)) return undefined;
  let cur: unknown = vars.get(root);
  for (let i = 1; i < path.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[path[i]!];
  }
  return cur;
}

/**
 * Render a value for inline substitution. Scalars stringify naturally;
 * objects/arrays JSON-serialize. `null` renders as the literal `"null"` so
 * authors can distinguish bound-to-null from unresolved.
 */
export function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return JSON.stringify(v);
}

const TRUTHY = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*$/;
const EQ = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*(==|!=)\s*"([^"]*)"\s*$/;
const IN = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s+(not\s+)?in\s+\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\)\s*$/;

export function evalCondition(cond: string, vars: Map<string, unknown>): boolean {
  const t = TRUTHY.exec(cond);
  if (t) {
    const val = resolveRef(t[1]!, vars);
    const filter = t[2];
    const filtered = filter && val !== undefined ? applyFilter(stringifyValue(val), filter) : val;
    return isTruthy(filtered);
  }
  const e = EQ.exec(cond);
  if (e) {
    const [, ref, filter, op, lit] = e;
    const val = resolveRef(ref!, vars);
    const valStr = val === undefined ? "" : stringifyValue(val);
    // Filter applies BEFORE comparison so `if $(COLOR|trim) == "yellow"` matches
    // values that local models return with trailing whitespace.
    const final = filter !== undefined ? applyFilter(valStr, filter) : valStr;
    return op === "==" ? final === lit : final !== lit;
  }
  const i = IN.exec(cond);
  if (i) {
    const [, lhsRef, lhsFilter, notKey, rhsRef] = i;
    const rhsVal = resolveRef(rhsRef!, vars);
    if (rhsVal === undefined) {
      throw new Error(`Runtime error in \`in\` condition: RHS \`$(${rhsRef})\` is unresolved`);
    }
    if (!Array.isArray(rhsVal)) {
      const got = rhsVal === null ? "null" : typeof rhsVal;
      throw new Error(`Runtime error in \`in\` condition: RHS \`$(${rhsRef})\` must be an array (got ${got})`);
    }
    const lhsVal = resolveRef(lhsRef!, vars);
    if (lhsVal === undefined) return false;
    const lhsStr = lhsFilter !== undefined
      ? applyFilter(stringifyValue(lhsVal), lhsFilter)
      : stringifyValue(lhsVal);
    const found = rhsVal.some((item) => stringifyValue(item) === lhsStr);
    return notKey !== undefined ? !found : found;
  }
  throw new Error(`Invalid runtime condition (parser should have rejected): ${cond}`);
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
