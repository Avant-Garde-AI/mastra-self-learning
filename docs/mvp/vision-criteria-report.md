# Vision Criteria Report — v0.1.0 MVP Exit Gate

Generated after Phase 5 completion. Maps each of the 13 success criteria from
[`00-vision.md`](./00-vision.md) to the test(s) that prove it.

**Suite status:** 176/176 passing across 16 test files. `pnpm typecheck` clean.
`pnpm build` produces ESM + CJS + d.ts for all 8 entry points.

| # | Criterion | Status | Proven by |
|---|---|---|---|
| 1 | `ensureSchema()` creates all tables on a fresh Postgres; idempotent on second call | **PASS** | `storage-extension.integration.test.ts` → "ensureSchema is idempotent on second call", "creates all auxiliary tables" |
| 2 | Tool surface: all 8 tools exposed with valid input/output schemas | **PASS** | `skill-tools.test.ts` → "returns all 8 tools", "each tool has an inputSchema and outputSchema", "input schemas validate canonical inputs" |
| 3 | L0 injection: first prompt includes Identity + Facts + Skill Index | **PASS** | `skill-context-processor.integration.test.ts` → "assembles Identity → Facts → Skills in order"; `e2e-mvp.test.ts` ACT 2 |
| 4 | L1 retrieval: `skill_view({name})` returns full SKILL.md body | **PASS** | `tools.integration.test.ts` → "skill_view L1 returns full content; L2 returns just the section"; `e2e-mvp.test.ts` ACT 3 |
| 5 | L2 retrieval: `skill_view({name, section})` returns just that section | **PASS** | `tools.integration.test.ts` → same test (L2 branch); `router.test.ts` → "returns only the requested section for L2" |
| 6 | Extraction trigger: qualifying task → `agent-created` skill with required sections, scan passes | **PASS** | `self-learning-processor.integration.test.ts` → "extracts a skill when policy thresholds are met"; `e2e-mvp.test.ts` ACT 1 |
| 7 | Extraction skip (negative): low-tool-call task → no skill, reason logged | **PASS** | `self-learning-processor.integration.test.ts` → "skips extraction below minToolCalls threshold"; `extractor.test.ts` → "skips when minToolCalls not met" |
| 8 | Deduplication: near-identical task → no duplicate skill | **PASS** | `self-learning-processor.integration.test.ts` → "deduplicates on the second similar trajectory"; documented FTS limit in companion test |
| 9 | Usage tracking: `skill_feedback` inserts `skill_usage` row, increments `success_count` | **PASS** | `tools.integration.test.ts` → "skill_feedback increments counters and writes a usage row"; `e2e-mvp.test.ts` ACT 3 |
| 10 | Refinement: `skill_feedback({failure})` → new `skill_versions` row with unified diff, parent version patch-bumped | **PASS** | `refiner.test.ts` → "produces a refined version, persists it with a diff, and bumps the version"; `e2e-mvp.test.ts` ACT 4 |
| 11 | Round-trip recall: skill extracted in thread A appears in L0 index for thread B | **PASS** | `skill-context-processor.integration.test.ts` → "Closed loop — cross-thread skill recall (Vision criterion #11)"; `e2e-mvp.test.ts` ACT 1→2 |
| 12 | No user-visible latency: extraction runs after stream completes | **PASS (by construction)** | `self-learning-processor.integration.test.ts` → "processOutputStream observes chunks without delaying them" + fire-and-forget design (`_waitForPendingExtractions` only needed in tests). See note below. |
| 13 | End-to-end integration test walks criteria 6, 9, 10, 11 deterministically with a mocked aux LLM | **PASS** | `e2e-mvp.test.ts` → "extract → recall → feedback → refine" (the single exit-gate test) |

## Notes

- **Criterion 12** is satisfied by architecture, not by a wall-clock benchmark.
  `processOutputStream` is a synchronous pass-through (returns `args.part`
  unmodified, never awaits). Extraction/refinement run as untracked
  fire-and-forget promises after `processOutputResult` returns the messages.
  The `_waitForPendingExtractions()` helper exists *only* so tests can
  deterministically await the background work; production code never calls it.
  A formal latency benchmark against a real provider is deferred to Phase 6
  observability — it is not an MVP correctness gate.

- **Criterion 8** passes with a documented caveat (risk R7): FTS-based dedup is
  coarser than semantic similarity. When synthesis fully abstracts tool names
  out of the skill body, FTS cannot match them on a later trajectory. Both the
  working path and the limitation are explicitly tested. Semantic dedup is a
  Phase 6 (post-MVP) deliverable.

## Verdict

**All 13 criteria pass. v0.1.0 is shippable per the exit gate defined in
`00-vision.md`.**
