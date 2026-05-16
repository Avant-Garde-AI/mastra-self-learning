import { describe, expect, it } from 'vitest';
import { heuristicEstimator, estimateTokens, defaultEstimator } from './token-budget.js';

describe('token-budget heuristic', () => {
  it('returns 0 for empty string', () => {
    expect(heuristicEstimator('')).toBe(0);
  });

  it('rounds up via Math.ceil', () => {
    expect(heuristicEstimator('abc')).toBe(1); // 3 / 4 = 0.75 → 1
    expect(heuristicEstimator('abcd')).toBe(1);
    expect(heuristicEstimator('abcde')).toBe(2);
  });

  it('estimateTokens matches heuristicEstimator', () => {
    const sample = 'Lorem ipsum dolor sit amet';
    expect(estimateTokens(sample)).toBe(heuristicEstimator(sample));
  });

  it('defaultEstimator is the heuristic', () => {
    expect(defaultEstimator('hello world')).toBe(heuristicEstimator('hello world'));
  });
});
