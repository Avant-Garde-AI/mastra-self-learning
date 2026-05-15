/**
 * Evaluation scorers for measuring learning effectiveness.
 *
 * Designed to be used with Mastra's eval system (Datasets + Experiments).
 *
 * @example
 * ```typescript
 * import { skillUtilizationScorer } from '@avant-garde/mastra-self-learning/evals';
 *
 * const experiment = await dataset.runExperiment({
 *   agent: myAgent,
 *   scorers: [skillUtilizationScorer],
 * });
 * ```
 *
 * @see docs/09-evaluation.md
 */

/**
 * Measures whether the agent uses available skills vs. reasoning from scratch.
 * Score: ratio of tasks where a relevant skill existed and was used (0-1).
 */
export const skillUtilizationScorer = {
  name: 'skill-utilization',
  description: 'Ratio of tasks where a relevant skill existed and was used',
  // TODO: Phase 5 — implement as Mastra createScorer()
};

/**
 * Measures whether skill refinements improve success rates over time.
 * Score: delta in success rate between consecutive versions (can be negative).
 */
export const skillQualityScorer = {
  name: 'skill-quality-trend',
  description: 'Whether skill refinements improve success rates',
  // TODO: Phase 5
};

/**
 * Measures identity drift from seed values.
 * Score: cosine similarity between current and seed identity (0-1, higher = less drift).
 */
export const identityDriftScorer = {
  name: 'identity-drift',
  description: 'Cosine similarity between current identity and seed identity',
  // TODO: Phase 5
};
