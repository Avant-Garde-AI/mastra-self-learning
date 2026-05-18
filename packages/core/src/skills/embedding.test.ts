import { describe, expect, it, vi } from 'vitest';
import {
  cosineSim,
  toVectorLiteral,
  makeSafeEmbedder,
  hashEmbedder,
  EmbeddingDimensionError,
} from './embedding.js';

describe('cosineSim', () => {
  it('is 1 for identical vectors, ~0 for orthogonal', () => {
    expect(cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSim([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
  });
  it('returns 0 when a vector is all-zero', () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
  it('throws on dimension mismatch', () => {
    expect(() => cosineSim([1, 2], [1, 2, 3])).toThrow(EmbeddingDimensionError);
  });
});

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });
});

describe('hashEmbedder', () => {
  it('is deterministic and identical text → identical vector', async () => {
    const e = hashEmbedder(64);
    const [a] = await e(['deploy a cloud run service']);
    const [b] = await e(['deploy a cloud run service']);
    expect(a).toEqual(b);
    expect(a.length).toBe(64);
  });
  it('more shared tokens → higher cosine (similarity-monotone)', async () => {
    const e = hashEmbedder(512);
    const [ctx, near, far] = await e([
      'deploy a containerized service to cloud run',
      'deploy a containerized service to cloud run with traffic splitting',
      'rotate database credentials and audit access logs',
    ]);
    expect(cosineSim(ctx, near)).toBeGreaterThan(cosineSim(ctx, far));
  });
  it('produces L2-normalized vectors', async () => {
    const [v] = await hashEmbedder(128)(['hello world hello']);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe('makeSafeEmbedder', () => {
  it('returns null for an undefined embedder', () => {
    expect(makeSafeEmbedder(undefined)).toBeNull();
  });
  it('passes through valid output', async () => {
    const safe = makeSafeEmbedder(async (t) => t.map(() => [1, 2, 3]));
    expect(await safe!(['a', 'b'])).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
  });
  it('throws EmbeddingDimensionError on wrong vector count', async () => {
    const bad = makeSafeEmbedder(async () => [[1, 2, 3]]);
    await expect(bad!(['a', 'b'])).rejects.toThrow(EmbeddingDimensionError);
  });
  it('propagates the inner embedder error', async () => {
    const boom = makeSafeEmbedder(
      vi.fn().mockRejectedValue(new Error('provider down')),
    );
    await expect(boom!(['x'])).rejects.toThrow('provider down');
  });
});
