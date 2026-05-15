import type { ExtractionPolicy } from '../config.js';
import type { ExtractionResult } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';

/**
 * Accumulated state from the output processor that tracks
 * the agent's execution trajectory during a task.
 */
export interface TaskTrajectory {
  /** Tool calls made during this task */
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    output?: unknown;
    timestamp: string;
  }>;
  /** Number of conversational turns */
  turnCount: number;
  /** Whether the user expressed satisfaction */
  positiveOutcome: boolean;
  /** The thread ID where this task occurred */
  threadId: string;
  /** The agent ID that executed this task */
  agentId: string;
  /** Compressed conversation context (from OM if available) */
  conversationSummary?: string;
}

/**
 * Extracts reusable skill documents from completed task trajectories.
 *
 * When the SelfLearningProcessor detects a qualifying task completion,
 * it passes the accumulated TaskTrajectory to the extractor. The extractor:
 *
 * 1. Checks the trajectory against ExtractionPolicy thresholds
 * 2. Runs a generalizability check via auxiliary LLM (optional)
 * 3. Checks for duplicate skills via semantic search
 * 4. Synthesizes a SKILL.md document from the trajectory
 * 5. Stores it via SkillStorageExtension
 *
 * @see docs/04-learning-loop.md for the full extraction pipeline
 */
export class SkillExtractor {
  private lastExtractionTime = 0;

  constructor(
    private storage: SkillStorageExtension,
    private policy: ExtractionPolicy,
    private auxiliaryModel: string,
  ) {}

  /**
   * Evaluate a task trajectory and potentially extract a skill.
   */
  async evaluate(trajectory: TaskTrajectory): Promise<ExtractionResult> {
    // TODO: Phase 2
    //
    // 1. Check cooldown
    // if (Date.now() - this.lastExtractionTime < this.policy.cooldownMs) {
    //   return { triggered: false, reason: 'Cooldown active' };
    // }
    //
    // 2. Check minimum thresholds
    // if (trajectory.toolCalls.length < this.policy.minToolCalls) ...
    // if (trajectory.turnCount < this.policy.minTurns) ...
    // if (this.policy.requirePositiveOutcome && !trajectory.positiveOutcome) ...
    //
    // 3. Generalizability check (auxiliary LLM call)
    // if (this.policy.useGeneralizabilityCheck) { ... }
    //
    // 4. Deduplication check (semantic search against existing skills)
    // const similar = await this.storage.search({ ... });
    // if (similar[0]?.score > this.policy.deduplicationThreshold) {
    //   // Consider updating the existing skill instead
    // }
    //
    // 5. Synthesize SKILL.md via auxiliary LLM
    // const skillContent = await this.synthesize(trajectory);
    //
    // 6. Store and return
    // this.lastExtractionTime = Date.now();

    throw new Error('Not implemented — Phase 2');
  }

  /**
   * Synthesize a SKILL.md document from a task trajectory.
   * Uses the auxiliary model to generalize the specific task
   * into a reusable procedure.
   */
  private async synthesize(trajectory: TaskTrajectory): Promise<string> {
    // TODO: Phase 2
    // The synthesis prompt instructs the LLM to:
    // 1. Identify the reusable procedure (strip instance-specific details)
    // 2. Enumerate prerequisites and verification steps
    // 3. Document pitfalls observed during execution
    // 4. Generate a "When to Use" section for future retrieval
    // 5. Assign tags for discoverability
    throw new Error('Not implemented — Phase 2');
  }
}
