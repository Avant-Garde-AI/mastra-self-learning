/**
 * Options for the self-learning Harness mode.
 */
export interface SelfLearningModeOptions {
  /** The agent to use in learn mode */
  agent: unknown; // Mastra Agent
  /** Mastra storage instance */
  storage: unknown; // MastraStorage
  /** Default model for the learn mode */
  defaultModel?: string;
}

/**
 * Create a Harness mode for explicit skill review and refinement.
 *
 * In "learn" mode, the agent focuses on:
 * - Reviewing recent task completions for skill extraction
 * - Refining existing skills based on accumulated feedback
 * - Curating the fact layer (adding, updating, removing facts)
 * - Running skill quality assessments
 *
 * This is distinct from the passive learning that happens via
 * the SelfLearningProcessor during normal chat — learn mode
 * is an explicit, user-initiated review session.
 *
 * @example
 * ```typescript
 * import { Harness } from '@mastra/core';
 * import { createSelfLearningMode } from '@avant-garde/mastra-self-learning/harness';
 *
 * const harness = new Harness({
 *   modes: {
 *     chat: { agent, defaultModel: '...' },
 *     learn: createSelfLearningMode({ agent, storage }),
 *   },
 * });
 *
 * // Switch to learn mode
 * await harness.switchMode({ modeId: 'learn' });
 * await harness.sendMessage({ content: 'Review my recent deployments and create skills' });
 * ```
 *
 * @see docs/06-harness-integration.md
 */
export function createSelfLearningMode(options: SelfLearningModeOptions) {
  // TODO: Phase 3
  //
  // Returns a HarnessMode:
  // {
  //   agent: options.agent (with learn-specific instructions appended),
  //   defaultModel: options.defaultModel,
  //   color: '#7C3AED', // purple for learn mode
  //   description: 'Review and refine learned skills',
  // }

  return {
    agent: options.agent,
    defaultModel: options.defaultModel,
    // Placeholder — will return full HarnessMode in Phase 3
  };
}

/**
 * Create Harness-level built-in tools for self-learning.
 * These are injected into every Harness agent call automatically.
 */
export function createHarnessTools(options: { storage: unknown }) {
  // TODO: Phase 3
  // Similar to createSelfLearningTools but optimized for Harness context
  // (e.g., tools that interact with Harness state, task tracking integration)
  return {};
}
