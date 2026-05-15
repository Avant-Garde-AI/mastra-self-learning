// =============================================================================
// @avant-garde/mastra-self-learning
//
// Self-learning extension for Mastra — closed learning loops, autonomous skill
// extraction, and layered memory inspired by Hermes Agent.
// =============================================================================

// --- Config ---
export {
  type SelfLearningConfig,
  type ExtractionPolicy,
  type SkillRouterConfig,
  type FactLayerConfig,
  type IdentityLayerConfig,
  type Identity,
  type TrustTier,
  SelfLearningConfigSchema,
  ExtractionPolicySchema,
  SkillRouterConfigSchema,
  FactLayerConfigSchema,
  IdentityLayerConfigSchema,
  IdentitySchema,
  DEFAULT_CONFIG,
} from './config.js';

// --- Processors (primary integration point) ---
export {
  createSelfLearningProcessor,
  createSkillContextProcessor,
  type SelfLearningProcessorOptions,
  type SkillContextProcessorOptions,
} from './processors/index.js';

// --- Tools ---
export { createSelfLearningTools, type SelfLearningToolsOptions } from './tools/index.js';

// --- Skills ---
export {
  parseSkillDocument,
  serializeSkillDocument,
  extractSection,
  SkillStorageExtension,
  SkillRouter,
  SkillExtractor,
  SkillRefiner,
  SkillSearch,
  scanSkillContent,
  type SkillRecord,
  type SkillFrontmatter,
  type SkillVersionRecord,
  type SkillUsageRecord,
  type SkillSearchOptions,
  type SkillSearchResult,
  type RefinementSignals,
  type ExtractionResult,
  type TaskTrajectory,
  type ScanResult,
  type ScanFinding,
  type SkillStorageExtensionOptions,
} from './skills/index.js';

// --- Memory ---
export { FactLayer, IdentityLayer, type FactEntry } from './memory/index.js';

// --- Harness ---
export {
  createSelfLearningMode,
  createHarnessTools,
  type SelfLearningModeOptions,
} from './harness/index.js';

// --- Workflows ---
export {
  createGardeningWorkflows,
  type GardeningWorkflowOptions,
} from './workflows/index.js';

// --- Evals ---
export {
  skillUtilizationScorer,
  skillQualityScorer,
  identityDriftScorer,
} from './evals/index.js';
