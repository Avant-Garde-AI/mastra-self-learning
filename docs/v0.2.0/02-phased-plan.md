# v0.2.0 — Phased Implementation Plan

Dependency-ordered. Each phase ends green (full v0.1.0 suite + that phase's new
tests) and is independently shippable as a `0.2.0-alpha.N`. Requirement IDs
(R1…R15) reference `01-requirements.md`.

```
P1 Semantic search ──┬──> P2 Gardening ───┐
                     └──> P3 Memory ──┐    │
                                      ├──> P4 Observability/Evals
P5 Ecosystem/Portability (parallel after the P1 storage touch settles)
P6 Hardening/Polish (last; depends on all)
```

---

## Phase 1 — Semantic search & retrieval quality  ·  R1, R2, R3

**Goal**: embedding-grade search, the `relevant` overflow strategy, and a real
fix for risk R7 — semantically similar trajectories dedup correctly.

**Blocking decision (Task 1.0)**: embedding provider/model. Anthropic has no
embeddings API; the harness uses Anthropic for chat. Options: OpenAI
`text-embedding-3-small` (1536-d, cheap, ubiquitous), Voyage `voyage-3`, or a
local model via a pluggable `EmbeddingModel` callback (mirrors the
`AuxiliaryGenerate` callback decision from v0.1.0 Phase 3 — same rationale: no
hard provider/version coupling). **Recommendation: a callback seam
(`EmbedText = (texts: string[]) => Promise<number[][]>`) as primary**, with a
thin OpenAI adapter shipped for convenience. Confirm before coding.

**Tasks**
1.0 Decide embedding seam; write `EMBEDDING_NOTES.md`. Verify pgvector
    distance ops + index (`vector_cosine_ops`, ivfflat/hnsw) in the pinned
    `@mastra/pg`.
1.1 `embedding.ts`: `EmbedText` type, `makeSafeEmbedder`, OpenAI adapter,
    `cosineRank` helper, dimension guard.
1.2 `ensureSchema()`: ensure `embedding VECTOR(<dim>)` + an ANN index when
    pgvector present; dimension stored in a small `msl_meta` row so a model
    change is detected and flagged.
1.3 Write path: `createSkill` / `updateSkill` compute + persist embedding from
    `name + description + instructions`; backfill helper for existing rows.
1.4 `SkillStorageExtension.search`: implement `semantic` + `hybrid`
    (`score = w*cos + (1-w)*ftsRankNorm`, `w` configurable); remove the
    "Phase 4" throws (R1).
1.5 `SkillRouter`: real `relevant` overflow — embed recent messages, rank,
    truncate; keep `recent` fallback when no embedder (R2).
1.6 `SkillExtractor.findDuplicate`: semantic cosine vs `deduplicationThreshold`
    (now genuinely 0–1); FTS stays as cheap pre-filter (R3).
1.7 Rewrite the two v0.1.0 dedup tests: the "omits tool names" case now
    **asserts dedup succeeds**.
1.8 Tests: embedder unit (stubbed), Testcontainers semantic/hybrid ranking,
    router relevant, extractor semantic dedup; v0.1.0 suite stays 176-green;
    harness UAT Tier A stays 4/4.

**Exit**: success criteria #1, #2 (`00-overview.md`). No "Phase 4" throw
remains. ~1.5–2 wks.

---

## Phase 2 — Gardening & storage maintenance  ·  R4

**Goal**: the four scheduled workflows; the library improves over time.
**Prereq**: Phase 1 (dedup workflow needs semantic similarity).

**Tasks**
2.1 `createWorkflow()` scaffolding + scheduler registration; CAS-safety helper.
2.2 `deduplication` (weekly): pairwise semantic merge → archive + version
    entry.
2.3 `decay` (weekly): wire `FactLayer.applyDecay()` + skill deprecate/archive
    rules.
2.4 `qualityScoring` (weekly): success-rate/trend → metadata + review flags.
2.5 `driftDetection` (monthly): per-agent identity drift (consumes Phase 3
    R5.3 — if P3 not yet merged, ship 2.5 behind a feature check and complete
    in P3's window).
2.6 Manual triggers (CLI + learn-mode hook) per workflow.
2.7 Tests: per-workflow state mutation; gardening-vs-live-write CAS test.

**Exit**: success criterion #3. ~1.5 wks.

---

## Phase 3 — Memory maturity  ·  R5, R6

**Goal**: identity drift/calibration real; the three deferred refinement
signals. **Prereq**: Phase 1 (embeddings for drift).

**Tasks**
3.1 `identity_calibrations` table in `ensureSchema()`.
3.2 `IdentityLayer.updateCalibration` / `getCurrentIdentity` merge (R5.1–5.2).
3.3 `measureDrift` via embedding similarity (R5.3); remove Phase-6 throws.
3.4 Procedure-step extraction from SKILL.md (reuse `extractSection`).
3.5 `buildRefinementSignals`: implement `deviation`, `newPitfall`,
    `unnecessaryStep`; widen `signalsActive`; version-bump severity map.
3.6 Tests: calibrate/merge, drift monotonicity, each signal from synthetic
    trajectory→skill, bump-level selection.

**Exit**: success criterion #4. ~1.5–2 wks.

---

## Phase 4 — Observability & evals  ·  R7, R8

**Goal**: OTel spans + the three scorers. **Prereq**: Phase 3 (drift scorer).

**Tasks**
4.1 `tracing.ts`: span emitter bridging the existing `onEvent` events to OTel;
    attribute names per `spec/09-evaluation.md`; opt-in config.
4.2 Instrument extraction/refinement/skill-load/fact-persist/gardening.
4.3 `skillUtilizationScorer`, `skillQualityScorer`, `identityDriftScorer` via
    `createScorer()`.
4.4 Eval dataset fixture + `runExperiment` wiring.
4.5 Tests: in-memory OTel exporter assertions; scorer values on seeded data.

**Exit**: success criteria #5, #6. ~1 wk.

---

## Phase 5 — Ecosystem & portability  ·  R9, R10, R11, R12

**Goal**: portable storage, Hermes CLI, LLM scan, Tier-3 harness. Largely
parallelizable; R9 (driver refactor) should land first since others build on
the storage surface.

**Tasks**
5.1 `StorageDriver` interface; extract `PostgresDriver` (pure refactor, suite
    stays green) (R9.1–9.2).
5.2 `LibSQLDriver` + parameterize the storage integration suite (R9.3).
5.3 `MongoDriver` best-effort (R9.4) — re-defer if it slips.
5.4 `packages/cli`: `import`/`import-memory`/`import-identity`/`export`/`list`/
    `analytics` (R10); round-trip + Hermes-fixture tests.
5.5 `scanner.ts`: optional LLM second pass via `AuxiliaryGenerate` (R11).
5.6 `harness/index.ts`: real `createSelfLearningMode` + optional subagents +
    `SelfLearningContext` (R12); learn-mode integration test.

**Exit**: success criteria #7, #8, #9, #10. ~2–2.5 wks.

---

## Phase 6 — Hardening & polish  ·  R13, R14, R15

**Goal**: trust ladder, user scoping, v0.1.0 polish. **Prereq**: Phases 1–5.

**Tasks**
6.1 Trust promotion/demotion state machine; driven by Phase-2 gardening (R13).
6.2 `userId` scope across schema/storage/tools (R14) — breaking-ish; gate
    behind config, document in changeset.
6.3 Stable YAML key ordering in `serializeSkillDocument` (R15.1) + the
    refinement diff test asserting no frontmatter churn.
6.4 `scripts/harness-kill.sh` + README (R15.2); reconcile MVP checklists
    (R15.3).
6.5 Final: `LIMITATIONS.md` rewrite; re-defer anything that slipped with new
    target + rationale; full suite + UAT Tier A/B green; tag `v0.2.0`.

**Exit**: success criteria #11, #12. ~1.5 wks.

---

## Sequencing & rules

- **Order**: P1 → (P2 ∥ P3) → P4 → P5 → P6. P5's driver refactor (5.1) may
  begin once Phase 1's `ensureSchema`/search storage changes settle, to avoid
  rebasing the DDL twice.
- **Per-phase gate**: full v0.1.0 core suite (176) green + harness UAT Tier A
  (4/4) green + that phase's new tests. No phase merges red.
- **Additive-first**: any breaking change (notably R14 userId, R9 driver
  signatures) is called out in the phase doc and the changeset; provide a
  migration note in release notes (no migration framework until/unless needed —
  see risk R11 in v0.1.0).
- **Estimate**: ~9–11 wks single-dev; ~5–6 with P2∥P3 and P5 sub-tracks
  parallelized.
- **Alpha cadence**: tag `0.2.0-alpha.N` at each phase exit so consumers can
  adopt incrementally; `0.2.0` when all MUSTs in `01-requirements.md` pass.

## Kickoff

Phase 1 is next and highest-leverage (fixes R7, unblocks P2/P3). Detailed,
implementation-ready design in `03-phase1-semantic-search.md`. The only thing
blocking code is the embedding-provider decision (Task 1.0).
