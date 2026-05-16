/**
 * Token estimation. Pluggable: swap in a real tokenizer when accuracy matters.
 *
 * The MVP uses a `chars / 4` heuristic. This is roughly accurate for English
 * prose tokenized by Anthropic and OpenAI's BPE tokenizers (within ~20%), but
 * less accurate for:
 *   - Code-heavy skills (heuristic overestimates by 20–40%)
 *   - Non-English content (heuristic underestimates by 50–200%)
 *
 * See `docs/mvp/risks-and-unknowns.md` (R3) for when this breaks and how to
 * swap in a real tokenizer.
 */

export type TokenEstimator = (text: string) => number;

/** Default heuristic — `Math.ceil(chars / 4)`. */
export const heuristicEstimator: TokenEstimator = (text) =>
  Math.ceil(text.length / 4);

/** Alias used by callers that don't want to bind to a specific implementation. */
export const defaultEstimator: TokenEstimator = heuristicEstimator;

/** Convenience: estimate tokens of `text` using the default heuristic. */
export function estimateTokens(text: string): number {
  return heuristicEstimator(text);
}
