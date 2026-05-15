import type { SkillRouterConfig, FactLayerConfig, Identity } from '../config.js';

/**
 * Options for the skill context input processor.
 */
export interface SkillContextProcessorOptions {
  /** Mastra storage instance */
  storage: unknown; // MastraStorage
  /** Identity definition (personality, expertise, guardrails) */
  identity?: Identity;
  /** Fact layer config */
  factLayer?: Partial<FactLayerConfig>;
  /** Skill router config (token budgets, overflow strategy) */
  skillRouter?: Partial<SkillRouterConfig>;
}

/**
 * Create a Mastra input processor that injects self-learning context
 * into the agent's system prompt.
 *
 * Assembles the prompt layers in this order (top = most stable = most cacheable):
 *
 * 1. Identity Layer (SOUL) — stable personality/expertise definition
 * 2. Fact Layer (MEMORY) — cross-thread persistent facts
 * 3. Skill Index (L0) — available procedures (names + descriptions)
 * 4. [Observational Memory — handled by Mastra's OM, not us]
 * 5. [Recent Messages — handled by Mastra's memory system]
 *
 * This ordering maximizes prompt cache hit rates since the stable
 * layers sit at the top and change infrequently.
 *
 * @example
 * ```typescript
 * import { createSkillContextProcessor } from '@avant-garde/mastra-self-learning/processors';
 *
 * const agent = new Agent({
 *   inputProcessors: [
 *     createSkillContextProcessor({
 *       storage,
 *       identity: { personality: 'You are a DevOps agent...', expertise: ['gcp'] },
 *       factLayer: { enabled: true },
 *     }),
 *   ],
 * });
 * ```
 *
 * @see docs/02-processors.md for integration details
 * @see docs/05-memory-layers.md for the layered memory architecture
 */
export function createSkillContextProcessor(options: SkillContextProcessorOptions) {
  // TODO: Phase 3
  //
  // Return a Mastra Processor implementing:
  //
  // {
  //   name: 'skill-context',
  //
  //   async processInput({ messages }) {
  //     // 1. Build identity block
  //     const identityBlock = buildIdentityBlock(options.identity);
  //
  //     // 2. Fetch relevant facts from FactLayer
  //     const factsBlock = await factLayer.getRelevantFacts(messages);
  //
  //     // 3. Build skill index via SkillRouter
  //     const skillIndex = await router.buildIndex(agentId);
  //
  //     // 4. Prepend context blocks as a system message
  //     const contextMessage = {
  //       role: 'system',
  //       content: [identityBlock, factsBlock, skillIndex]
  //         .filter(Boolean)
  //         .join('\n\n---\n\n'),
  //     };
  //
  //     return [contextMessage, ...messages];
  //   },
  // }

  return {
    name: 'skill-context',
    // Placeholder — will implement Processor interface from @mastra/core
  };
}
