import type {
  SkillStore,
  MemoryStore,
  LocalModel,
  McpConnector,
} from "./types.js";

/**
 * Per-kind registries map a connector name to an instance. Three-layer
 * resolution applies at dispatch sites: per-call override > skill-declared >
 * primary default. The `primary` name is the fallback when callers don't
 * specify (matches the parser's bare-name handling).
 */
export class Registry {
  private skillStores = new Map<string, SkillStore>();
  private memoryStores = new Map<string, MemoryStore>();
  private localModels = new Map<string, LocalModel>();
  private mcpConnectors = new Map<string, McpConnector>();

  registerSkillStore(name: string, instance: SkillStore): void {
    this.skillStores.set(name, instance);
  }

  registerMemoryStore(name: string, instance: MemoryStore): void {
    this.memoryStores.set(name, instance);
  }

  registerLocalModel(name: string, instance: LocalModel): void {
    this.localModels.set(name, instance);
  }

  registerMcpConnector(name: string, instance: McpConnector): void {
    this.mcpConnectors.set(name, instance);
  }

  getSkillStore(name: string = "primary"): SkillStore {
    const store = this.skillStores.get(name);
    if (store === undefined) {
      throw new Error(
        `SkillStore '${name}' not registered. Registered: ${Array.from(this.skillStores.keys()).join(", ") || "(none)"}.`,
      );
    }
    return store;
  }

  getMemoryStore(name: string = "primary"): MemoryStore {
    const store = this.memoryStores.get(name);
    if (store === undefined) {
      throw new Error(
        `MemoryStore '${name}' not registered. Registered: ${Array.from(this.memoryStores.keys()).join(", ") || "(none)"}.`,
      );
    }
    return store;
  }

  getLocalModel(name: string = "default"): LocalModel {
    const model = this.localModels.get(name);
    if (model === undefined) {
      throw new Error(
        `LocalModel '${name}' not registered. Registered: ${Array.from(this.localModels.keys()).join(", ") || "(none)"}.`,
      );
    }
    return model;
  }

  getMcpConnector(name: string = "primary"): McpConnector {
    const connector = this.mcpConnectors.get(name);
    if (connector === undefined) {
      throw new Error(
        `McpConnector '${name}' not registered. Registered: ${Array.from(this.mcpConnectors.keys()).join(", ") || "(none)"}.`,
      );
    }
    return connector;
  }

  hasSkillStore(name: string = "primary"): boolean { return this.skillStores.has(name); }
  hasMemoryStore(name: string = "primary"): boolean { return this.memoryStores.has(name); }
  hasLocalModel(name: string = "default"): boolean { return this.localModels.has(name); }
  hasMcpConnector(name: string = "primary"): boolean { return this.mcpConnectors.has(name); }
}
