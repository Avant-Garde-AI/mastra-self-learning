import type { SkillRouterConfig } from '../config.js';
import type { SkillRecord } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';

/**
 * Manages token-aware progressive disclosure of skills.
 *
 * Three-level loading model:
 * - L0 (Index): All skill names + descriptions (~50 tokens/skill)
 * - L1 (Full): Complete SKILL.md body for one skill (200-2000 tokens)
 * - L2 (Reference): Specific section or supporting file (50-500 tokens)
 *
 * The router enforces token budgets to prevent skills from
 * starving Observational Memory or the active conversation.
 *
 * @see docs/03-skill-system.md for progressive disclosure details
 */
export class SkillRouter {
  constructor(
    private storage: SkillStorageExtension,
    private config: SkillRouterConfig,
  ) {}

  /**
   * Build the L0 index string for injection into the system prompt.
   * Respects indexBudget and applies overflowStrategy when needed.
   */
  async buildIndex(agentId?: string): Promise<string> {
    // TODO: Phase 1
    // 1. List all active skills for this agent
    // 2. Format as "- skill_name: description" per line
    // 3. Estimate token count
    // 4. If over budget, apply overflow strategy (recent/frequent/relevant)
    // 5. Return the index string
    throw new Error('Not implemented — Phase 1');
  }

  /**
   * Load a skill at L1 (full content) or L2 (specific section).
   */
  async loadSkill(name: string, section?: string): Promise<string | null> {
    // TODO: Phase 1
    // 1. Fetch skill by name
    // 2. If section specified, extract just that section (L2)
    // 3. Otherwise return full body (L1)
    // 4. Check against activeBudget
    throw new Error('Not implemented — Phase 1');
  }

  /**
   * Given a user message, proactively suggest relevant skills.
   * Used for semantic matching when the user's intent maps to an existing skill.
   */
  async suggestSkills(message: string, limit?: number): Promise<SkillRecord[]> {
    // TODO: Phase 4 (requires embedding model)
    throw new Error('Not implemented — Phase 4');
  }
}
