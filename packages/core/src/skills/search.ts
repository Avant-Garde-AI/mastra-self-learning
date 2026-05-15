import type { SkillSearchOptions, SkillSearchResult } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';

/**
 * Hybrid skill search combining full-text search and semantic similarity.
 *
 * - FTS: Matches skill names, descriptions, tags, and body text via the
 *   storage backend's native FTS (Postgres tsvector, LibSQL FTS5, etc.)
 * - Semantic: Embeds the query and compares against pre-computed skill
 *   embeddings via Mastra's vector infrastructure.
 *
 * @see docs/03-skill-system.md for search details
 */
export class SkillSearch {
  constructor(
    private storage: SkillStorageExtension,
    private embeddingModel?: string,
  ) {}

  async search(options: SkillSearchOptions): Promise<SkillSearchResult[]> {
    const mode = options.mode ?? 'hybrid';

    // TODO: Phase 1 (FTS), Phase 4 (semantic)
    //
    // if (mode === 'fts' || mode === 'hybrid') {
    //   ftsResults = await this.ftsSearch(options);
    // }
    // if (mode === 'semantic' || mode === 'hybrid') {
    //   semanticResults = await this.semanticSearch(options);
    // }
    // return mergeAndRank(ftsResults, semanticResults);

    throw new Error('Not implemented — Phase 1');
  }

  private async ftsSearch(options: SkillSearchOptions): Promise<SkillSearchResult[]> {
    throw new Error('Not implemented — Phase 1');
  }

  private async semanticSearch(options: SkillSearchOptions): Promise<SkillSearchResult[]> {
    throw new Error('Not implemented — Phase 4');
  }
}
