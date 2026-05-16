import type { SkillSearchOptions, SkillSearchResult } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';

/**
 * Hybrid skill search combining full-text search and semantic similarity.
 *
 * - **FTS** (Phase 1): Postgres `tsvector` over name, description, instructions.
 *   Implemented via {@link SkillStorageExtension.search}.
 * - **Semantic** (Phase 4): pgvector cosine similarity against pre-computed
 *   skill embeddings. Throws in v0.1.0.
 *
 * The MVP intentionally returns FTS results only. Semantic and hybrid modes
 * are tracked in `risks-and-unknowns.md` (R3, R7) and gated to Phase 4.
 *
 * @see docs/03-skill-system.md for search details
 */
export class SkillSearch {
  constructor(
    private storage: SkillStorageExtension,
    private embeddingModel?: string,
  ) {}

  async search(options: SkillSearchOptions): Promise<SkillSearchResult[]> {
    const mode = options.mode ?? 'fts';
    if (mode === 'fts') {
      return this.storage.search({ ...options, mode: 'fts' });
    }
    if (mode === 'semantic' || mode === 'hybrid') {
      throw new Error(
        `SkillSearch mode "${mode}" is a Phase 4 feature. v0.1.0 supports FTS only. ` +
          `embeddingModel=${this.embeddingModel ?? '(none)'}`,
      );
    }
    throw new Error(`Unknown search mode: ${String(mode)}`);
  }
}
