# Phase 5 — Refinement + Final Integration Checklist

## 5.1 — Signal detection in stream

- [ ] `state.skillFeedbackCalls` tracks `skill_feedback` tool calls
- [ ] Chunk observer ignores other tools (no over-collection)
- [ ] Unit test: `state.skillFeedbackCalls` populates when `skill_feedback` fires

## 5.2 — Refinement hook in `processOutputResult`

- [ ] `detectUserCorrection(messages)` regex heuristic
- [ ] `buildRefinementSignals` returns only `failure` + `userCorrection` in MVP
- [ ] `signalsActive` gates the fire-and-forget refinement call
- [ ] Refinement only runs when `state.skillUsed` is set
- [ ] Refinement errors are caught, logged, never thrown

## 5.3 — `SkillRefiner.evaluate`

- [ ] Returns `{ shouldRefine: false }` when no signals
- [ ] Per-skill 60s cooldown via `listVersions` check
- [ ] Patch-level version bump (MVP scope)
- [ ] Returns informative `reason` for every path

## 5.4 — `SkillRefiner.refine`

- [ ] Builds refinement prompt with hard rules
- [ ] Calls aux LLM with `maxTokens: 2500, temperature: 0.2`
- [ ] Reuses `normalizeSynthesisOutput` from Phase 3.4
- [ ] Validates output via `parseSkillDocument` (throws on failure)
- [ ] Runs `scanSkillContent`; aborts on unsafe content
- [ ] Computes `unifiedDiff` against current `skill.content`
- [ ] Atomic: `updateSkill` + `createVersion` in a transaction
- [ ] `skill_versions.diff` and `.reason` populated correctly
- [ ] Updates parent skill's `version` field

## 5.5 — `runRefinement` wrapper

- [ ] Soft-fails when skill no longer exists
- [ ] Honors evaluate's decision before calling refine
- [ ] Properly closed-over in processor factory

## 5.6 — E2E integration test (THE MVP gate)

- [ ] Testcontainers Postgres + mock aux LLM
- [ ] ACT 1: complex task → extraction → 1 skill in storage
- [ ] ACT 2: new thread → skill appears in L0 index
- [ ] ACT 3: agent follows skill, calls `skill_feedback({ outcome: 'success' })` → `success_count` = 1
- [ ] ACT 4: failure case + user correction → refinement → `skill_versions` row + version 1.0.1 + diff non-empty + content contains new pitfall
- [ ] Test is deterministic (mocked aux LLM scripts every call)
- [ ] Test runs in CI without flakes

## 5.7 — Vision criteria report

- [ ] All 13 criteria from `00-vision.md` mapped to passing tests
- [ ] Report committed at `docs/mvp/vision-criteria-report.md`

## 5.8 — Limitations doc

- [ ] `LIMITATIONS.md` at repo root
- [ ] Lists what works today (one user story)
- [ ] Lists non-goals with planned-version targets
- [ ] Lists known issues (FTS dedup coarseness, placeholder substitution dependency)
- [ ] Feedback URL/issue tracker

## v0.1.0 Release gate

- [ ] All 13 vision criteria PASS
- [ ] CI clean (typecheck, lint, all tests)
- [ ] `pnpm build` produces correct `dist/`
- [ ] `pnpm link` against a sandbox consumer works (Tier 2 setup)
- [ ] Changeset prepared and tagged
- [ ] `LIMITATIONS.md` committed
