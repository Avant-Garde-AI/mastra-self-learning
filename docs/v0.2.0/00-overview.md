# v0.2.0 — Overview

## Where we are

v0.1.0 shipped a complete, verified closed learning loop: detect → extract →
retrieve → refine, against Postgres, with 176 passing core tests, a 13/13
vision-criteria report, a browser-verified dev harness, and a two-tier UAT.
Everything in `docs/mvp/` is done.

v0.1.0 was deliberately narrow. Its `LIMITATIONS.md` lists every conscious
deferral with a target version. **v0.2.0 is the consolidation of that deferred
backlog into a single, dependency-ordered, implementation-ready plan.**

## Thesis for v0.2.0

v0.1.0 proved the loop *works*. v0.2.0 makes it *good*: the retrieval and
deduplication that v0.1.0 does with coarse full-text search become
embedding-grade; the skill library stops decaying because gardening runs on a
schedule; the system becomes observable, measurable, portable, and safe enough
to run unattended in a real multi-tenant deployment.

Single sentence: **v0.2.0 turns a working prototype into an operable product.**

## Goals

1. **Retrieval quality** — semantic + hybrid skill search; the `relevant`
   router overflow strategy; dedup that actually catches near-duplicates
   (closes risk R7).
2. **Library health** — scheduled gardening (dedup, decay, quality, drift) so
   the library improves rather than rots over time.
3. **Memory maturity** — identity drift detection + calibration; the three
   refinement signals v0.1.0 deferred (deviation, new-pitfall, unnecessary-step).
4. **Observability & measurement** — OpenTelemetry spans (built on the
   `onEvent` seam already in place) and the three eval scorers.
5. **Ecosystem & portability** — Hermes import/export CLI; LibSQL + MongoDB
   backends behind a storage-driver abstraction; LLM-based security scan;
   Harness learn mode + subagents (Tier-3).
6. **Hardening** — trust promotion/demotion, multi-tenant user scoping, and the
   small v0.1.0 polish items.

## Non-goals for v0.2.0

- Re-architecting the closed loop. The processor/extractor/refiner/storage
  contracts proven in v0.1.0 are stable; v0.2.0 extends, it does not rewrite.
- A managed cloud service, billing, or auth beyond Mastra's existing surface.
- New skill formats. agentskills.io SKILL.md stays canonical.
- Breaking the v0.1.0 public API where avoidable. Additive first; any breaking
  change is called out explicitly in the relevant phase and the changeset.

## Success criteria (release gate)

v0.2.0 ships when **all** of the following hold:

1. **Semantic/hybrid search**: `SkillSearch` returns embedding-ranked results;
   `mode: 'hybrid'` blends FTS + semantic with configurable weighting; the
   `relevant` router overflow strategy uses real similarity. No more "Phase 4"
   throws anywhere in the public surface.
2. **Dedup works**: the failing case documented in v0.1.0
   (`self-learning-processor.integration.test.ts` "does NOT dedup when
   synthesized skill omits the tool names") now **passes** — a semantically
   similar trajectory is routed to refinement, not stored as a near-duplicate.
3. **Gardening runs**: four scheduled workflows (dedup, decay, quality, drift)
   are registered and individually invocable; an integration test proves each
   mutates state correctly under CAS safety.
4. **Drift measurable**: `IdentityLayer.measureDrift` and `updateCalibration`
   are implemented (no Phase-6 throw); `identityDriftScorer` returns a real
   number.
5. **All three eval scorers** return meaningful values against a seeded
   dataset; `skillUtilizationScorer`, `skillQualityScorer`,
   `identityDriftScorer` are exported and tested.
6. **OTel**: every learning-loop event emits a span; traces visible in a
   connected backend (verified with an in-memory exporter in tests).
7. **Portability**: the storage-driver abstraction lands; LibSQL passes the
   same integration suite Postgres does (MongoDB is best-effort / documented if
   it slips).
8. **Hermes CLI**: `import` / `export` round-trips a real Hermes skill
   directory and a `MEMORY.md` / `SOUL.md`.
9. **Security**: optional LLM-based scan runs after the regex scan; a crafted
   obfuscated-payload fixture that the regex misses is caught.
10. **Harness Tier-3**: a learn-mode integration test drives an explicit
    skill-review session.
11. **No core regressions**: the full v0.1.0 suite (176 tests) still green;
    the v0.1.0 UAT Tier A still 4/4.
12. **Honest docs**: `LIMITATIONS.md` updated; anything that slips past v0.2.0
    is re-deferred with a new target and rationale.

## Phase map (detail in `02-phased-plan.md`)

| Phase | Theme | Headline deliverable | Gated by |
|---|---|---|---|
| 1 | Semantic search & retrieval quality | embedding-grade search + dedup fix | embedding provider decision |
| 2 | Gardening & storage maintenance | 4 scheduled workflows | Phase 1 (semantic dedup) |
| 3 | Memory maturity | drift detection + calibration; 3 refinement signals | Phase 1 (embeddings) |
| 4 | Observability & evals | OTel spans + 3 scorers | Phase 3 (drift scorer) |
| 5 | Ecosystem & portability | Hermes CLI, LibSQL/Mongo, LLM scan, learn mode | storage-driver refactor |
| 6 | Hardening & polish | trust ladder, user scoping, v0.1.0 polish | Phases 1–5 |

Phase 1 is the highest-leverage work: it directly fixes risk R7 and unblocks
Phases 2 and 3. It is the kickoff item — detailed design in
`03-phase1-semantic-search.md`.
