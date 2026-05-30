// v0.7.2 — `LocalModelMcpConnector`. Bridge class that exposes a registered
// `LocalModel` instance as an `McpConnector`, so the canonical `$ llm prompt=...`
// MCP-dispatch path works in default deployments without adopter wiring.
//
// Per Perry's v0.7.2 kickoff (d284763f) + Scott's substrate-portability
// architectural decision (831c2661 thread). This bridge — together with
// `DataStoreMcpConnector` — defines the canonical MCP-dispatch contract
// for the LLM op class:
//
//   $ <connector_name> prompt="..." [maxTokens=N] [model="..."] -> R
//
// where R is a string (the model's response text). Adopters who wire
// LocalModel-interface impls (Ollama is bundled; custom remote-LLM /
// OpenAI-compat / Anthropic-compat impls all work) get this dispatch
// path for free. Adopters with fundamentally different LLM surfaces
// (chat-with-tool-use, structured outputs, etc.) wire under their own
// connector name; this bridge is the canonical "prompt-in, text-out"
// contract only.
//
// Wiring: auto-registered at bootstrap as connector instance "llm"
// pointing at the "default" LocalModel registration. Adopters override
// by re-registering "llm" with their own bridge instance OR a different
// MCP connector entirely.

import type {
  McpConnector,
  McpDispatchCtx,
  McpConnectorCapabilities,
  ManifestInfo,
  LocalModel,
} from "./types.js";

const CONTRACT_VERSION = "1.0.0";

export class LocalModelMcpConnector implements McpConnector {
  static staticCapabilities(): McpConnectorCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "LocalModelMcpConnector",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_identity_propagation: false,
        supports_streaming_responses: false,
        supports_batch: false,
      },
    };
  }

  /**
   * v0.9.1 — declared tool surface. The bridge dispatches a single
   * canonical entry point: the `prompt` tool, taking a `prompt` kwarg.
   * Bare-form `$ llm prompt=...` name-matches and bypasses this surface;
   * qualified `$ llm.prompt prompt=...` validates against this list.
   * Qualified `$ llm.tweet_post ...` etc. fails lint with `unknown-tool-on-connector`.
   */
  static staticTools(): string[] {
    return ["prompt"];
  }

  constructor(private readonly localModel: LocalModel) {}

  async call(
    _toolName: string,
    args: Record<string, unknown>,
    _ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown> {
    const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
    if (prompt === "") {
      throw new Error("LocalModelMcpConnector: `prompt` kwarg is required and must be a non-empty string.");
    }
    const opts: { maxTokens?: number; model?: string } = {};
    const rawMaxTokens = args["maxTokens"];
    if (typeof rawMaxTokens === "number" && rawMaxTokens > 0) {
      opts.maxTokens = rawMaxTokens;
    } else if (typeof rawMaxTokens === "string") {
      const n = parseInt(rawMaxTokens, 10);
      if (Number.isFinite(n) && n > 0) opts.maxTokens = n;
    }
    const rawModel = args["model"];
    if (typeof rawModel === "string" && rawModel !== "") opts.model = rawModel;
    return this.localModel.run(prompt, opts);
  }

  async manifest(): Promise<ManifestInfo<"mcp_connector">> {
    const lmManifest = await this.localModel.manifest();
    return {
      capabilities_version: "1",
      manifest: {
        kind: "local-model-bridge",
        wraps: lmManifest.manifest ?? {},
      },
    };
  }
}
