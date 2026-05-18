import type { ExtractionPolicy } from '../config.js';
import type { ExtractionResult } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';
import { parseSkillDocument, SkillParseError } from './parser.js';
import { scanSkillContent } from './scanner.js';
import { SkillSearch } from './search.js';
import {
  type AuxiliaryGenerate,
  AuxiliaryLLMNotConfiguredError,
} from './auxiliary-llm.js';
import {
  buildGeneralizabilityPrompt,
  buildSynthesisPrompt,
  normalizeSynthesisOutput,
} from './synthesis-prompt.js';

/**
 * Accumulated state from the output processor that tracks
 * the agent's execution trajectory during a task.
 */
export interface TaskTrajectory {
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    output?: unknown;
    timestamp: string;
  }>;
  turnCount: number;
  positiveOutcome: boolean;
  threadId: string;
  agentId: string;
  conversationSummary?: string;
}

/**
 * Degraded FTS dedup threshold (Postgres `ts_rank_cd` units) used ONLY when no
 * embedder is configured. The primary path is semantic cosine vs
 * `policy.deduplicationThreshold` (a real 0..1 gate). v0.2.0 / closes R7.
 */
const FTS_DEDUP_RANK_THRESHOLD = 0.05;

/**
 * Extracts reusable skill documents from completed task trajectories.
 *
 * Pipeline (each step can short-circuit with `{ triggered: false, reason }`):
 *   1. Cooldown check
 *   2. minToolCalls / minTurns / requirePositiveOutcome thresholds
 *   3. Generalizability check (auxiliary LLM call, fail-closed on parse error)
 *   4. Deduplication (FTS search; if rank > threshold, route to refiner upstream)
 *   5. Synthesis (auxiliary LLM call → SKILL.md text)
 *   6. Normalization + parse (one retry on parse failure)
 *   7. Security scan (failure routes to status='draft', does not abort)
 *   8. Storage write via SkillStorageExtension
 *
 * @see docs/04-learning-loop.md
 */
export class SkillExtractor {
  private lastExtractionTime = 0;

  /** Override for deterministic testing of cooldown logic. */
  resetCooldown(): void {
    this.lastExtractionTime = 0;
  }

  constructor(
    private storage: SkillStorageExtension,
    private search: SkillSearch,
    private policy: ExtractionPolicy,
    private generate?: AuxiliaryGenerate,
  ) {}

  async evaluate(trajectory: TaskTrajectory): Promise<ExtractionResult> {
    // 1. Cooldown
    const now = Date.now();
    if (now - this.lastExtractionTime < this.policy.cooldownMs) {
      return { triggered: false, reason: 'cooldown active' };
    }

    // 2. Threshold gates
    const distinctTools = distinctToolCallCount(trajectory);
    if (distinctTools < this.policy.minToolCalls) {
      return {
        triggered: false,
        reason: `minToolCalls not met (${distinctTools} < ${this.policy.minToolCalls})`,
      };
    }
    if (trajectory.turnCount < this.policy.minTurns) {
      return {
        triggered: false,
        reason: `minTurns not met (${trajectory.turnCount} < ${this.policy.minTurns})`,
      };
    }
    if (this.policy.requirePositiveOutcome && !trajectory.positiveOutcome) {
      return {
        triggered: false,
        reason: 'positiveOutcome required and absent',
      };
    }

    // 3. Generalizability check (LLM gate before the heavier synthesis).
    if (this.policy.useGeneralizabilityCheck) {
      if (!this.generate) throw new AuxiliaryLLMNotConfiguredError();
      const isGeneralizable = await this.checkGeneralizability(trajectory);
      if (!isGeneralizable) {
        return { triggered: false, reason: 'generalizability check failed' };
      }
    }

    // 4–5. Synthesize + normalize + parse.
    if (!this.generate) throw new AuxiliaryLLMNotConfiguredError();
    let synthesized: string;
    try {
      synthesized = await this.synthesize(trajectory);
    } catch (err) {
      return {
        triggered: false,
        reason: `synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 6. Deduplication on the SYNTHESIZED content (closes R7). v0.1.0 deduped
    //    on the raw trajectory, which lives in a different token/semantic
    //    space than the abstracted skill body — so near-duplicates slipped
    //    through. Comparing synthesized-skill ↔ existing-skill embeddings is
    //    like-with-like and reliable. Costs one synthesis for an eventual
    //    duplicate; correctness over the saved call (and the matched skill is
    //    needed to route to refinement anyway).
    const dupe = await this.findDuplicate(trajectory, synthesized);
    if (dupe) {
      return {
        triggered: false,
        reason: `duplicate of skill "${dupe.name}" (${dupe.matchType} ${dupe.score.toFixed(3)})`,
        skill: dupe.skill,
      };
    }

    // 7. Security scan
    const scan = scanSkillContent(synthesized);
    const status: 'active' | 'draft' = scan.safe
      ? this.policy.requireApproval
        ? 'draft'
        : 'active'
      : 'draft';

    // 8. Store
    const { frontmatter } = parseSkillDocument(synthesized);
    try {
      const skill = await this.storage.createSkill({
        name: frontmatter.name,
        version: frontmatter.version ?? '1.0.0',
        content: synthesized,
        frontmatter: {
          ...frontmatter,
          metadata: {
            ...(frontmatter.metadata ?? {}),
            mastra: {
              ...(frontmatter.metadata?.mastra ?? {}),
              agentId: trajectory.agentId,
              threadOrigin: trajectory.threadId,
              extractionTrigger: 'auto' as const,
            },
          },
        },
        trustTier: 'agent-created',
        status,
        successCount: 0,
        failCount: 0,
        agentId: trajectory.agentId ?? null,
      });
      this.lastExtractionTime = Date.now();
      return {
        triggered: true,
        reason: `extracted${scan.safe ? '' : ' as draft (scan flagged ' + scan.findings.length + ' findings)'}`,
        skill,
      };
    } catch (err) {
      return {
        triggered: false,
        reason: `storage write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async checkGeneralizability(trajectory: TaskTrajectory): Promise<boolean> {
    if (!this.generate) throw new AuxiliaryLLMNotConfiguredError();
    const prompt = buildGeneralizabilityPrompt(trajectory);
    try {
      const raw = await this.generate(prompt, { maxTokens: 8, temperature: 0 });
      return /\byes\b/i.test(raw.trim());
    } catch (err) {
      // Fail closed — if we can't tell, don't extract.
      // eslint-disable-next-line no-console
      console.warn(
        '[mastra-self-learning] generalizability check threw; treating as non-generalizable.',
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private async findDuplicate(
    trajectory: TaskTrajectory,
    synthesized: string,
  ): Promise<{
    skill: NonNullable<ExtractionResult['skill']>;
    score: number;
    name: string;
    matchType: 'fts' | 'semantic' | 'hybrid';
  } | null> {
    // Compare the SYNTHESIZED skill against existing skills — skill-content ↔
    // skill-content, the same space embeddings live in (this is what makes
    // semantic dedup reliable and closes R7). SkillSearch embeds the query;
    // with no embedder it degrades to FTS automatically.
    const { frontmatter, body } = parseSkillDocument(synthesized);
    const query = `${frontmatter.name}\n${frontmatter.description}\n${body}`.trim();
    if (!query) return null;

    try {
      const results = await this.search.search({
        query,
        mode: 'semantic', // SkillSearch degrades to FTS if no embedder
        limit: 1,
        agentId: trajectory.agentId ?? undefined,
      });
      if (results.length === 0) return null;
      const top = results[0]!;

      // Semantic/hybrid scores are cosine 0..1 → use the real
      // deduplicationThreshold. FTS (degraded) keeps the coarse rank gate.
      const isSemantic = top.matchType === 'semantic' || top.matchType === 'hybrid';
      const hit = isSemantic
        ? top.score >= this.policy.deduplicationThreshold
        : top.score > FTS_DEDUP_RANK_THRESHOLD;
      if (hit) {
        return {
          skill: top.skill,
          score: top.score,
          name: top.skill.name,
          matchType: top.matchType,
        };
      }
      return null;
    } catch (err) {
      // Search failure: treat as no duplicate (fail open for extraction).
      // eslint-disable-next-line no-console
      console.warn(
        '[mastra-self-learning] dedup search failed; allowing extraction.',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private async synthesize(trajectory: TaskTrajectory): Promise<string> {
    if (!this.generate) throw new AuxiliaryLLMNotConfiguredError();

    // First attempt
    let raw = await this.generate(buildSynthesisPrompt(trajectory), {
      maxTokens: 2000,
      temperature: 0.2,
    });
    let candidate = normalizeSynthesisOutput(raw);
    if (isParseable(candidate)) return candidate;

    // Retry once with a stricter prompt
    raw = await this.generate(buildSynthesisPrompt(trajectory, true), {
      maxTokens: 2000,
      temperature: 0.1,
    });
    candidate = normalizeSynthesisOutput(raw);
    if (isParseable(candidate)) return candidate;

    throw new Error('synthesis output unparseable after retry');
  }
}

// ---------------------------------------------------------------------------
// Free helpers (exported for processor + tests)
// ---------------------------------------------------------------------------

/**
 * Count tool calls deduplicated by (name, JSON.stringify(input)).
 * Used by the policy gate so that an agent retrying the same tool with the
 * same arguments doesn't fake-trigger extraction.
 */
export function distinctToolCallCount(trajectory: TaskTrajectory): number {
  const seen = new Set<string>();
  for (const c of trajectory.toolCalls) {
    seen.add(`${c.name}:${JSON.stringify(c.input ?? {})}`);
  }
  return seen.size;
}

function isParseable(content: string): boolean {
  try {
    const { frontmatter } = parseSkillDocument(content);
    return Boolean(
      frontmatter.name &&
        frontmatter.name !== 'unnamed-skill' &&
        typeof frontmatter.description === 'string',
    );
  } catch (err) {
    if (err instanceof SkillParseError) return false;
    return false;
  }
}
