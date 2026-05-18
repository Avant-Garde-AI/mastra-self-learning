/**
 * Embedding seam for semantic skill search / dedup / drift (v0.2.0).
 *
 * Callback-only, mirroring the v0.1.0 `AuxiliaryGenerate` decision — no hard
 * provider/version coupling. Callers inject any embedder; a convenience
 * OpenAI adapter and a deterministic dev/test stub are shipped.
 *
 * @see docs/v0.2.0/03-phase1-semantic-search.md
 * @see packages/core/EMBEDDING_NOTES.md
 */

export type EmbedText = (texts: string[]) => Promise<number[][]>;

/** Thrown when vector dimensions don't line up. */
export class EmbeddingDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingDimensionError';
  }
}

/**
 * Wrap a user embedder so a throw / bad shape never breaks the (already
 * fire-and-forget) learning work — returns `null` and the caller degrades to
 * FTS. `null` embed means "no semantic capability".
 */
export function makeSafeEmbedder(embed?: EmbedText): EmbedText | null {
  if (!embed) return null;
  return async (texts: string[]) => {
    const out = await embed(texts);
    if (!Array.isArray(out) || out.length !== texts.length) {
      throw new EmbeddingDimensionError(
        `embedder returned ${Array.isArray(out) ? out.length : 'non-array'} vectors for ${texts.length} inputs`,
      );
    }
    return out;
  };
}

/** Cosine similarity in [-1, 1]. Throws on dimension mismatch. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingDimensionError(
      `cosine dim mismatch: ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Postgres pgvector literal for a parameterized `$n::vector` bind. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Convenience OpenAI adapter. Lazily imports `openai` so the dep stays
 * optional for consumers who inject their own embedder.
 *
 * Default model `text-embedding-3-small` (1536-d).
 */
export function openAIEmbedder(opts: {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseURL?: string;
}): EmbedText {
  const model = opts.model ?? 'text-embedding-3-small';
  let clientP: Promise<{
    embeddings: {
      create: (a: {
        model: string;
        input: string[];
        dimensions?: number;
      }) => Promise<{ data: Array<{ embedding: number[] }> }>;
    };
  }> | null = null;
  return async (texts: string[]) => {
    if (texts.length === 0) return [];
    if (!clientP) {
      // Indirect specifier: `openai` is an OPTIONAL peer (only needed if you
      // use this adapter). The variable stops tsc from statically resolving
      // its types in the core package, which doesn't depend on it.
      const spec = 'openai';
      clientP = (import(spec) as Promise<unknown>).then(
        (m) =>
          new (m as { default: new (o: unknown) => any }).default({
            apiKey: opts.apiKey,
            baseURL: opts.baseURL,
          }),
      );
    }
    const client = await clientP;
    const res = await client.embeddings.create({
      model,
      input: texts,
      ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
    });
    return res.data.map((d) => d.embedding);
  };
}

/**
 * Deterministic, dependency-free embedder for dev/test and the harness when
 * no real key is set. Feature-hashes tokens into a fixed-dim L2-normalized
 * vector — *not* semantically meaningful across unrelated words, but stable
 * and similarity-monotone for overlapping text (identical text → identical
 * vector; more shared tokens → higher cosine). Never use in production.
 */
export function hashEmbedder(dimensions = 1536): EmbedText {
  return async (texts: string[]) =>
    texts.map((t) => {
      const v = new Array<number>(dimensions).fill(0);
      const toks = t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const tok of toks) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) {
          h ^= tok.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        const idx = Math.abs(h) % dimensions;
        v[idx] += 1;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    });
}
