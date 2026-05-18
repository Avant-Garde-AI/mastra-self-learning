# v0.2.0 Phase 1 — Semantic Search & Retrieval Quality (implementation-ready)

Covers R1 (semantic search), R2 (`relevant` overflow), R3 (dedup fix / closes
risk R7). This is the kickoff item.

## Spike findings (already verified)

- `@mastra/pg@1.10.1` ships pgvector support: `vector_cosine_ops`, `hnsw`,
  `ivfflat`, and the `<=>` cosine-distance operator are present in the driver
  bundle. We can create an ANN index and rank with `embedding <=> $query`.
- `config.ts` already has `embeddingModel?: string` and
  `deduplicationThreshold: z.number().min(0).max(1).default(0.85)` — currently
  unused for cosine; the extractor uses a `FTS_DEDUP_RANK_THRESHOLD = 0.05`
  hack instead. Phase 1 makes `deduplicationThreshold` mean what it says.
- `search.ts` throws "Phase 4" for `semantic`/`hybrid`. `ensureSchema()`
  already conditionally adds an `embedding VECTOR` column (untyped dim) when
  pgvector is present.

## Decision (Task 1.0) — embedding seam

**Mirror the v0.1.0 `AuxiliaryGenerate` decision.** A callback seam, no hard
provider/version coupling:

```ts
export type EmbedText = (texts: string[]) => Promise<number[][]>;
```

- Primary: caller supplies `embed`. Shipped convenience adapter:
  `openAIEmbedder({ apiKey, model = 'text-embedding-3-small' })` (1536-d).
- Config keeps `embeddingModel?: string` for the adapter's model id;
  add `embeddingDimensions?: number` (default 1536) so the schema and the
  dimension guard agree.
- No embedder configured ⇒ semantic/hybrid/`relevant` degrade to FTS/`recent`
  with one logged warning (no throw). `semanticSearchAvailable` already exists;
  extend it to also require an embedder, not just pgvector.

**Confirm provider before coding 1.1+.** Recommended default adapter: OpenAI
`text-embedding-3-small` (cheap, 1536-d, ubiquitous); the harness already has
an OpenAI dep transitively via `@copilotkit/runtime`.

## File-by-file changes

### 1.1 `packages/core/src/skills/embedding.ts` (new)

```ts
export type EmbedText = (texts: string[]) => Promise<number[][]>;

export interface EmbeddingConfig {
  embed?: EmbedText;
  dimensions?: number;          // default 1536
}

export class EmbeddingDimensionError extends Error {}

export function makeSafeEmbedder(cfg?: EmbeddingConfig):
  { embed: EmbedText | null; dims: number };

/** cosine of two equal-length vectors; throws EmbeddingDimensionError on mismatch */
export function cosine(a: number[], b: number[]): number;

/** convenience adapter, lazy-imports 'openai' so it stays optional */
export function openAIEmbedder(o: {
  apiKey: string; model?: string; dimensions?: number;
}): EmbedText;
```

- `makeSafeEmbedder` wraps the callback so a throw never breaks extraction
  (same pattern as `makeSafeEmitter`).
- Re-export from `skills/index.ts` + root `index.ts`.

### 1.2 `storage-extension.ts` — schema

In `ensureSchema()` (pgvector branch only):

```sql
-- type the column to the configured dimension; store the dim in msl_meta so a
-- model change is detected and surfaced rather than silently mis-ranking.
CREATE TABLE IF NOT EXISTS msl_meta (key TEXT PRIMARY KEY, value TEXT);
-- embedding column already added untyped in v0.1.0; ensure typed + index:
ALTER TABLE mastra_self_learning_skill_search
  ADD COLUMN IF NOT EXISTS embedding vector(<DIM>);
CREATE INDEX IF NOT EXISTS msl_skill_search_vec_idx
  ON mastra_self_learning_skill_search USING hnsw (embedding vector_cosine_ops);
```

- Embeddings live on the denormalized `mastra_self_learning_skill_search`
  projection (already the FTS table) — keeps search single-table, no extra join.
- On startup, if `msl_meta.embedding_dim` exists and ≠ configured dim, log a
  loud warning + set `semanticSearchAvailable = false` (stale embeddings);
  expose `needsReembed()` for the backfill helper.

### 1.3 Write path — `createSkill` / `updateSkill`

- After the existing search-projection upsert, if an embedder is configured,
  compute `embed([${name}\n${description}\n${instructions}])[0]` and
  `UPDATE …skill_search SET embedding = $1 WHERE skill_id = $2`.
- `updateSkill`: recompute only when name/description/instructions changed.
- Failure to embed = warn + leave embedding null (row still FTS-searchable).
- Add `backfillEmbeddings(limit?)`: iterates rows with null/stale embedding,
  embeds in batches, updates. Exposed for a CLI/admin trigger and gardening.

### 1.4 `storage-extension.search` + `search.ts` — semantic/hybrid (R1)

`SkillStorageExtension.search`:

```sql
-- semantic: ORDER BY embedding <=> $qvec ASC  (cosine distance)
-- score = 1 - (embedding <=> $qvec)            (→ cosine similarity 0..1)
-- hybrid: w*semScore + (1-w)*ftsRankNorm, w = options.semanticWeight ?? 0.7
```

- `SkillSearchOptions` gains `semanticWeight?: number` (0..1, default 0.7).
- `search.ts`: remove the throws. `semantic`/`hybrid` embed the query via the
  injected `EmbedText`; no embedder ⇒ fall back to FTS + one warning.
- `SkillSearch` constructor takes `embed?: EmbedText` instead of the unused
  `embeddingModel?: string` string (breaking the *internal* ctor only — public
  factories updated; document in changeset).
- Deterministic: identical query+corpus ⇒ identical order (tie-break by
  `created_at` then `id`).

### 1.5 `SkillRouter` — `relevant` overflow (R2)

- Inject `embed?: EmbedText` (constructed by the same factory that builds the
  router). On overflow with `overflowStrategy: 'relevant'` and an embedder:
  embed the recent-messages string (router already receives it for the L0
  build path), rank skills by cosine to it, greedy-fit to `indexBudget`.
- No embedder ⇒ existing `recent` fallback + the existing one-time warning
  (keep that test).

### 1.6 `SkillExtractor.findDuplicate` — semantic dedup (R3)

- Replace the `FTS_DEDUP_RANK_THRESHOLD = 0.05` hack: embed the synthesized
  candidate (or the trajectory summary used for synthesis), cosine vs existing
  skill embeddings; if max cosine ≥ `policy.deduplicationThreshold` (0.85),
  route to refinement (return the matched skill) instead of storing.
- FTS stays as a cheap pre-filter to shrink the candidate set before the
  cosine compare (keeps it fast on large libraries).
- No embedder ⇒ keep the v0.1.0 FTS-rank behavior (documented degradation).

### 1.7 Tests to rewrite

- `self-learning-processor.integration.test.ts`: the test **"does NOT dedup
  when synthesized skill omits the tool names"** is rewritten to assert dedup
  **succeeds** (no near-duplicate stored; matched skill returned). Its sibling
  positive test stays.
- `extractor.test.ts`: dedup unit cases switch from FTS-rank stubs to a stubbed
  embedder returning controllable vectors.
- `router.test.ts`: add a `relevant`-with-stub-embedder case; keep the
  no-embedder fallback/warning case.
- `search` integration: an intent query
  (`"I need to deploy a container somewhere"`) ranks the Cloud Run skill #1
  ahead of an unrelated skill, in `semantic` and `hybrid`.

### 1.8 Wiring

- `createSelfLearningTools`, `createSelfLearningProcessor`,
  `createSkillContextProcessor` gain an optional `embed?: EmbedText`
  (threaded to SkillSearch/Router/Extractor). Harness server adds an
  `openAIEmbedder` when `OPENAI_API_KEY` is set; UAT Tier-A adds a
  deterministic stub embedder so semantic dedup is asserted without a key.

## Exit criteria (Phase 1)

- [ ] `EmbedText` seam + `openAIEmbedder` adapter; `EMBEDDING_NOTES.md` written.
- [ ] `ensureSchema` types the vector column + HNSW index; dim recorded in
      `msl_meta`; stale-dim detection.
- [ ] Embeddings written on create/update; `backfillEmbeddings` works.
- [ ] `SkillSearch` `semantic` + `hybrid` return embedding-ranked results;
      **zero "Phase 4" throws** remain in the codebase.
- [ ] `relevant` overflow uses similarity; `recent` fallback + warning intact.
- [ ] `findDuplicate` is semantic; `deduplicationThreshold` is the real 0–1
      cosine gate; the `FTS_DEDUP_RANK_THRESHOLD` hack removed.
- [ ] The rewritten dedup test **passes** (R7 closed).
- [ ] v0.1.0 suite still 176-green; harness UAT Tier A still 4/4 (Tier A gets
      a stub embedder so it now also asserts semantic dedup).
- [ ] No-embedder path degrades gracefully (FTS / `recent`) with one warning.

## Risks

- **Embedding-model drift**: changing the model/dim invalidates stored
  vectors. Mitigated by `msl_meta` dim record + loud stale detection +
  `backfillEmbeddings`. Document in `LIMITATIONS.md`.
- **pgvector index params**: HNSW vs ivfflat recall/latency. Default HNSW
  (`vector_cosine_ops`); make index method configurable; fine for dev/MVP
  scale, revisit for very large libraries.
- **Cost/latency on the write path**: one embed call per create/update.
  Acceptable (extraction is already async fire-and-forget). Batch in
  `backfillEmbeddings`.
- **Determinism in tests**: never call a real embedding API in unit/integration
  tests — always inject a deterministic stub `EmbedText` (e.g., hash → fixed
  vector) so ranking assertions are stable.

## Estimate

~1.5–2 weeks single-dev. Highest-leverage work in v0.2.0: directly closes
risk R7 and unblocks Phase 2 (semantic dedup workflow) and Phase 3 (drift via
embeddings).
