import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import type { AuxiliaryGenerate } from '@avant-garde/mastra-self-learning';

const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
export const hasLLM = API_KEY.length > 0;

const MODEL_ID =
  process.env.HARNESS_MODEL ?? 'claude-sonnet-4-5-20250929';

const anthropic = hasLLM ? createAnthropic({ apiKey: API_KEY }) : null;

/** The chat agent's language model (undefined when no key — chat disabled). */
export const chatModel = anthropic ? anthropic(MODEL_ID) : undefined;

/**
 * Auxiliary-LLM adapter for the self-learning loop (generalizability,
 * synthesis, refinement). Throws a clear error if invoked without a key —
 * the loop only calls this when extraction/refinement would actually fire.
 */
export const auxGenerate: AuxiliaryGenerate = async (prompt, opts) => {
  if (!anthropic) {
    throw new Error(
      'ANTHROPIC_API_KEY not set — auxiliary LLM unavailable. ' +
        'Set the key to enable automatic extraction/refinement.',
    );
  }
  const res = await generateText({
    model: anthropic(MODEL_ID),
    prompt,
    maxOutputTokens: opts?.maxTokens,
    temperature: opts?.temperature,
    abortSignal: opts?.abortSignal,
  });
  return res.text;
};
