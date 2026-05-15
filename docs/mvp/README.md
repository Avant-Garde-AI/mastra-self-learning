# MVP Plan — `@avant-garde/mastra-self-learning` v0.1.0

This directory contains the implementation-ready plan for the v0.1.0 MVP. Start with the vision doc, then read the phase docs in order. The checklists are live trackers — work down them as you implement.

## Reading order

1. **[00-vision.md](./00-vision.md)** — Core thesis, MVP scope, 13 success criteria, non-goals. Read this first; it defines the hill the MVP must take.
2. **[risks-and-unknowns.md](./risks-and-unknowns.md)** — 14 integration risks. Read second; the Phase 1 spike (Task 1.0) and Phase 3 architectural decision (Task 3.0) are both flagged here as blockers.
3. **Phase docs**, in order:
   - **[01-phase-storage.md](./01-phase-storage.md)** + [checklist](./01-phase-storage-checklist.md) — Foundation: schema, CRUD, version history, usage tracking, FTS search, parser/scanner hardening.
   - **[02-phase-tools-router.md](./02-phase-tools-router.md)** + [checklist](./02-phase-tools-router-checklist.md) — Tier 1 capability: router + 8 tools + smoke test against a real Agent.
   - **[03-phase-learning-loop.md](./03-phase-learning-loop.md)** + [checklist](./03-phase-learning-loop-checklist.md) — The core value: output processor + extractor + synthesis.
   - **[04-phase-context-injection.md](./04-phase-context-injection.md)** + [checklist](./04-phase-context-injection-checklist.md) — Closing the loop: input processor + fact layer + identity layer + cross-thread recall.
   - **[05-phase-refinement.md](./05-phase-refinement.md)** + [checklist](./05-phase-refinement-checklist.md) — Refinement + final E2E integration test. This phase's E2E test is the MVP exit gate.
4. **[testing-strategy.md](./testing-strategy.md)** — Three-layer test approach (unit / integration / agent-in-the-loop), fixtures, CI setup.

## What this plan delivers

A working closed learning loop for one user story:

> An agent completes a complex multi-tool task. A reusable skill is automatically extracted. On a subsequent similar task, the agent discovers the skill via its L0 index, loads it via `skill_view`, follows the procedure, and the trajectory is recorded as skill usage. If the skill fails or the user corrects the agent, the skill is refined into a new version with a unified diff.

## What this plan does not deliver

See the "Non-goals for MVP" section of [00-vision.md](./00-vision.md). Highlights:
- No semantic search (FTS only)
- No gardening workflows
- No Harness integration
- No eval scorers
- No CLI
- Postgres only (no LibSQL/MongoDB)

These are deferred deliberately. Each has a clear seam in the architecture for slotting back in post-MVP.

## Estimated timeline

| Phase | Duration | Critical path |
|---|---|---|
| Phase 1 — Storage | 1.5 weeks | Task 1.0 spike (blocking) |
| Phase 2 — Tools + Router | 1 week | Tier-1 smoke test against real Agent |
| Phase 3 — Learning Loop | 2–2.5 weeks | Task 3.0 aux LLM decision + extraction E2E test |
| Phase 4 — Context Injection | 1.5–2 weeks | Cross-thread recall test |
| Phase 5 — Refinement + E2E | 1.5 weeks | E2E test in `test/e2e-mvp.test.ts` |

**Total: ~8 weeks for a single experienced TypeScript developer.** Can be compressed with parallel tracks once Phase 1 is done — Phases 3, 4, 5 each have natural seams for splitting work.

## The single most important file

[`05-phase-refinement.md`](./05-phase-refinement.md) §5.6 describes the end-to-end MVP integration test. **If that test passes, the MVP ships.** Everything else exists to make that test debuggable when it fails.
