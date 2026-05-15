# `@avant-garde/mastra-self-learning` — MVP Vision (v0.1.0)

## Core Thesis

Most "agent memory" systems today fall into one of two buckets:

1. **Conversational memory** — short-term context compression (Mastra's Observational Memory, Letta-style buffers, summarization windows). Excellent for "what did we just talk about?"; useless for "how did I solve this last week?"
2. **Vector RAG over notes** — embed everything, retrieve at query time. Works for facts; fails for *procedures*, because retrieved markdown fragments don't tell an agent *when* to follow a procedure, *what to verify*, or *what mistakes to avoid*.

Hermes Agent (Nous Research, late 2025) demonstrated a third path: agents that **autonomously extract structured, executable procedures** from their own successful task completions, store them in a portable open format (agentskills.io), then progressively disclose them at task start. The agent gets visibly better at recurring work — and the artifacts (skills, facts, identity) are inspectable Markdown files, not opaque embedding blobs.

`@avant-garde/mastra-self-learning` ports that closed learning loop into Mastra. The unique angle is **Mastra-native composition**:

- Hermes is a monolithic CLI. We ship as a set of composable Mastra primitives (processors, tools, storage extension, eval scorers) that a developer drops into an existing `Agent` constructor.
- Hermes assumes one user, one disk. We extend Mastra's `SkillsStorage` domain (Postgres/LibSQL/MongoDB) so the same loop works in a multi-tenant production app.
- Hermes runs the loop synchronously. We use Mastra's `Processor` interface, which observes streaming chunks and fires extraction *after* the user-visible stream completes — zero added latency for the user.

The thesis in one sentence: **agents should accumulate procedural knowledge as a normal side effect of doing their job, and developers should integrate that capability by adding three lines to an `Agent` config.**

## Key Insight (Architecture Rationale)

Four non-obvious design choices anchor the whole system. Understanding *why* each was chosen is critical to keeping the MVP coherent.

### 1. Processors, not wrappers

The natural API would be `withSelfLearning(agent)` — wrap the agent, intercept calls. We rejected this:

- A wrapper hides the agent's true type from TypeScript users (`Agent` vs. `WrappedAgent`).
- Wrappers don't compose with Mastra's existing memory pipeline (OM runs as a processor; if we wrap on the outside, we miss OM's compressed context).
- `processOutputStream` already gives us per-chunk visibility with native streaming-aware state accumulation via `ProcessorState`. We don't need to invent the observation channel.

Processors are Mastra's *documented* extension point for the agent loop. Building on them means we inherit dynamic resolution (function-based processor lists), tracing context propagation, and OM composition for free.

### 2. Extend `SkillsStorage`, don't fork it

Mastra (Feb 2026) ships a `SkillsStorage` domain with CRUD, versioning, a BlobStore (S3 or local), draft→publish workflow, and Studio UI integration. Building a parallel `mastra_self_learning_skills` table would duplicate 60% of the surface area, miss Studio UI for free, and impose a migration tax every time Mastra evolves its schema.

Instead, `SkillStorageExtension` is *additive*: it adds learning-loop metadata (usage counts, trust tiers, extraction provenance, embeddings) to the existing skills domain and bolts on auxiliary tables (`skill_versions`, `skill_usage`, `facts`). When the user opens Mastra Studio, our agent-created skills show up alongside developer-shipped ones, with our extra columns visible.

### 3. Token budgets on skills

A skill library that grows unbounded will starve the context window. The `SkillRouter` enforces three budgets:

- `indexBudget` (default 3000 tokens) — max for the L0 skill index injected into the system prompt
- `activeBudget` (default 8000 tokens) — max for L1/L2 content the agent loads via `skill_view`
- `maxActiveSkills` (default 3) — simultaneous L1 skills

The progressive disclosure model (L0 names → L1 full body → L2 specific section) means we can have a 200-skill library but only pay the token cost of the index + whichever 1-3 skills the agent actually loads for *this* task. Token budgets are the difference between a useful library and a context-killing one.

### 4. Three-layer memory

Hermes's `SOUL.md` / `MEMORY.md` / `skills/` split isn't decoration — it's a deliberate stability/change gradient:

| Layer | Change frequency | Cache friendliness |
|---|---|---|
| Identity (SOUL) | Rarely | Excellent |
| Facts (MEMORY) | Occasionally | Good |
| Skill index (L0) | On skill CRUD | Moderate |
| OM observations | Per-thread | Poor |
| Recent messages | Every turn | Worst |

Ordering the system prompt from most-stable (top) to least-stable (bottom) maximizes prompt prefix cache hits with Anthropic, OpenAI, and any provider that supports prefix caching. Wrong ordering wastes ~$thousands/month in a production deployment.

## MVP Scope (v0.1.0)

The MVP must deliver **one** end-to-end user story:

> An agent completes a complex multi-tool task. A reusable skill is automatically extracted from the trajectory and stored. On a subsequent similar task, the agent discovers the skill via its L0 index, loads it via `skill_view`, follows the procedure, and the trajectory is recorded as skill usage.

That single sentence is the hill the MVP must take. Everything that does not directly contribute to walking that loop end-to-end is deferred.

### In scope for v0.1.0

| Capability | Why it's in |
|---|---|
| `SkillStorageExtension` (Postgres only, with `ensureSchema()`) | Required to persist anything |
| `parseSkillDocument` / `serializeSkillDocument` (already implemented) | Required to round-trip SKILL.md |
| `scanSkillContent` (regex only, already implemented) | Required gate before storing agent-created skills |
| `createSelfLearningTools` — full 6 skill tools + 2 fact tool stubs | Required for the agent to interact with skills |
| `SkillRouter` — `buildIndex()` + `loadSkill()` (no `relevant` overflow, no embeddings) | Required to inject L0 + load L1/L2 |
| `SkillSearch` — FTS only (Postgres `tsvector`) | Required for `skill_search` tool and deduplication |
| `SelfLearningProcessor` (output) — observe, accumulate, fire extraction | Core of the loop |
| `SkillExtractor` — policy gate + generalizability + dedup + synthesis | Core of the loop |
| `SkillContextProcessor` (input) — inject Identity → Facts → L0 | Core of the loop |
| `FactLayer` — `persistFact` / `getRelevantFacts` / `buildFactsBlock` (keyword retrieval, no decay job) | Required for the input processor's middle layer |
| `IdentityLayer` — `buildIdentityBlock()` (static; no drift detection, no calibration) | Required for the input processor's top layer |
| `SkillRefiner` — minimal: signal detection + patch-level version bump on `userCorrection` or `failure` | Closes the loop's "refine" arm so we can demonstrate version history |
| Skill version history (`skill_versions` table, `createVersion`/`listVersions`) | Required to show that refinement produces a diffable record |
| Usage tracking (`skill_usage` table, `recordUsage`, success/fail counters) | Required to show that the agent's success rate is tracked over time |
| `recordUsage` triggered by the `skill_feedback` tool | Required to test the success-counter update |
| One end-to-end integration test that walks the user story | Required to claim "MVP works" |

### Deferred from v0.1.0

| Deferred | Why deferring is safe |
|---|---|
| Semantic skill search (embeddings) | FTS is sufficient for the MVP loop. Embeddings are a Phase 4 quality lift, not a correctness requirement. |
| `relevant` overflow strategy in `SkillRouter` | Falls back to `recent` (default for MVP). Quality only matters once libraries exceed ~60 skills. |
| Gardening workflows (dedup/decay/quality/drift) | The MVP can run for weeks before library health is a real problem. Skipping cron infra removes a large dependency surface (`WorkflowScheduler`). |
| Identity drift detection / calibration storage | The MVP renders a static identity block from config. Drift measurement is an evaluative capability, not a runtime one. |
| Fact confidence decay | Decay is a maintenance feature. Persisting facts at `confidence: 1.0` and never decaying them is fine for v0.1.0. |
| Harness integration (learn mode, subagents) | Tier 3 layers on top of Tier 2. Tier 2 (processors) is the MVP's target. |
| Eval scorers (`skillUtilizationScorer`, `skillQualityScorer`, `identityDriftScorer`) | Scorers measure long-term effectiveness. The MVP success criteria are about plumbing, not statistical lift. |
| OpenTelemetry spans | Worth adding once the loop works. Premature in the MVP. |
| CLI (`import`, `export`, `import-memory`, `import-identity`) | A Postgres `INSERT` script is sufficient for seeding MVP test data. |
| LibSQL and MongoDB backends | We commit to Postgres for the MVP. Abstraction comes after we know what Postgres needs. |
| LLM-based security scan | Regex scanner is the gate. LLM scan is a refinement, not a prerequisite. |
| Approval workflow (draft skills + human review) | MVP defaults to `requireApproval: false` and routes failed-scan skills to `status: 'draft'` for inspection but doesn't ship a UI for it. |
| Trust promotion/demotion | All MVP-extracted skills are `agent-created` and stay there. |
| `skill_create` / `skill_update` as agent-facing tools that bypass the extractor | Implemented, but tested as a developer-facing API. The MVP's "learning" story is automatic extraction, not manual skill creation. |

These deferrals shrink the build surface by roughly half. Every deferred item has a clear seam where it slots back in post-MVP without rework.

## Success Criteria

The MVP is shippable when **every** statement below is testable and true:

1. **Storage:** Calling `ensureSchema()` on a fresh Postgres database creates `skills` (with our added columns), `skill_versions`, `skill_usage`, and `facts` tables. Idempotent — second call is a no-op.
2. **Tool surface:** A Mastra `Agent` with `tools: { ...createSelfLearningTools({ storage }) }` exposes all 8 tools to the LLM, and each tool's `inputSchema` / `outputSchema` validates as expected.
3. **L0 injection:** With a fresh agent and 3 stored skills, the first prompt sent to the LLM includes an Identity block, an (optionally empty) Facts block, and a Skill Index listing the 3 skills.
4. **L1 retrieval:** The agent can call `skill_view({ name: 'gcp-cloud-run-deploy' })` and receive the full SKILL.md body.
5. **L2 retrieval:** The agent can call `skill_view({ name: 'gcp-cloud-run-deploy', section: 'Pitfalls' })` and receive just that section.
6. **Extraction trigger:** Run an agent through a fixture task with 6 tool calls, 4 turns, and a positive final message. After the stream completes, a new `agent-created` skill appears in storage, content includes "When to Use" + "Procedure" + "Verification" sections, security scan passes.
7. **Extraction skip (negative case):** Run the same agent through a task with 2 tool calls. No skill is created, and the extractor logs a reason ("minToolCalls not met").
8. **Deduplication:** With the extracted skill from (6) already in storage, run a near-identical task. Either: (a) no new skill is created and the extractor logs "duplicate detected", or (b) the existing skill receives a refinement entry — never two near-duplicate skills.
9. **Usage tracking:** When the agent calls `skill_feedback({ skillName, outcome: 'success' })`, a row is inserted in `skill_usage` and the `skills.success_count` increments.
10. **Refinement:** When the agent calls `skill_feedback({ outcome: 'failure' })` for a skill it just used, the `SkillRefiner` fires, a new row appears in `skill_versions` with a unified diff, and the parent skill's `version` field is patch-bumped.
11. **Round-trip recall:** Two threads run sequentially. Thread A completes a task that triggers extraction. Thread B starts; the L0 index injected at Thread B's first turn contains the skill extracted in Thread A.
12. **No user-visible latency added:** The agent stream's time-to-first-token and total stream duration are within 5% of the same agent without our processors attached. (Extraction runs after stream completion.)
13. **End-to-end integration test:** A single Vitest integration test runs against a real Postgres instance and walks criteria 6, 9, 10, and 11 in sequence. Test passes deterministically with a mocked auxiliary LLM.

If all 13 are green, v0.1.0 ships.

## Non-Goals for MVP

We explicitly do not promise, build, document, or claim the following in v0.1.0. Each is paired with the reason deferring is safe.

- **Skill quality guarantees** — We make no claims about extracted skill quality beyond "passes security scan." Quality tuning is post-MVP work driven by real usage data.
- **Performance benchmarks** — The MVP must not add user-visible latency, but we publish no throughput, concurrency, or scale claims.
- **Production observability** — No OTel spans, no metrics endpoint, no dashboards.
- **Multi-tenant scoping beyond `agentId`** — User-scoped skills via `RuntimeContext` are deferred.
- **Cross-agent skill sharing policies** — `agentId = null` makes a skill global; that's the only sharing model.
- **Conflict resolution** — If two agents extract overlapping skills, we rely on FTS deduplication catching the second one. Partial-overlap conflicts are unresolved (gardening territory).
- **Migration from Hermes** — No CLI, no `MEMORY.md` importer, no `SOUL.md` parser.
- **Studio UI integrations** — We extend the storage schema such that Studio *can* render our columns, but we do not build any UI ourselves.
- **Backwards compatibility guarantees** — v0.1.0 is alpha. Schemas, exports, and config shapes may break in v0.2.0.

## Boundaries with Mastra

Things Mastra owns that we explicitly will **not** reimplement:

- Message storage and thread lifecycle
- Observational Memory (we *compose with* OM but never observe or modify its observations)
- Tool execution dispatch
- Agent loop control
- LLM provider routing and credentials
- Streaming infrastructure
- Workflow scheduling (deferred entirely from MVP)

If we find ourselves writing code that duplicates one of these, stop and find the Mastra primitive.

## The One Story, Restated

A developer adds three lines to their `Agent`:

```ts
inputProcessors: [createSkillContextProcessor({ storage, identity })],
outputProcessors: [createSelfLearningProcessor({ storage })],
tools: { ...createSelfLearningTools({ storage }) },
```

The agent does its work as usual. Skills appear in storage. The next thread sees them. The user notices the agent stops repeating the same research and starts following procedures it discovered itself.

That is the MVP. Build only what serves it.
