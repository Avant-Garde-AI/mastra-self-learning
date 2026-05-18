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
  observeChunk,
  readState,
  detectPositiveOutcome,
  detectUserCorrection,
  buildTrajectory,
  buildRefinementSignals,
  type SelfLearningProcessorOptions,
  type SkillContextProcessorOptions,
  type SelfLearningProcessor,
  type ProcessOutputStreamArgsLike,
  type ProcessOutputResultArgsLike,
  type SelfLearningState,
  type SkillContextProcessor,
  type ProcessInputArgsLike,
  makeSafeEmitter,
  type SelfLearningEvent,
  type SelfLearningEventType,
  type SelfLearningEventHandler,
} from './processors/index.js';

// --- Tools ---
export { createSelfLearningTools, type SelfLearningToolsOptions } from './tools/index.js';

// --- Skills ---
export {
  parseSkillDocument,
  serializeSkillDocument,
  extractSection,
  SkillParseError,
  SkillStorageExtension,
  SkillNameConflictError,
  SkillRouter,
  SkillExtractor,
  distinctToolCallCount,
  AuxiliaryLLMNotConfiguredError,
  SkillRefiner,
  signalsActive,
  buildRefinementPrompt,
  describeSignals,
  SkillSearch,
  scanSkillContent,
  serializeTrajectoryForPrompt,
  buildSynthesisPrompt,
  buildGeneralizabilityPrompt,
  normalizeSynthesisOutput,
  bumpPatch,
  bumpMinor,
  bumpMajor,
  unifiedDiff,
  estimateTokens,
  heuristicEstimator,
  makeSafeEmbedder,
  cosineSim,
  toVectorLiteral,
  openAIEmbedder,
  hashEmbedder,
  EmbeddingDimensionError,
  type EmbedText,
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
  type MastraPostgresLike,
  type MastraTxClient,
  type AuxiliaryGenerate,
  type AuxiliaryGenerateOptions,
  type TokenEstimator,
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
