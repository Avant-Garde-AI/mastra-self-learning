import type { SkillRouterConfig } from '../config.js';
import type { SkillRecord } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';
import { extractSection, parseSkillDocument } from './parser.js';
import { defaultEstimator, type TokenEstimator } from './token-budget.js';

/**
 * Manages token-aware progressive disclosure of skills.
 *
 * Three-level loading model:
 *   - **L0 (Index)**: All skill names + descriptions (~50 tokens/skill)
 *   - **L1 (Full)**: Complete SKILL.md body for one skill (200–2000 tokens)
 *   - **L2 (Section)**: A specific section like "Procedure" or "Pitfalls" (50–500 tokens)
 *
 * The router enforces budgets to prevent skills from starving the active
 * conversation. It maintains a per-agent ~30s cache for `buildIndex()` (which
 * the input processor hits on every request); callers invalidate via
 * `invalidate()` after any write that affects the index.
 *
 * @see docs/03-skill-system.md
 */
export class SkillRouter {
  private readonly estimator: TokenEstimator;
  private indexCache: { value: string; expiresAt: number } | null = null;
  private warnedRelevantFallback = false;

  /**
   * @param storage  Storage backend.
   * @param config   Token budgets and overflow strategy.
   * @param agentId  Owning agent. If undefined, lists global + null-author skills.
   *                 If null, lists only global skills.
   * @param estimator Optional token estimator. Defaults to the heuristic in
   *                  `token-budget.ts`. Swap in a real tokenizer when accuracy matters.
   * @param cacheTtlMs Cache TTL for `buildIndex()`. Defaults to 30 seconds.
   *                   Set to 0 to disable caching.
   */
  constructor(
    private storage: SkillStorageExtension,
    private config: SkillRouterConfig,
    public readonly agentId: string | null | undefined = undefined,
    estimator?: TokenEstimator,
    private cacheTtlMs: number = 30_000,
  ) {
    this.estimator = estimator ?? defaultEstimator;
  }

  /**
   * Build the L0 index string for system-prompt injection.
   *
   * Behavior:
   *   - Empty library → returns a stable "(none yet)" sentinel string so the
   *     LLM sees consistent prompt shape across runs (cache-friendly).
   *   - Over `indexBudget` → applies `overflowStrategy`. `relevant` falls back
   *     to `recent` in MVP (Phase 4 wires up embeddings).
   *   - Result is cached for `cacheTtlMs` milliseconds.
   */
  async buildIndex(): Promise<string> {
    const now = Date.now();
    if (this.indexCache && this.indexCache.expiresAt > now) {
      return this.indexCache.value;
    }

    // Pull a comfortably-large window; we'll trim against budget.
    const skills = await this.storage.listSkills({
      agentId: this.agentId === undefined ? undefined : this.agentId,
      status: 'active',
      limit: 200,
    });

    const value = this.formatIndex(skills);
    if (this.cacheTtlMs > 0) {
      this.indexCache = { value, expiresAt: now + this.cacheTtlMs };
    }
    return value;
  }

  /**
   * Load a skill at L1 (full content) or L2 (specific section).
   * Returns `null` if skill or section is not found.
   *
   * We do NOT enforce `activeBudget` here — that's a post-condition checked
   * by `SkillContextProcessor` after assembling the full system prompt.
   * Truncating individual skills would corrupt the agent's understanding
   * of the procedure.
   */
  async loadSkill(name: string, section?: string): Promise<string | null> {
    const lookupAgentId = this.agentId ?? undefined;
    const skill = await this.storage.getSkillByName(name, lookupAgentId);
    if (!skill) return null;

    if (section) {
      // Parse the body, then extract the section.
      const { body } = parseSkillDocument(skill.content);
      return extractSection(body, section);
    }
    return skill.content;
  }

  /**
   * Phase 4 — semantic suggestion. MVP throws.
   */
  async suggestSkills(_message: string, _limit?: number): Promise<SkillRecord[]> {
    throw new Error(
      'SkillRouter.suggestSkills is a Phase 4 feature (requires embedding model). ' +
        'Use skill_search (FTS) via createSelfLearningTools instead.',
    );
  }

  /**
   * Drop the cached index. Call after `createSkill` / `updateSkill` / status
   * changes so subsequent `buildIndex()` calls see the new state.
   */
  invalidate(): void {
    this.indexCache = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private formatIndex(skills: SkillRecord[]): string {
    const header = '# Available Skills';
    if (skills.length === 0) {
      return `${header}\n\n(none yet)`;
    }

    const lines = skills.map((s) => `- ${s.name}: ${this.descriptionFor(s)}`);

    // Estimate tokens including header + blank line separators.
    const candidate = `${header}\n\n${lines.join('\n')}`;
    const candidateTokens = this.estimator(candidate);
    if (candidateTokens <= this.config.indexBudget) {
      return candidate;
    }

    // Apply overflow strategy.
    const strategy = this.config.overflowStrategy;
    const sorted = this.applyOverflowSort(skills, strategy);
    return this.trimToBudget(header, sorted);
  }

  private descriptionFor(skill: SkillRecord): string {
    const desc = skill.frontmatter.description?.trim();
    if (desc) return desc;
    // Fall back to first non-empty line of body.
    try {
      const { body } = parseSkillDocument(skill.content);
      const firstLine = body.split('\n').find((l) => l.trim().length > 0)?.trim();
      return firstLine ?? '(no description)';
    } catch {
      return '(no description)';
    }
  }

  private applyOverflowSort(
    skills: SkillRecord[],
    strategy: SkillRouterConfig['overflowStrategy'],
  ): SkillRecord[] {
    if (strategy === 'relevant') {
      // MVP fallback — log once per process per router instance.
      if (!this.warnedRelevantFallback) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] overflowStrategy="relevant" requires semantic search ' +
            '(Phase 4). Falling back to "recent" for now.',
        );
        this.warnedRelevantFallback = true;
      }
      return this.sortByRecent(skills);
    }
    if (strategy === 'frequent') {
      return this.sortByFrequent(skills);
    }
    // 'recent' (default)
    return this.sortByRecent(skills);
  }

  private sortByRecent(skills: SkillRecord[]): SkillRecord[] {
    return [...skills].sort((a, b) => {
      const aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  private sortByFrequent(skills: SkillRecord[]): SkillRecord[] {
    return [...skills].sort((a, b) => {
      const aNet = a.successCount - a.failCount;
      const bNet = b.successCount - b.failCount;
      return bNet - aNet;
    });
  }

  /**
   * Greedy trim: header + as many sorted skills as fit in `indexBudget`.
   * Tail items are dropped. If even the header alone exceeds the budget, the
   * header is returned anyway (LLMs handle a tiny overflow gracefully).
   */
  private trimToBudget(header: string, sorted: SkillRecord[]): string {
    const headerTokens = this.estimator(`${header}\n\n`);
    let usedTokens = headerTokens;
    const kept: string[] = [];

    for (const s of sorted) {
      const line = `- ${s.name}: ${this.descriptionFor(s)}`;
      const lineTokens = this.estimator(`${line}\n`);
      if (usedTokens + lineTokens > this.config.indexBudget) {
        // Stop — we'd overflow with this skill. Subsequent (less-prioritized)
        // skills are dropped too.
        break;
      }
      usedTokens += lineTokens;
      kept.push(line);
    }

    if (kept.length === 0) {
      // Budget can't fit even one skill. Return header + "(none fit budget)" so
      // the agent has visible feedback rather than a silent empty list.
      return `${header}\n\n(${sorted.length} skill${sorted.length === 1 ? '' : 's'} omitted: index budget exceeded)`;
    }
    const truncatedSuffix =
      kept.length < sorted.length
        ? `\n\n(${sorted.length - kept.length} additional skill${sorted.length - kept.length === 1 ? '' : 's'} omitted: index budget reached)`
        : '';
    return `${header}\n\n${kept.join('\n')}${truncatedSuffix}`;
  }
}
