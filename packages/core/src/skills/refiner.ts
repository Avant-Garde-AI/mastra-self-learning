import type { SkillRecord, RefinementSignals } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';
import type { TaskTrajectory } from './extractor.js';

/**
 * Refines existing skills based on usage feedback.
 *
 * After a skill is used, the refiner evaluates whether the execution
 * reveals improvements. Triggers include: deviation from procedure,
 * new pitfalls, unnecessary steps, user corrections, or failures.
 *
 * Version bumping follows semver:
 * - Patch (1.0.0 → 1.0.1): Wording, new pitfall
 * - Minor (1.0.0 → 1.1.0): Step added/removed, prerequisites changed
 * - Major (1.0.0 → 2.0.0): Fundamental procedure change
 *
 * @see docs/04-learning-loop.md for refinement details
 */
export class SkillRefiner {
  constructor(
    private storage: SkillStorageExtension,
    private auxiliaryModel: string,
  ) {}

  /**
   * Evaluate whether a skill should be refined based on usage signals.
   */
  async evaluate(
    skill: SkillRecord,
    trajectory: TaskTrajectory,
    signals: RefinementSignals,
  ): Promise<{
    shouldRefine: boolean;
    reason?: string;
    proposedVersion?: string;
  }> {
    // TODO: Phase 2
    // Check if any refinement signal is active
    // If so, determine severity → version bump level
    throw new Error('Not implemented — Phase 2');
  }

  /**
   * Generate a refined version of a skill.
   */
  async refine(
    skill: SkillRecord,
    trajectory: TaskTrajectory,
    signals: RefinementSignals,
  ): Promise<SkillRecord> {
    // TODO: Phase 2
    // 1. Generate diff between skill procedure and actual execution
    // 2. Propose updated SKILL.md via auxiliary LLM
    // 3. Create new version with diff stored
    // 4. Update success/fail counts
    throw new Error('Not implemented — Phase 2');
  }
}
