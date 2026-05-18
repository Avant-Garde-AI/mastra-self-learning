# v0.2.0 — Consolidated Requirements

Every deferred item from v0.1.0's `LIMITATIONS.md` and known-issues list,
restated as a numbered requirement with acceptance criteria. The phase column
maps to `02-phased-plan.md`. "Source" is the v0.1.0 artifact that deferred it.

Legend: **MUST** = release gate · **SHOULD** = strongly desired, may slip with
written rationale · **MAY** = opportunistic.

---

## R1 — Semantic skill search  ·  Phase 1 · MUST

Source: `LIMITATIONS.md` row 1; risk R3/R7; `search.ts` "Phase 4" throw.

- R1.1 `SkillSearch.search({ mode: 'semantic' })` embeds the query via the
  configured embedding model and ranks skills by cosine similarity against
  pre-computed skill embeddings.
- R1.2 `mode: 'hybrid'` (the documented default) merges FTS and semantic
  results with a configurable weight (default favouring semantic); ranking is
  stable and deterministic for identical inputs/embeddings.
- R1.3 Skill embeddings are computed on `createSkill` and recomputed on
  `updateSkill` when `name`/`description`/`instructions` change; stored in the
  `embedding` column already conditionally created by `ensureSchema()`.
- R1.4 If pgvector is unavailable, semantic/hybrid degrade to FTS with a single
  logged warning (no throw); `semanticSearchAvailable` reflects reality.
- **Accept**: unit + Testcontainers integration tests; an intent-style query
  ("I need to deploy something") returns the Cloud Run skill ahead of
  unrelated skills.

## R2 — `relevant` router overflow strategy  ·  Phase 1 · MUST

Source: `LIMITATIONS.md` row 2; `router.ts` `recent` fallback.

- R2.1 When the L0 index exceeds `indexBudget`, `overflowStrategy: 'relevant'`
  ranks skills by semantic similarity to the recent conversation and keeps the
  top-fitting set instead of falling back to `recent`.
- R2.2 Falls back to `recent` (with the existing one-time warning) only when no
  embedding model is configured.
- **Accept**: router unit test with a stubbed embedder proves relevance-ordered
  truncation; the one-time-warning fallback path still tested.

## R3 — Deduplication fix (closes R7)  ·  Phase 1 · MUST

Source: v0.1.0 risk R7; the two paired dedup tests.

- R3.1 `SkillExtractor.findDuplicate` uses semantic similarity (cosine) against
  existing skill embeddings with `deduplicationThreshold` (the config field
  that already exists, now in its correct 0–1 cosine unit).
- R3.2 The v0.1.0 test "does NOT dedup when synthesized skill omits the tool
  names" is rewritten to **assert dedup now succeeds** (routes to refinement,
  no near-duplicate stored).
- **Accept**: both dedup integration tests green with the new semantics; FTS
  remains as a cheap pre-filter, semantic as the decider.

## R4 — Scheduled gardening workflows  ·  Phase 2 · MUST

Source: `LIMITATIONS.md` row 3; `workflows/index.ts` stub; `applyDecay()`
exists but unscheduled.

- R4.1 `deduplication` — pairwise semantic similarity > threshold → merge into
  the higher-usage skill, archive the other, write a version entry.
- R4.2 `decay` — run `FactLayer.applyDecay()`; archive facts < floor; deprecate
  skills unused > 90d with successCount < 3; archive deprecated > 180d.
- R4.3 `qualityScoring` — recompute success-rate + trend; flag skills for
  review/refinement; persist a `quality_score` in skill metadata.
- R4.4 `driftDetection` — per agent, compare current vs seed identity (uses
  R7), log + alert when drift > threshold.
- R4.5 All four created via Mastra `createWorkflow()`, registered with the
  scheduler, individually invocable (CLI / learn mode), CAS-safe against live
  extraction/refinement.
- **Accept**: per-workflow integration test mutating real Postgres state;
  concurrent-safety test (gardening + a live `updateSkill`).

## R5 — Identity drift detection + calibration  ·  Phase 3 · MUST

Source: `LIMITATIONS.md` row 4; `identity.ts` Phase-6 throws.

- R5.1 `IdentityLayer.updateCalibration` persists preference deltas to an
  `identity_calibrations` table (added by `ensureSchema()`); within-bounds
  changes are calibration, not drift.
- R5.2 `getCurrentIdentity` returns seed merged with stored calibration.
- R5.3 `measureDrift` returns 0–1 via embedding similarity of current vs seed
  identity (uses R1's embedder).
- **Accept**: unit tests for calibrate→getCurrent merge; integration test for
  drift score monotonicity (more divergence ⇒ higher score).

## R6 — Remaining refinement signals  ·  Phase 3 · SHOULD

Source: `LIMITATIONS.md` row 5; `chunk-observer.ts` `buildRefinementSignals`
hard-codes three signals false.

- R6.1 `deviation` — agent's executed tool sequence diverges from the skill's
  documented Procedure (sequence diff over tool names / step extraction).
- R6.2 `newPitfall` — an error/recovery occurred that the Pitfalls section
  does not cover.
- R6.3 `unnecessaryStep` — a documented step was provably skipped with success.
- R6.4 `signalsActive` widened to honor all five; version-bump severity map
  (patch/minor/major) implemented per `04-learning-loop.md`.
- **Accept**: unit tests driving each signal from a synthetic trajectory +
  skill; refiner picks the correct bump level.

## R7 — OpenTelemetry spans  ·  Phase 4 · MUST

Source: `LIMITATIONS.md` row 8; `onEvent` seam already shipped as precursor.

- R7.1 Each learning event (`extraction.*`, `refinement.*`, skill load, fact
  persist, gardening completion) emits an OTel span with the documented
  attribute names from `09-evaluation.md`.
- R7.2 Spans use the processor's `tracingContext` when present; opt-in via
  config, off by default; `onEvent` continues to work independently.
- **Accept**: tests assert spans via an in-memory exporter; attribute names
  match the spec table.

## R8 — Eval scorers  ·  Phase 4 · MUST

Source: `LIMITATIONS.md` row 7; `evals/index.ts` placeholders.

- R8.1 `skillUtilizationScorer` — ratio of tasks where a relevant skill existed
  and was used.
- R8.2 `skillQualityScorer` — mean Δ success-rate across consecutive versions.
- R8.3 `identityDriftScorer` — cosine(current, seed) (uses R5.3).
- R8.4 All three implement Mastra's `createScorer()` and run inside a
  `dataset.runExperiment`.
- **Accept**: each scorer returns a meaningful number against a seeded dataset
  fixture; exported from `./evals`.

## R9 — Storage-driver abstraction + LibSQL/MongoDB  ·  Phase 5 · MUST (LibSQL) / SHOULD (Mongo)

Source: `LIMITATIONS.md` row 9; risk R4.

- R9.1 A `StorageDriver` interface isolates the Postgres-specific surface
  (`ensureSchema` DDL, FTS query, vector ops, upsert, tx).
- R9.2 `PostgresDriver` is a pure refactor — zero behavior change, v0.1.0 suite
  stays green.
- R9.3 `LibSQLDriver` passes the same `SkillStorageExtension` integration
  suite (FTS5 + manual cosine or sqlite-vec).
- R9.4 `MongoDriver` best-effort; if it slips, document and re-defer.
- **Accept**: the storage integration suite is parameterized and green for
  Postgres + LibSQL.

## R10 — Hermes import/export CLI  ·  Phase 5 · MUST

Source: `LIMITATIONS.md` row 9 (CLI); `spec/10-hermes-migration.md`;
`packages/cli` exists in workspace, unimplemented.

- R10.1 `import --dir`/`--file` ingests agentskills.io SKILL.md (Hermes-
  compatible), `--trust` override, `--dry-run`.
- R10.2 `import-memory` parses `MEMORY.md` → FactLayer (confidence 0.8);
  `import-identity` parses `SOUL.md` → Identity config.
- R10.3 `export` writes agentskills.io, `--strip-mastra`, `--agent` filter.
- R10.4 `list` / `analytics` read-only commands.
- **Accept**: round-trip test (export → import → byte-stable for standard
  fields); a real Hermes fixture imports cleanly.

## R11 — LLM-based security scan  ·  Phase 5 · MUST

Source: `LIMITATIONS.md` row 10; risk R12; `scanner.ts` regex-only.

- R11.1 Optional second-pass scan via the auxiliary LLM after the regex scan;
  catches obfuscated/encoded payloads + social-engineering procedures.
- R11.2 Result merged into `ScanResult`; failure routes to `draft` (same as
  regex today); off by default, opt-in by config.
- **Accept**: a crafted base64/indirection fixture the regex misses is caught;
  benign procedural docs about dangerous commands no longer over-block when
  LLM scan is on.

## R12 — Harness learn mode + subagents (Tier-3)  ·  Phase 5 · SHOULD

Source: `LIMITATIONS.md` row 6; `harness/index.ts` stub;
`spec/06-harness-integration.md`.

- R12.1 `createSelfLearningMode()` returns a real Harness mode with
  learn-focused instructions + task-tracking integration.
- R12.2 Optional explorer/reviewer subagents.
- R12.3 Harness `SelfLearningContext` (`skillsModified`, `factsPersisted`,
  `extractionActive`) exposed via request context.
- **Accept**: a learn-mode integration test runs an explicit skill-review turn
  that creates/refines a skill.

## R13 — Trust promotion / demotion  ·  Phase 6 · SHOULD

Source: `LIMITATIONS.md` post-v0.2.0 row; `spec/07-trust-and-security.md`.

- R13.1 agent-created → community after N successes / 0 fails / clean re-scan.
- R13.2 Demote on re-scan failure or success-rate < 50% over 10+ uses.
- R13.3 Driven by gardening (Phase 2 infra) on a schedule.
- **Accept**: unit tests for the promotion/demotion state machine.

## R14 — Multi-tenant user-scoped skills  ·  Phase 6 · SHOULD

Source: `LIMITATIONS.md` post-v0.2.0 row; risk R9.

- R14.1 `userId` added to skill scope; storage filter `agent_id` ∧ `user_id`
  with the same null-broadening rules as `agent_id` today.
- R14.2 Plumbed from `runtimeContext` at the tool layer.
- **Accept**: integration test — user-A skill invisible in user-B threads,
  global still shared.

## R15 — v0.1.0 polish  ·  Phase 6 · SHOULD

Source: v0.1.0 final analysis "known issues".

- R15.1 Stable YAML key ordering in `serializeSkillDocument` so version diffs
  show only the real learned delta (no frontmatter churn).
- R15.2 `scripts/harness-kill.sh` (kill-by-port) to end the orphaned
  `mastra dev` confusion; referenced from the harness README.
- R15.3 Reconcile `docs/mvp/*-checklist.md` (tick or replace with the
  vision-criteria report) so completion state isn't ambiguous.
- **Accept**: a refinement integration test asserts the diff contains *only*
  the changed body lines; harness README documents the kill script.

---

## Traceability summary

| Req | Phase | Priority | Closes v0.1.0 item |
|---|---|---|---|
| R1 Semantic search | 1 | MUST | LIMITATIONS#1, R3 |
| R2 `relevant` overflow | 1 | MUST | LIMITATIONS#2 |
| R3 Dedup fix | 1 | MUST | risk R7 |
| R4 Gardening | 2 | MUST | LIMITATIONS#3 |
| R5 Drift + calibration | 3 | MUST | LIMITATIONS#4 |
| R6 Refinement signals | 3 | SHOULD | LIMITATIONS#5 |
| R7 OTel | 4 | MUST | LIMITATIONS#8 |
| R8 Scorers | 4 | MUST | LIMITATIONS#7 |
| R9 Drivers/LibSQL | 5 | MUST/SHOULD | LIMITATIONS#9, risk R4 |
| R10 Hermes CLI | 5 | MUST | LIMITATIONS#9 |
| R11 LLM scan | 5 | MUST | LIMITATIONS#10, risk R12 |
| R12 Learn mode | 5 | SHOULD | LIMITATIONS#6 |
| R13 Trust ladder | 6 | SHOULD | LIMITATIONS post#1 |
| R14 User scoping | 6 | SHOULD | LIMITATIONS post#2, risk R9 |
| R15 Polish | 6 | SHOULD | v0.1.0 known issues |
