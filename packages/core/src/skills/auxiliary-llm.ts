/**
 * Auxiliary LLM invocation — the function we call from inside the learning loop
 * to do generalizability checks, skill synthesis, and refinement.
 *
 * We use a callback-only API (Option A from `docs/mvp/risks-and-unknowns.md`),
 * deliberately avoiding hard coupling to a specific AI SDK or Mastra version.
 * Users provide a small adapter at processor construction time.
 *
 * @example AI SDK adapter (typical production setup)
 * ```ts
 * import { generateText } from 'ai';
 * import { anthropic } from '@ai-sdk/anthropic';
 *
 * const model = anthropic('claude-sonnet-4-5');
 *
 * const generate: AuxiliaryGenerate = async (prompt, opts) => {
 *   const result = await generateText({
 *     model,
 *     prompt,
 *     maxOutputTokens: opts?.maxTokens,
 *     temperature: opts?.temperature,
 *     abortSignal: opts?.abortSignal,
 *   });
 *   return result.text;
 * };
 *
 * createSelfLearningProcessor({ storage, generate });
 * ```
 *
 * @example Mastra agent re-use (production alternative)
 * ```ts
 * const auxAgent = new Agent({ model: 'anthropic/claude-sonnet-4-5', instructions: '' });
 * const generate: AuxiliaryGenerate = async (prompt) =>
 *   (await auxAgent.generate(prompt)).text;
 * ```
 *
 * @example Test setup
 * ```ts
 * const scripted = vi.fn().mockResolvedValueOnce('YES').mockResolvedValueOnce(skillMd);
 * createSelfLearningProcessor({ storage, generate: scripted });
 * ```
 */

export interface AuxiliaryGenerateOptions {
  /** Soft cap on completion tokens. Implementation may ignore. */
  maxTokens?: number;
  /** Sampling temperature in [0, 2]. Defaults to caller-specific. */
  temperature?: number;
  /** Abort signal propagated from the processor. */
  abortSignal?: AbortSignal;
}

export type AuxiliaryGenerate = (
  prompt: string,
  options?: AuxiliaryGenerateOptions,
) => Promise<string>;

/** Thrown when the extractor is invoked without an auxiliary LLM configured. */
export class AuxiliaryLLMNotConfiguredError extends Error {
  constructor() {
    super(
      'Self-learning processor: no auxiliary LLM configured. ' +
        'Pass `generate` to createSelfLearningProcessor (see AuxiliaryGenerate JSDoc).',
    );
    this.name = 'AuxiliaryLLMNotConfiguredError';
  }
}
