import type { ExtractionPolicy } from '../config.js';
import type { TaskTrajectory } from '../skills/extractor.js';

/**
 * Options for the self-learning output processor.
 */
export interface SelfLearningProcessorOptions {
  /** Mastra storage instance */
  storage: unknown; // MastraStorage — typed once we import @mastra/core
  /** Auxiliary model for extraction/refinement */
  auxiliaryModel?: string;
  /** Extraction policy configuration */
  extraction?: Partial<ExtractionPolicy>;
}

/**
 * Create a Mastra output processor that implements the closed learning loop.
 *
 * This processor sits inside the agent's agentic loop via Mastra's
 * processOutputStep mechanism. It:
 *
 * 1. Accumulates state across steps via ProcessorState:
 *    - Counts tool calls
 *    - Records tool call trace (names, inputs, outputs)
 *    - Detects task completion signals
 *
 * 2. When the agent loop terminates (final response, no more tool calls):
 *    - Evaluates accumulated state against ExtractionPolicy
 *    - If triggered, fires async skill extraction via SkillExtractor
 *    - Records usage if an existing skill was used
 *
 * The processor is streaming-aware — it processes each chunk via
 * processOutputStream and accumulates state without blocking.
 *
 * @example
 * ```typescript
 * import { createSelfLearningProcessor } from '@avant-garde/mastra-self-learning/processors';
 *
 * const agent = new Agent({
 *   outputProcessors: [
 *     createSelfLearningProcessor({
 *       storage,
 *       extraction: { minToolCalls: 5 },
 *     }),
 *   ],
 * });
 * ```
 *
 * @see docs/02-processors.md for integration details
 * @see docs/04-learning-loop.md for the full extraction pipeline
 */
export function createSelfLearningProcessor(options: SelfLearningProcessorOptions) {
  // TODO: Phase 2
  //
  // Return a Mastra Processor object implementing:
  //
  // {
  //   name: 'self-learning',
  //
  //   processOutputStream({ part, streamParts, state }) {
  //     // Accumulate tool call data in state
  //     if (part.type === 'tool-call') {
  //       state.toolCalls = state.toolCalls || [];
  //       state.toolCalls.push(part);
  //     }
  //     if (part.type === 'tool-result') {
  //       // Match result to call, record output
  //     }
  //     // Pass through — we observe, we don't transform
  //     return part;
  //   },
  //
  //   async processOutputResult({ messages }) {
  //     // Called after the agent loop completes
  //     // Evaluate accumulated trajectory for extraction
  //     const trajectory: TaskTrajectory = buildTrajectory(state);
  //     const result = await extractor.evaluate(trajectory);
  //     if (result.triggered) {
  //       // Skill created — log it
  //     }
  //     return messages; // Pass through unchanged
  //   },
  // }

  return {
    name: 'self-learning',
    // Placeholder — will implement Processor interface from @mastra/core
  };
}
