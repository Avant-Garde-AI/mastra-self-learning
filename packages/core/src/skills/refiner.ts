import type { SkillRecord, RefinementSignals } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';
import type { TaskTrajectory } from './extractor.js';
import type { AuxiliaryGenerate } from './auxiliary-llm.js';
import { AuxiliaryLLMNotConfiguredError } from './auxiliary-llm.js';
import { parseSkillDocument } from './parser.js';
import { scanSkillContent } from './scanner.js';
import { normalizeSynthesisOutput } from './synthesis-prompt.js';
import { bumpPatch } from './version-utils.js';
import { unifiedDiff } from './version-utils.js';
import {
  buildRefinementPrompt,
  describeSignals,
} from './refinement-prompt.js';

export interface RefineEvaluation {
  shouldRefine: boolean;
  reason?: string;
  proposedVersion?: string;
}

/** Default minimum gap between refinements of the *same* skill, in ms. */
const DEFAULT_PER_SKILL_COOLDOWN_MS = 60_000;

/**
 * Refines existing skills based on usage feedback.
 *
 * MVP scope (deliberately small — see docs/mvp/05-phase-refinement.md):
 *   - Only two signals are honored: `failure` and `userCorrection`.
 *     (`deviation` / `newPitfall` / `unnecessaryStep` require procedure-diffing
 *     and are deferred to v0.2.0.)
 *   - Version bumps are patch-level only.
 *   - Single-shot LLM refinement with one parse retry.
 *
 * @see docs/mvp/05-phase-refinement.md
 */
export class SkillRefiner {
  private readonly perSkillCooldownMs: number;

  constructor(
    private storage: SkillStorageExtension,
    private generate?: AuxiliaryGenerate,
    perSkillCooldownMs: number = DEFAULT_PER_SKILL_COOLDOWN_MS,
  ) {
    this.perSkillCooldownMs = perSkillCooldownMs;
  }

  /**
   * Decide whether a skill should be refined. Returns `shouldRefine: false`
   * with a reason on every negative path (no active signals, recent
   * refinement cooldown).
   */
  async evaluate(
    skill: SkillRecord,
    _trajectory: TaskTrajectory,
    signals: RefinementSignals,
  ): Promise<RefineEvaluation> {
    if (!signalsActive(signals)) {
      return { shouldRefine: false, reason: 'no active refinement signals' };
    }

    // Per-skill cooldown: don't churn version history on repeated failures of
    // the same skill in quick succession.
    let recent: { createdAt: string }[] = [];
    try {
      recent = await this.storage.listVersions(skill.id);
    } catch {
      recent = [];
    }
    const last = recent[0]?.createdAt;
    if (
      this.perSkillCooldownMs > 0 &&
      last &&
      Date.now() - new Date(last).getTime() < this.perSkillCooldownMs
    ) {
      return {
        shouldRefine: false,
        reason: 'per-skill refinement cooldown active',
      };
    }

    // MVP: patch-level bump only. Major/minor require structural diffing.
    return {
      shouldRefine: true,
      reason: describeSignals(signals),
      proposedVersion: bumpPatch(skill.version),
    };
  }

  /**
   * Generate and persist a refined version of a skill.
   *
   * Throws if `evaluate` would have said no, if the LLM is unconfigured, if
   * synthesis is unparseable after one retry, or if the refined content fails
   * the security scan (an insecure refinement must never replace a safe skill).
   */
  async refine(
    skill: SkillRecord,
    trajectory: TaskTrajectory,
    signals: RefinementSignals,
    finalUserMessage?: string,
  ): Promise<SkillRecord> {
    const decision = await this.evaluate(skill, trajectory, signals);
    if (!decision.shouldRefine || !decision.proposedVersion) {
      throw new Error(
        `refine() called but evaluate() declined: ${decision.reason ?? 'unknown'}`,
      );
    }
    if (!this.generate) throw new AuxiliaryLLMNotConfiguredError();

    const newContent = await this.synthesizeRefinement(
      skill,
      trajectory,
      signals,
      decision.proposedVersion,
      finalUserMessage,
    );

    // Security scan — never let an insecure refinement replace a safe skill.
    const scan = scanSkillContent(newContent);
    if (!scan.safe) {
      throw new Error(
        `refinement failed security scan (${scan.findings.length} findings); skill left unchanged`,
      );
    }

    const { frontmatter } = parseSkillDocument(newContent);
    const diff = unifiedDiff(skill.content, newContent);

    // Persist: update the active skill + record the version with its diff.
    // updateSkill and createVersion each run their own transaction; the
    // version row is the durable audit record even if the skill update is
    // observed slightly later.
    const updated = await this.storage.updateSkill(skill.id, {
      content: newContent,
      frontmatter,
      version: decision.proposedVersion,
    });
    await this.storage.createVersion({
      skillId: skill.id,
      version: decision.proposedVersion,
      content: newContent,
      diffFromPrevious: diff,
      reason: describeSignals(signals),
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async synthesizeRefinement(
    skill: SkillRecord,
    trajectory: TaskTrajectory,
    signals: RefinementSignals,
    proposedVersion: string,
    finalUserMessage?: string,
  ): Promise<string> {
    if (!this.generate) throw new AuxiliaryLLMNotConfiguredError();

    let raw = await this.generate(
      buildRefinementPrompt(
        skill,
        trajectory,
        signals,
        proposedVersion,
        finalUserMessage,
      ),
      { maxTokens: 2500, temperature: 0.2 },
    );
    let candidate = normalizeSynthesisOutput(raw);
    if (isParseable(candidate)) return candidate;

    raw = await this.generate(
      buildRefinementPrompt(
        skill,
        trajectory,
        signals,
        proposedVersion,
        finalUserMessage,
        true,
      ),
      { maxTokens: 2500, temperature: 0.1 },
    );
    candidate = normalizeSynthesisOutput(raw);
    if (isParseable(candidate)) return candidate;

    throw new Error('refinement output unparseable after retry');
  }
}

// ---------------------------------------------------------------------------
// Free helpers (exported for the processor + tests)
// ---------------------------------------------------------------------------

/** MVP honors only `failure` and `userCorrection`. */
export function signalsActive(signals: RefinementSignals): boolean {
  return signals.failure || signals.userCorrection;
}

function isParseable(content: string): boolean {
  try {
    const { frontmatter } = parseSkillDocument(content);
    return Boolean(
      frontmatter.name &&
        frontmatter.name !== 'unnamed-skill' &&
        typeof frontmatter.description === 'string',
    );
  } catch {
    return false;
  }
}
