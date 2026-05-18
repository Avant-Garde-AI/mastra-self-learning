import type { SkillSearchOptions, SkillSearchResult } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';
import { makeSafeEmbedder, type EmbedText } from './embedding.js';

/**
 * Hybrid skill search combining full-text and semantic similarity (v0.2.0).
 *
 * - **FTS**: Postgres `tsvector` over name/description/instructions.
 * - **Semantic**: pgvector cosine over pre-computed skill embeddings.
 * - **Hybrid** (default-ish): weighted blend of both.
 *
 * Embedding is done here (the storage layer never embeds). With no embedder
 * configured, or pgvector unavailable, semantic/hybrid degrade to FTS with a
 * single one-time warning — never a throw.
 *
 * @see docs/v0.2.0/03-phase1-semantic-search.md
 */
export class SkillSearch {
  private readonly embed: EmbedText | null;
  private warnedFallback = false;

  constructor(storage: SkillStorageExtension, embed?: EmbedText);
  /** @deprecated string model id no longer used; pass an `EmbedText`. */
  constructor(storage: SkillStorageExtension, legacy?: unknown);
  constructor(
    private storage: SkillStorageExtension,
    embedOrLegacy?: EmbedText | unknown,
  ) {
    this.embed =
      typeof embedOrLegacy === 'function'
        ? makeSafeEmbedder(embedOrLegacy as EmbedText)
        : null;
  }

  async search(options: SkillSearchOptions): Promise<SkillSearchResult[]> {
    const mode = options.mode ?? 'fts';

    if (mode === 'fts') {
      return this.storage.search({ ...options, mode: 'fts' });
    }

    // semantic / hybrid — embed the query, then delegate.
    if (this.embed && options.query?.trim()) {
      try {
        const [qvec] = await this.embed([options.query]);
        if (qvec && qvec.length > 0) {
          return this.storage.search({ ...options, mode, queryEmbedding: qvec });
        }
      } catch (err) {
        // fall through to FTS
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] query embedding failed; falling back to FTS.',
          err instanceof Error ? err.message : err,
        );
      }
    } else if (!this.warnedFallback) {
      this.warnedFallback = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[mastra-self-learning] "${mode}" search requested but no embedder configured; ` +
          'using FTS. Pass `embed` to enable semantic search.',
      );
    }
    return this.storage.search({ ...options, mode: 'fts' });
  }
}
