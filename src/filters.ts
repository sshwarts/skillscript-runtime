// Pipe-filter implementations. `$(NAME|filter)` syntax dispatches here.

/** The names of every registered filter. Lint's `unknown-filter` rule consults this. */
export const KNOWN_FILTERS = ["url", "shell", "json", "json_parse", "trim", "length"] as const;
export type KnownFilter = (typeof KNOWN_FILTERS)[number];
//
// Adding a new filter:
//   1. Add a case in `applyFilter` below.
//   2. Document it in `docs/LANGUAGE_REFERENCE.md` under the pipe-filter section.
//   3. Lint rule `unknown-filter` already covers compile-time validation —
//      unknown filter names on resolved values throw, so authors discover typos
//      at compile time without runtime surprise.
//
// All filters operate on strings. The caller (parser at compile time, runtime
// substituter at execution time) stringifies the underlying value first.

/**
 * Apply a named pipe filter to a string value. Filters supported in v1:
 *
 *   url    — `encodeURIComponent`. For URL path or query embedding.
 *   shell  — POSIX single-quote shell-escape. Wraps in outer quotes; don't add your own.
 *   json   — `JSON.stringify`. Produces a quoted JSON string literal.
 *   trim   — strip leading/trailing whitespace. Useful on local-model outputs that
 *            often append a trailing newline that breaks `==` equality checks.
 *   length — count of items (if the value JSON-parses as an array) or characters
 *            (otherwise). Read-only projection — pairs with v0.2.5's numeric
 *            comparison operators for skills like `if $(ITEMS|length) > "0":`.
 *
 * Unknown filter names throw — typos are caught at compile time when the value
 * is already resolved, or at runtime for ambient refs.
 */
export function applyFilter(value: string, filter: string): string {
  switch (filter) {
    case "url":
      return encodeURIComponent(value);
    case "shell":
      return `'${value.replace(/'/g, "'\\''")}'`;
    case "json":
      return JSON.stringify(value);
    case "json_parse": {
      // v0.3.2: sibling to `|json` (stringify). Parses the input as JSON and
      // re-stringifies — round-trip for valid JSON, throws for malformed.
      // Useful chain with `|length` for array counting + as a validation gate
      // before downstream string ops. Field-access on parsed structures is a
      // separate concern (parsed value isn't propagated through string-in/
      // string-out filter signature). See $ json_parse intercept (deferred).
      try {
        const parsed = JSON.parse(value) as unknown;
        return JSON.stringify(parsed);
      } catch (err) {
        throw new Error(
          `\`|json_parse\` filter: input is not valid JSON. Got: '${value.slice(0, 40)}${value.length > 40 ? "..." : ""}' — ${(err as Error).message}`,
        );
      }
    }
    case "trim":
      return value.trim();
    case "length": {
      // Array-shaped JSON → element count. Anything else (including
      // JSON-parsed-but-not-array, or non-JSON strings) → character count.
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) return String(parsed.length);
      } catch {
        /* not JSON — fall through to string-length semantics */
      }
      return String(value.length);
    }
    default:
      throw new Error(`Unknown filter '${filter}' — supported: url, shell, json, json_parse, trim, length`);
  }
}
