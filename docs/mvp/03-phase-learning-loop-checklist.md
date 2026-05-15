# Phase 3 — Learning Loop Checklist

## 3.0 — Auxiliary LLM decision

- [ ] Read `risks-and-unknowns.md` "aux LLM" section
- [ ] Pick pattern (recommended: Option C + Option A fallback)
- [ ] Write `packages/core/AUXILIARY_LLM.md` documenting the decision
- [ ] Update `SelfLearningProcessorOptions` to include `model` and `generate` fields
- [ ] Implement `buildAuxiliary(options)` helper that resolves to a unified `aux.generate(prompt, opts)` interface

## 3.1 — `processOutputStream`

- [ ] State initialized on first chunk
- [ ] `tool-call` chunks append to `state.toolCalls` with `callId`
- [ ] `tool-result` chunks attach output to matching call
- [ ] `skill_view` / `skill_search` calls set `state.skillUsed`
- [ ] `task_write` / `task_check` calls append to `state.taskTrackingSignals`
- [ ] Turn boundary chunks increment `state.turnCount`
- [ ] All chunks returned unchanged
- [ ] Never calls `abort()`
- [ ] Never awaits
- [ ] Unit tests: 7+ cases

## 3.2 — `processOutputResult`

- [ ] `buildTrajectory()` produces a complete `TaskTrajectory`
- [ ] `detectPositiveOutcome()` heuristics: task tracking, user affirmation regex, error absence
- [ ] Extraction is fire-and-forget (`void runExtraction(...).catch(...)`)
- [ ] Errors logged, never thrown
- [ ] `messages` passed through unchanged
- [ ] `threadId` + `agentId` correctly extracted from runtime context

## 3.3 — `SkillExtractor.evaluate`

- [ ] Cooldown check
- [ ] `minToolCalls` threshold
- [ ] `minTurns` threshold
- [ ] `requirePositiveOutcome` check
- [ ] Generalizability LLM check (parses YES/NO, fail-closed)
- [ ] FTS-based deduplication check (threshold tuned to ts_rank_cd scale)
- [ ] Calls `synthesize` on pass
- [ ] Runs `scanSkillContent` on output; routes to `draft` on fail
- [ ] Stores with `trustTier: 'agent-created'`, correct `metadata.mastra` fields
- [ ] Updates `lastExtractionTime` on success
- [ ] Returns informative `reason` for every code path

## 3.4 — `SkillExtractor.synthesize`

- [ ] `serializeTrajectoryForPrompt` strips identifiers and truncates outputs
- [ ] Synthesis prompt covers all hard rules
- [ ] `normalizeSynthesisOutput` strips code fences and conversational preambles
- [ ] Validates output via `parseSkillDocument`; retries once on parse failure
- [ ] Returns `triggered: false` with reason on second parse failure
- [ ] Unit tests for normalization edge cases (3 failure modes)

## 3.5 — Wire-up

- [ ] `createSelfLearningProcessor` constructs storage, search, extractor once
- [ ] Returns `{ name, processOutputStream, processOutputResult }` matching `Processor` interface
- [ ] `pnpm typecheck` clean

## 3.6 — Integration test

- [ ] Testcontainers Postgres + mock LLM agent setup
- [ ] Positive case: 6 calls, 4 turns, "great, thanks" → skill stored
- [ ] Frontmatter contains correct `metadata.mastra` fields
- [ ] Placeholder substitutions verified (no real project IDs leaked)
- [ ] Negative case: 2 calls → no skill, correct reason logged
- [ ] Dedup case: second similar run → no new skill, dedup reason logged
- [ ] `__waitForPendingExtractions()` helper exposed and used
- [ ] Stream timing within 5% of bare agent (no processors)

## Exit gate

- [ ] Vision criteria #6, #7, #8, #12 pass
- [ ] All extraction reasons surface in logs (no silent failures)
- [ ] Aux LLM errors never reach the user
