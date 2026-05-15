import type { TrustTier } from '../config.js';

// ---------------------------------------------------------------------------
// Skill frontmatter — agentskills.io compatible
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  created?: string;
  updated?: string;
  author?: 'agent' | 'human' | 'hub' | string;
  trust?: TrustTier;
  tags?: string[];
  platforms?: string[];
  complexity?: number;
  metadata?: {
    mastra?: {
      agentId?: string;
      threadOrigin?: string;
      extractionTrigger?: 'auto' | 'manual' | 'scheduled';
    };
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Skill record — stored in the skills storage domain
// ---------------------------------------------------------------------------

export interface SkillRecord {
  /** Unique skill ID (ULID) */
  id: string;
  /** Skill name — unique per agent or global scope */
  name: string;
  /** Semver version string */
  version: string;
  /** Full SKILL.md markdown content (frontmatter + body) */
  content: string;
  /** Parsed frontmatter */
  frontmatter: SkillFrontmatter;
  /** Embedding vector for semantic search (optional) */
  embedding?: number[];
  /** Owning agent ID (null = global skill) */
  agentId?: string | null;
  /** Trust tier */
  trustTier: TrustTier;
  /** Lifecycle status */
  status: 'active' | 'draft' | 'deprecated' | 'archived';
  /** Number of successful uses */
  successCount: number;
  /** Number of failed uses */
  failCount: number;
  /** Last time the skill was used */
  lastUsed?: string | null;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Skill version — immutable version history
// ---------------------------------------------------------------------------

export interface SkillVersionRecord {
  id: string;
  skillId: string;
  version: string;
  content: string;
  /** Unified diff from the previous version */
  diffFromPrevious?: string | null;
  /** Human or agent description of why this version was created */
  reason: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Skill usage — per-invocation tracking
// ---------------------------------------------------------------------------

export interface SkillUsageRecord {
  id: string;
  skillId: string;
  threadId: string;
  agentId: string;
  outcome: 'success' | 'failure' | 'partial' | 'abandoned';
  /** Agent self-assessment of how the skill performed */
  feedback?: string | null;
  /** Duration of the skill-guided task in ms */
  durationMs: number;
  /** Number of tool calls during skill-guided execution */
  toolCalls: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Skill search
// ---------------------------------------------------------------------------

export interface SkillSearchOptions {
  query: string;
  mode?: 'fts' | 'semantic' | 'hybrid';
  limit?: number;
  trustTiers?: TrustTier[];
  tags?: string[];
  /** Filter skills with success rate below this threshold (0-1) */
  minSuccessRate?: number;
  agentId?: string;
}

export interface SkillSearchResult {
  skill: SkillRecord;
  score: number;
  matchType: 'fts' | 'semantic';
}

// ---------------------------------------------------------------------------
// Refinement triggers
// ---------------------------------------------------------------------------

export interface RefinementSignals {
  /** Agent deviated from the skill's prescribed procedure */
  deviation: boolean;
  /** A new pitfall was discovered during execution */
  newPitfall: boolean;
  /** A step was skipped as unnecessary */
  unnecessaryStep: boolean;
  /** User explicitly corrected the agent */
  userCorrection: boolean;
  /** Skill-guided execution failed */
  failure: boolean;
}

// ---------------------------------------------------------------------------
// Extraction result
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  /** Whether extraction was triggered */
  triggered: boolean;
  /** The created or updated skill record (if triggered) */
  skill?: SkillRecord;
  /** Reason extraction was or wasn't triggered */
  reason: string;
}
