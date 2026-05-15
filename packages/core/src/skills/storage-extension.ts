import type { SkillRecord, SkillVersionRecord, SkillUsageRecord, SkillSearchOptions, SkillSearchResult } from './types.js';
import type { TrustTier } from '../config.js';

/**
 * Options for extending Mastra's built-in SkillsStorage domain
 * with learning-loop metadata.
 */
export interface SkillStorageExtensionOptions {
  /** Track usage metrics (success_count, fail_count, last_used) */
  trackUsage?: boolean;
  /** Track version history with diffs */
  trackVersions?: boolean;
  /** Track trust tiers and approval state */
  trackTrust?: boolean;
  /** Track extraction provenance (which thread/agent created the skill) */
  trackExtraction?: boolean;
}

/**
 * Extended skill storage that layers learning-loop metadata
 * on top of Mastra's existing SkillsStorage domain.
 *
 * Mastra already provides:
 * - Skill CRUD with versioning
 * - Draft → publish workflow via BlobStore
 * - Storage backends (Postgres, LibSQL, MongoDB)
 * - Studio UI integration
 *
 * We add:
 * - Usage tracking (success/fail counts, duration, tool calls)
 * - Trust tiers with approval gates
 * - Extraction provenance (which thread/agent created a skill)
 * - Semantic search via embeddings
 * - Version diffs for refinement history
 *
 * @see docs/03-skill-system.md for full architecture
 */
export class SkillStorageExtension {
  // TODO: Accept MastraStorage instance and extend the skills domain
  // with additional tables/columns for learning-loop metadata.
  //
  // Implementation will depend on the exact MastraStorage interface
  // for the skills domain, which we need to inspect from @mastra/core
  // source during Phase 1.

  constructor(
    private storage: unknown, // MastraStorage — typed properly once we import @mastra/core
    private options: SkillStorageExtensionOptions = {},
  ) {}

  // --- Skill CRUD (delegates to Mastra's SkillsStorage + adds metadata) ---

  async createSkill(skill: Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<SkillRecord> {
    throw new Error('Not implemented — Phase 1');
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    throw new Error('Not implemented — Phase 1');
  }

  async getSkillByName(name: string, agentId?: string): Promise<SkillRecord | null> {
    throw new Error('Not implemented — Phase 1');
  }

  async updateSkill(id: string, updates: Partial<SkillRecord>): Promise<SkillRecord> {
    throw new Error('Not implemented — Phase 1');
  }

  async listSkills(options?: {
    agentId?: string;
    trustTiers?: TrustTier[];
    status?: SkillRecord['status'];
    limit?: number;
    offset?: number;
  }): Promise<SkillRecord[]> {
    throw new Error('Not implemented — Phase 1');
  }

  // --- Version history ---

  async createVersion(version: Omit<SkillVersionRecord, 'id' | 'createdAt'>): Promise<SkillVersionRecord> {
    throw new Error('Not implemented — Phase 2');
  }

  async listVersions(skillId: string): Promise<SkillVersionRecord[]> {
    throw new Error('Not implemented — Phase 2');
  }

  // --- Usage tracking ---

  async recordUsage(usage: Omit<SkillUsageRecord, 'id' | 'createdAt'>): Promise<SkillUsageRecord> {
    throw new Error('Not implemented — Phase 2');
  }

  async getUsageStats(skillId: string): Promise<{
    totalUses: number;
    successRate: number;
    avgDurationMs: number;
    avgToolCalls: number;
  }> {
    throw new Error('Not implemented — Phase 2');
  }

  // --- Search ---

  async search(options: SkillSearchOptions): Promise<SkillSearchResult[]> {
    throw new Error('Not implemented — Phase 1');
  }

  // --- Schema management ---

  /**
   * Ensure the extended schema exists in the storage backend.
   * Called on first use — creates tables/columns if they don't exist.
   */
  async ensureSchema(): Promise<void> {
    throw new Error('Not implemented — Phase 1');
  }
}
