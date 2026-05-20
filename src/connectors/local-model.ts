import type { LocalModel, Capabilities } from "./types.js";

/**
 * Ollama HTTP client. Wraps `POST /api/generate` with the registered model
 * names from the registry instance. The bundled-default registry wires
 * `default` / `gemma2` to `gemma2:9b` and `qwen` to `qwen2.5:7b`, matching
 * the v1 spec.
 *
 * Configuration:
 *   - `baseUrl` — Ollama endpoint, defaults to `http://localhost:11434`.
 *   - `defaultModelTag` — the Ollama model tag this instance dispatches to
 *     (e.g. `gemma2:9b`).
 *   - `timeoutMs` — per-call timeout. Default 60s. v1 runtime supports
 *     per-op overrides via the `# Timeout:` header (T5 thread).
 */
export interface OllamaConfig {
  baseUrl?: string;
  defaultModelTag: string;
  timeoutMs?: number;
}

export class OllamaLocalModel implements LocalModel {
  private readonly baseUrl: string;
  private readonly defaultModelTag: string;
  private readonly timeoutMs: number;

  constructor(config: OllamaConfig) {
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.defaultModelTag = config.defaultModelTag;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async run(prompt: string, opts: { maxTokens?: number; model?: string }): Promise<string> {
    // `model` here is the registered name (e.g. `default`, `gemma2`, `qwen`)
    // — but Ollama needs the underlying model tag. The registry resolves
    // the name to this instance before calling us, so we use our own
    // `defaultModelTag`. The `model` param is informational here.
    const body: Record<string, unknown> = {
      model: this.defaultModelTag,
      prompt,
      stream: false,
    };
    if (opts.maxTokens !== undefined) {
      body["options"] = { num_predict: opts.maxTokens };
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Ollama HTTP ${resp.status}: ${text || resp.statusText}`);
      }
      const data = (await resp.json()) as { response?: string };
      return data.response ?? "";
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new Error(`Ollama call timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  capabilities(): Capabilities {
    return {
      kind: "ollama",
      modelTag: this.defaultModelTag,
      baseUrl: this.baseUrl,
    };
  }
}
