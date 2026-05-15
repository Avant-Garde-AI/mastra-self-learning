# Phase 2 — Tools + Router Checklist

## 2.1 — `SkillRouter`

- [ ] Constructor accepts `(storage, config, agentId?)`
- [ ] `buildIndex()` — empty library returns "(none yet)" string
- [ ] `buildIndex()` — under-budget returns all skills
- [ ] `buildIndex()` — `recent` overflow strategy works
- [ ] `buildIndex()` — `frequent` overflow strategy works
- [ ] `buildIndex()` — `relevant` falls back to `recent` with one-time warning
- [ ] `buildIndex()` — caches result for ~30s per agent
- [ ] `invalidate()` — clears cache
- [ ] `loadSkill(name)` — L1 returns full content
- [ ] `loadSkill(name, section)` — L2 returns section
- [ ] `loadSkill` returns `null` for missing skill or missing section
- [ ] `suggestSkills()` throws "Phase 4" error
- [ ] Skill with missing description falls back to first body line
- [ ] Unit tests pass (11+ cases)

## 2.2 — Token estimation

- [ ] `heuristicEstimator` (chars/4) implemented
- [ ] `TokenEstimator` interface exported
- [ ] Re-exported from `skills/index.ts` as `estimateTokens`

## 2.3 — Tools

- [ ] Shared `storage`, `search`, `router` instances constructed once per `createSelfLearningTools` call
- [ ] `skill_list` — tags filter, limit, full output shape
- [ ] `skill_view` — L1 default, L2 with section, `{ found: false }` on miss
- [ ] `skill_search` — calls FTS, ranked output
- [ ] `skill_create` — parses, scans, stores, calls `router.invalidate()`, returns scan findings
- [ ] `skill_create` writes `status: 'draft'` when scan flags content
- [ ] `skill_update` — checks existence, persists, creates version row with unified diff, invalidates router cache
- [ ] `skill_feedback` — calls `recordUsage`, soft-fails on missing skill, reads `threadId` from runtime context
- [ ] `memory_persist` — stub with warning, returns `{ persisted: false }`
- [ ] `memory_recall` — stub with warning, returns `{ facts: [] }`
- [ ] `version-utils.ts`: `bumpPatch`, `bumpMinor`, `bumpMajor`, `unifiedDiff` implemented and tested
- [ ] `diff` npm dependency added
- [ ] Per-tool unit tests for input/output schema validation

## 2.4 — Tier-1 smoke test

- [ ] Real `Agent` instantiated with `createSelfLearningTools`
- [ ] Mock LLM strategy chosen and documented
- [ ] Pre-seeded 2 fixture skills round-trip via `skill_list`
- [ ] L1 `skill_view` returns full content
- [ ] L2 `skill_view` returns just the section
- [ ] `skill_search` ranks correctly
- [ ] `skill_feedback` increments `success_count`
- [ ] Test runs deterministically (no time/LLM nondeterminism)

## 2.5 — Exports

- [ ] `pnpm typecheck` clean
- [ ] `pnpm build` produces correct `dist/`
- [ ] `createSelfLearningTools` has proper return type (no `as any`)
- [ ] Public surface compiles against real `@mastra/core` build

## Exit gate

- [ ] Vision criteria #2, #4, #5, #9 pass
- [ ] No `unknown` types remain in tools or router public surface
- [ ] Tier-1 example app (or test fixture) demonstrates a developer flow end-to-end
