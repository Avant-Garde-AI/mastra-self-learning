# Embedding Seam — Decision (v0.2.0 Phase 1, Task 1.0)

Date: 2026-05-18.

## Decision

- **Seam**: callback `EmbedText = (texts: string[]) => Promise<number[][]>`.
  Mirrors the v0.1.0 `AuxiliaryGenerate` decision — no hard provider/version
  coupling; callers inject any embedder.
- **Shipped adapter**: `openAIEmbedder({ apiKey, model, dimensions })` →
  default `text-embedding-3-small`, **1536 dimensions**.
- **Harness wiring**: server constructs `openAIEmbedder` when
  `OPENAI_API_KEY` is set; otherwise semantic features degrade to FTS/`recent`
  with one warning. UAT Tier A injects a deterministic stub embedder so
  semantic dedup is asserted with zero keys.
- **Config**: reuse `embeddingModel?: string` (adapter model id); add
  `embeddingDimensions?: number` (default 1536) so schema + dim-guard agree.

## pgvector (verified in `@mastra/pg@1.10.1`)

`vector_cosine_ops`, `hnsw`, `ivfflat`, `<=>` all present. Plan:
`embedding vector(1536)` on `mastra_self_learning_skill_search`, HNSW index
`USING hnsw (embedding vector_cosine_ops)`, similarity = `1 - (embedding <=> q)`.
Store `embedding_dim` in a `msl_meta` table → loud stale detection on model
change + `backfillEmbeddings()`.

## Determinism rule

Unit/integration tests **never** call a real embedding API — always inject a
deterministic stub `EmbedText` (hash → fixed vector) so ranking assertions are
stable. Real OpenAI only via the harness with a key set.

## Status

Decision final. Proceeding to Phase 1 implementation 1.1 → 1.8
(`docs/v0.2.0/03-phase1-semantic-search.md`), full end-to-end.
