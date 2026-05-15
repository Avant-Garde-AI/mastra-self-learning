# Phase 4 — Context Injection Checklist

## 4.0 — Injection strategy

- [ ] Decide injection target (recommended: Option B, merge into existing system message)
- [ ] Document the chosen approach in `INJECTION_STRATEGY.md` or inline JSDoc
- [ ] Verify timing: do `inputProcessors` run before or after Mastra assembles `agent.instructions`?

## 4.1 — `FactLayer`

- [ ] Constructor accepts `(storage, config, agentId?)`
- [ ] `persistFact()` — insert with ULID, agentId, confidence default 1.0
- [ ] `getRelevantFacts(query, limit)` — FTS via `ts_rank_cd`, filters by confidence, agentId, TTL
- [ ] Empty query falls back to confidence-ordered listing
- [ ] `reinforceFact(id)` — resets confidence, updates `last_reinforced`
- [ ] `applyDecay()` — SQL UPDATE, returns affected row count
- [ ] Decay is implemented but NOT scheduled (manual invocation only)
- [ ] `buildFactsBlock()` — formats top-20 by confidence, empty string when no facts
- [ ] Soft dedup: identical content + same agent → reinforce instead of insert
- [ ] Integration tests: persist, recall, reinforce, decay, TTL expiry

## 4.2 — `IdentityLayer`

- [ ] `buildIdentityBlock` extended to include `formatting` block
- [ ] `getCurrentIdentity()` returns seed in MVP
- [ ] `updateCalibration()` throws "Phase 6"
- [ ] `measureDrift()` throws "Phase 6"
- [ ] Unit tests with full + minimal identity

## 4.3 — `SkillContextProcessor`

- [ ] Constructor wires Storage, Router, FactLayer, IdentityLayer
- [ ] Per-instance `turnCount` for nudge mechanism
- [ ] `processInput` assembles Identity + Facts + Skills in order
- [ ] Empty blocks omitted (no trailing `---`)
- [ ] `mergeIntoSystemMessage` handles existing system message
- [ ] `mergeIntoSystemMessage` handles no system message (prepends new one)
- [ ] `mergeIntoSystemMessage` handles structured content arrays (per API notes)
- [ ] Nudge message fires on `turnCount % nudgeInterval === 0`
- [ ] Nudge gated by `factLayer.enabled`
- [ ] Token-budget overflow logs warning (does not truncate)
- [ ] Returns unmodified messages when all blocks are empty

## 4.4 — Memory tools (real)

- [ ] `createSelfLearningTools` constructs internal `FactLayer`
- [ ] `memory_persist` writes a real fact, returns `{ id, persisted: true }`
- [ ] `memory_recall` returns facts filtered by category if provided
- [ ] No more `console.warn` stubs
- [ ] Integration test: persist via tool, recall via tool

## 4.5 — Integration tests

- [ ] System message contains all 3 blocks in correct order
- [ ] Skill index includes pre-seeded skills
- [ ] Facts block includes pre-seeded facts
- [ ] Nudge fires on configured interval
- [ ] **Cross-thread test:** Thread A extracts skill → Thread B sees it in L0 index
- [ ] Composition with OM tested (if `@mastra/memory` available)

## Exit gate

- [ ] Vision criteria #3 (L0 injection) and #11 (round-trip recall) pass
- [ ] All 4 memory layer integration tests pass
- [ ] No truncation of Identity/Facts blocks (warn-only)
- [ ] System message assembly is idempotent across requests
