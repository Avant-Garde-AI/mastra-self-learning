# Limitations — v0.1.0 alpha + v0.2.0 Phase 1

`@avant-garde/mastra-self-learning` is an **alpha**. v0.1.0 delivered the
closed learning loop; v0.2.0 Phase 1 added embedding-grade retrieval. This
document states honestly what works, what does not, and what is coming.

## Shipped since v0.1.0 (v0.2.0 Phase 1 — closes R1/R2/R3 + risk R7)

- **Semantic + hybrid skill search** — pgvector cosine over per-skill
  embeddings; `mode: 'hybrid'` blends FTS + semantic; callback `EmbedText`
  seam + shipped `openAIEmbedder`; graceful FTS degrade with no embedder.
- **`relevant` router overflow** — ranks the L0 index by similarity to the
  live conversation; `recent` fallback retained for the no-embedder path.
- **Semantic deduplication (risk R7 CLOSED)** — dedup now runs on the
  *synthesized* skill content (skill↔skill, like-with-like) vs
  `deduplicationThreshold`; the v0.1.0 "near-duplicate slips through" gap is
  gone. Proven by core tests + harness UAT Tier-A A5.

The remaining v0.2.0 backlog (Phases 2–6) is tracked in `docs/v0.2.0/`.

## What works today

The full closed loop, integration-tested against real Postgres:

> An agent completes a complex multi-tool task. A reusable skill is
> automatically extracted from the trajectory and stored with provenance. On a
> subsequent thread, the agent discovers the skill via its L0 system-prompt
> index, loads it via `skill_view`, follows the procedure, and records the
> outcome via `skill_feedback`. If the skill fails or the user corrects the
> agent, the skill is refined into a new version with a stored unified diff.

Concretely shipped and verified (176 passing tests):

- **Storage** — `SkillStorageExtension` over Mastra's `SkillsStorage` domain
  plus four auxiliary tables (stats, usage, facts, FTS projection). Idempotent
  `ensureSchema()`.
- **8 agent tools** — `skill_list`, `skill_view`, `skill_search`,
  `skill_create`, `skill_update`, `skill_feedback`, `memory_persist`,
  `memory_recall` (Tier 1).
- **`SkillRouter`** — L0/L1/L2 progressive disclosure with `recent` / `frequent`
  overflow strategies and a 30 s index cache.
- **`SelfLearningProcessor`** (output) — observes the loop, builds a
  trajectory, fires async extraction + refinement. Zero added user latency.
- **`SkillExtractor`** — policy gate → dedup → generalizability → synthesis →
  scan → store, with one synthesis retry.
- **`SkillContextProcessor`** (input) — injects Identity → Facts → L0 Skills
  into the system prompt; periodic fact-persistence nudge.
- **`FactLayer`** — cross-thread facts with FTS recall, soft-dedup, confidence
  decay (implemented; unscheduled).
- **`IdentityLayer`** — static identity block rendering.
- **`SkillRefiner`** — failure/user-correction-driven refinement with diffed
  version history.

## What is not implemented (deferred, with target versions)

| Capability | Status | Target |
|---|---|---|
| ~~Semantic skill search~~ | ✅ Shipped (v0.2.0 P1) | — |
| ~~`relevant` router overflow~~ | ✅ Shipped (v0.2.0 P1) | — |
| Gardening workflows (dedup/decay/quality/drift cron) | Not implemented; `applyDecay()` exists but is unscheduled | v0.2.0 P2 |
| Identity drift detection / calibration storage | Throws Phase-6 marker | v0.2.0 |
| Refinement signals beyond failure/user-correction (deviation, new-pitfall, unnecessary-step) | Not implemented (require procedure-diffing) | v0.2.0 |
| Harness integration (learn mode, subagents) | Not implemented | v0.2.0 |
| Eval scorers (utilization / quality-trend / drift) | Not implemented | v0.2.0 |
| OpenTelemetry spans | Not emitted | v0.2.0 |
| CLI (import/export, Hermes `MEMORY.md`/`SOUL.md` migration) | Not implemented | v0.2.0 |
| LibSQL / MongoDB backends | Postgres only; non-Postgres is unsupported | v0.2.0 |
| LLM-based security scan | Regex scanner only | v0.2.0 |
| Trust promotion/demotion | All extracted skills stay `agent-created` | post-v0.2.0 |
| Multi-tenant user-scoped skills (beyond `agentId`) | Not implemented | post-v0.2.0 |

## Known issues / sharp edges

1. ~~**FTS deduplication is coarse.**~~ **RESOLVED (v0.2.0 P1, risk R7
   closed).** Dedup now runs on the *synthesized* skill content and compares
   it semantically (cosine) against existing skill embeddings — skill↔skill,
   so abstracted tool names no longer cause near-duplicates to slip through.
   With no embedder configured it degrades to FTS (documented).

2. **Token estimation is a heuristic.** `chars / 4`. Over-estimates for
   code-heavy skills (~20–40%), under-estimates for non-English text
   (50–200%). The `TokenEstimator` interface lets you inject a real tokenizer.
   (Risk R3.)

3. **Synthesis quality depends on the auxiliary LLM.** Placeholder
   substitution (project IDs, secrets) is reinforced by pre-prompt scrubbing
   *and* the synthesis prompt, but an LLM can still reintroduce specifics. A
   failed security scan routes the skill to `status: 'draft'` for human
   review rather than discarding it.

4. **The auxiliary LLM is a required dependency for extraction/refinement.**
   You must pass a `generate` callback (3-line adapter over any AI SDK model).
   Without it, the generalizability gate and synthesis throw
   `AuxiliaryLLMNotConfiguredError`. Tier-1 tools work without it.

5. **Per-skill refinement cooldown defaults to 60 s.** Repeated failures of
   the same skill within 60 s won't each spawn a version. Tunable via
   `refinementCooldownMs`.

6. **Schema migrations are not versioned.** `ensureSchema()` is idempotent for
   *creation* but does not migrate column changes. v0.1.0 → v0.2.0 upgrades
   will require manual migration steps documented in release notes. (Risk R11.)

7. **No backwards-compatibility guarantee.** v0.1.0 is alpha. Schemas,
   exports, and config shapes may break in v0.2.0.

## Verified composition boundaries

- Composes additively with Mastra's developer instructions (our system block
  is appended *after* instructions, preserving the cacheable prefix).
- Designed to compose with Observational Memory but **co-execution with a live
  `@mastra/memory` Observer/Reflector is not yet verified** — deferred.
- `providesSkillDiscovery` is intentionally **not** set, so the package
  coexists with (does not suppress) Mastra-native skill behavior.

## Feedback

Issues and feedback:
<https://github.com/avant-garde-labs/mastra-self-learning/issues>
