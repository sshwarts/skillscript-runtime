// `skillscript-runtime/testing` entry point. ContractConformance suites for
// the four connector contracts. Imported by impl authors writing conformance
// tests against their substrate; not part of the runtime hot path.

export {
  SkillStoreConformance,
  DataStoreConformance,
  LocalModelConformance,
  McpConnectorConformance,
  AgentConnectorConformance,
} from "./conformance.js";

export type {
  ConformanceTest,
  ConformanceCategory,
  SkillStoreFixture,
  DataStoreFixture,
  LocalModelFixture,
  McpConnectorFixture,
  AgentConnectorFixture,
} from "./conformance.js";
