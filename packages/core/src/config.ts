import { z } from 'zod';

// ---------------------------------------------------------------------------
// Extraction Policy — controls when the learning loop fires
// ---------------------------------------------------------------------------

export const ExtractionPolicySchema = z.object({
  /** Minimum tool calls in the completed task to qualify for extraction */
  minToolCalls: z.number().int().min(1).default(5),
  /** Minimum conversational turns in the task */
  minTurns: z.number().int().min(1).default(3),
  /** Require the task to end with a positive user signal */
  requirePositiveOutcome: z.boolean().default(true),
  /** Cooldown between extractions in milliseconds */
  cooldownMs: z.number().int().min(0).default(300_000),
  /** Cosine similarity threshold for deduplication against existing skills */
  deduplicationThreshold: z.number().min(0).max(1).default(0.85),
  /** Whether to gate extraction behind user/admin approval */
  requireApproval: z.boolean().default(false),
  /** Use an LLM call to assess whether the task is generalizable */
  useGeneralizabilityCheck: z.boolean().default(true),
});

export type ExtractionPolicy = z.infer<typeof ExtractionPolicySchema>;

// ---------------------------------------------------------------------------
// Skill Router — controls token budgets and progressive disclosure
// ---------------------------------------------------------------------------

export const SkillRouterConfigSchema = z.object({
  /** Max tokens for the L0 skill index in system prompt */
  indexBudget: z.number().int().min(1).default(3000),
  /** Max tokens for actively loaded skills per turn */
  activeBudget: z.number().int().min(1).default(8000),
  /** Max simultaneously loaded L1 skills */
  maxActiveSkills: z.number().int().min(1).default(3),
  /** Whether to auto-inject L0 index into the system prompt */
  autoInjectIndex: z.boolean().default(true),
  /** Strategy when L0 index exceeds budget */
  overflowStrategy: z.enum(['recent', 'frequent', 'relevant']).default('relevant'),
});

export type SkillRouterConfig = z.infer<typeof SkillRouterConfigSchema>;

// ---------------------------------------------------------------------------
// Fact Layer — cross-thread persistent facts
// ---------------------------------------------------------------------------

export const FactLayerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Nudge the agent to persist facts every N turns */
  nudgeInterval: z.number().int().min(1).default(10),
  /** Maximum number of facts stored */
  maxFacts: z.number().int().min(1).default(500),
  /** Confidence decay rate per week (0-1) */
  decayRate: z.number().min(0).max(1).default(0.05),
});

export type FactLayerConfig = z.infer<typeof FactLayerConfigSchema>;

// ---------------------------------------------------------------------------
// Identity Layer — prevents tone/personality drift
// ---------------------------------------------------------------------------

export const IdentityLayerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Alert if identity drifts more than this threshold (0-1) */
  driftThreshold: z.number().min(0).max(1).default(0.3),
});

export type IdentityLayerConfig = z.infer<typeof IdentityLayerConfigSchema>;

// ---------------------------------------------------------------------------
// Identity definition
// ---------------------------------------------------------------------------

export const IdentitySchema = z.object({
  /** Core personality traits and communication style */
  personality: z.string(),
  /** Domain expertise areas */
  expertise: z.array(z.string()).default([]),
  /** Response formatting preferences */
  formatting: z
    .object({
      defaultLength: z.enum(['concise', 'standard', 'detailed']).default('standard'),
      codeStyle: z.enum(['minimal-comments', 'documented', 'tutorial']).default('documented'),
      listPreference: z.enum(['bullets', 'numbered', 'prose']).default('bullets'),
    })
    .default({}),
  /** Behavioral guardrails */
  guardrails: z.array(z.string()).default([]),
});

export type Identity = z.infer<typeof IdentitySchema>;

// ---------------------------------------------------------------------------
// Trust tiers
// ---------------------------------------------------------------------------

export const TrustTier = z.enum(['builtin', 'official', 'community', 'agent-created']);
export type TrustTier = z.infer<typeof TrustTier>;

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export const SelfLearningConfigSchema = z.object({
  /** Mastra storage instance — reuse your existing storage backend */
  // storage is passed as a runtime value, not validated by zod
  /** Model ID for auxiliary LLM calls (extraction, refinement, scanning) */
  auxiliaryModel: z.string().default('anthropic/claude-sonnet-4-20250514'),
  /** Model ID for embedding (semantic skill search) */
  embeddingModel: z.string().optional(),
  /** Embedding vector dimensions. Must match the embedder. Default 1536 (text-embedding-3-small). */
  embeddingDimensions: z.number().int().positive().default(1536),
  /** Hybrid search blend weight on the semantic component (0..1). Default 0.7. */
  semanticWeight: z.number().min(0).max(1).default(0.7),

  extraction: ExtractionPolicySchema.default({}),
  router: SkillRouterConfigSchema.default({}),
  factLayer: FactLayerConfigSchema.default({}),
  identityLayer: IdentityLayerConfigSchema.default({}),
  identity: IdentitySchema.optional(),
});

export type SelfLearningConfig = z.infer<typeof SelfLearningConfigSchema>;

/** Sensible defaults for all config values */
export const DEFAULT_CONFIG: SelfLearningConfig = SelfLearningConfigSchema.parse({});
