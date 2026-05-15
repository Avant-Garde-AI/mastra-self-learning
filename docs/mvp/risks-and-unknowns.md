# Integration Risks & Unknowns

This document catalogs every place the MVP plan makes an assumption we have not yet verified, every decision that requires architectural judgment, and every known edge case that needs deliberate handling. Each risk is paired with a mitigation plan and a "when this fires, do this" recovery action.

Read this *before* starting any phase. Update entries as risks resolve.

---

## R1 — Mastra API Surface Assumptions

**Risk level:** High — the MVP can't be built if these are wrong.

The plan was written from `/spec/` files, which describe Mastra APIs from a design view. The actual TypeScript declarations in `@mastra/core` may differ in name, shape, or behavior. As of this writing, `node_modules` are not installed in the repo; we have not inspected the real source.

### Specific API assumptions (and what to do if each is wrong)

| Assumption | Where it appears | What to do if wrong |
|---|---|---|
| `SkillsStorage` domain exists in `@mastra/core@^1.25.0` with CRUD methods (`listSkills`, `createSkill`, `getSkill`, etc.) | Phase 1.2, 1.3 | Own the `skills` table outright. Document in `MASTRA_API_NOTES.md`. Drop the "additive extension" framing — we *are* the storage. |
| `Processor` interface shape: `{ name, processInput?, processOutputStream?, processOutputResult? }` | Phases 3 & 4 | Match whatever the real shape is. The interface name may differ (`InputProcessor`, `OutputProcessor`, separate types). |
| `processOutputStream` receives a mutable `state` object that survives across calls within one request | Phase 3.1 | If state lifecycle differs (e.g., reset per chunk), use a `WeakMap<request, State>` keyed by some request identifier. |
| `MastraMessageV2` is the message type and has a `content: string` field (or structured array) | Phases 3 & 4 | Adapt; particularly the `mergeIntoSystemMessage` helper in 4.3. |
| `ChunkType` discriminator names: `'tool-call'`, `'tool-result'`, `'step-finish'`, `'message-end'` | Phase 3.1 | Match real chunk type names. The accumulation logic is the same regardless. |
| `createTool({ id, description, inputSchema, outputSchema, execute })` is the factory and `execute` receives `{ context, runtimeContext }` | Phase 2.3 | Adapt the destructuring pattern in every tool's `execute`. If the factory is named differently (`Tool.create`, `defineTool`, etc.), follow the real API. |
| Agents accept a `tools: Record<string, Tool>` shape (or compatible) | Phase 2.3 | Match the real shape; `createSelfLearningTools` return type follows. |
| `PostgresStore` exposes a raw query escape hatch (`.db`, `.pool`, `.query`) | Phase 1.1 | If no escape hatch exists, import `pg` directly and construct a parallel pool from the same `DATABASE_URL`. Note this in `MASTRA_API_NOTES.md`. |
| `runtimeContext.get('threadId')` works inside a tool's `execute` | Phases 2.3, 4.4 | If the per-request context API is different, adapt — the intent is "get the current thread ID inside a tool." |
| `inputProcessors` run before Mastra assembles the system message from `agent.instructions` | Phase 4.3 | If they run *after* assembly, our merge strategy works; if *before*, our blocks would be the first system message and Mastra's would be second — adjust ordering. |

### Mitigation

**Mandatory spike (Phase 1, Task 1.0)**: install dependencies, read the real `.d.ts` files, write `packages/core/MASTRA_API_NOTES.md` with answers to every assumption above. Do this before writing any production code.

### Recovery action

If `MASTRA_API_NOTES.md` reveals that more than two of these assumptions are wrong, **stop and renegotiate the MVP scope** with the user. We may need to:
- Pin to a different `@mastra/core` version
- Drop the "additive" framing and own all storage
- Wrap rather than extend in places where extension is impossible

This is the single highest-impact risk in the project. Treat the spike as blocking.

---

## R2 — Auxiliary LLM Invocation Pattern

**Risk level:** High — affects the public API surface of `SelfLearningProcessorOptions`.

The extractor and refiner need to call an LLM from inside the package. Three options:

### Option A — Callback injection

```ts
createSelfLearningProcessor({
  storage,
  generate: async (prompt, opts) => {
    const res = await myLLM.complete(prompt, opts);
    return res.text;
  },
});
```

**Pros:** zero coupling to LLM provider; trivially testable; works in any runtime.
**Cons:** caller must wire up their own LLM client; we lose access to Mastra's credential/routing logic.

### Option B — Mastra model resolution

```ts
createSelfLearningProcessor({
  storage,
  auxiliaryModel: 'anthropic/claude-sonnet-4-20250514',
  mastra, // explicit reference
});
```

The processor calls `mastra.getModel(id)` lazily at invocation time.

**Pros:** reuses Mastra's existing credentials, retries, telemetry; matches Mastra's idiomatic style.
**Cons:** processor needs a `Mastra` reference at construction. The agent that uses this processor is registered *on* the `Mastra` instance — chicken-and-egg. Could be solved via a factory-style late binding (`createSelfLearningProcessor` returns a function that takes `mastra` at runtime), but that's awkward.

### Option C — AI SDK direct

```ts
import { anthropic } from '@ai-sdk/anthropic';
createSelfLearningProcessor({
  storage,
  model: anthropic('claude-sonnet-4-20250514'),
});
```

**Pros:** stable, type-safe contract; Mastra is itself built on AI SDK so users are already familiar; no coupling to Mastra internals.
**Cons:** adds `ai` as an optional peer dep; bypasses Mastra's per-instance tracing unless we manually wire `tracingContext` through.

### Recommendation

**Adopt Option C as primary, Option A as fallback.** Defined as:

```ts
interface AuxiliaryLLMConfig {
  /** AI SDK LanguageModel instance — preferred when available */
  model?: LanguageModel;
  /** Callback escape hatch when model can't be used directly */
  generate?: (prompt: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<string>;
}
```

Internal helper `callAuxiliary(config, prompt, opts)` prefers `model`, falls back to `generate`, throws if neither is set.

### Mitigation

**Phase 3, Task 3.0** locks this in before any extraction code is written. Document in `packages/core/AUXILIARY_LLM.md`.

### Recovery action

If after building with Option C we discover users overwhelmingly want Option B, add it in a minor release. The fallback (Option A) ensures even users on exotic LLM stacks can use the package.

---

## R3 — Token Estimation Accuracy

**Risk level:** Medium — affects how many skills fit in the L0 index, which affects discovery rate.

The MVP uses `Math.ceil(chars / 4)` as the token estimator. This is roughly accurate for English prose tokenized by Anthropic and OpenAI's BPE tokenizers, but breaks down for:

| Content type | Heuristic error |
|---|---|
| Code-heavy skills (lots of identifiers, syntax) | Heuristic overestimates by 20–40% — skills get truncated unnecessarily |
| Non-English content (Chinese, Japanese, etc.) | Heuristic *underestimates* by 50–200% — index blows past budget |
| Skills with long YAML frontmatter | Heuristic close, ±10% |
| Skills with markdown formatting (tables, links) | Heuristic over by 10–20% |

### Mitigation

**MVP behavior:** keep the heuristic. Make it pluggable via the `TokenEstimator` interface (Phase 2.2). Document the known inaccuracies in `LIMITATIONS.md`.

**Post-MVP:** integrate a real tokenizer (`@anthropic-ai/tokenizer`, `gpt-tokenizer`, etc.) that matches the agent's LLM. Allow per-agent estimator configuration.

### When this fires

If a user reports their skill index is being truncated when they "know it should fit", first ask them to test with a real tokenizer; the fix is to swap estimators, not to bump budgets blindly.

### Recovery action

The `TokenEstimator` interface lets us swap in a real tokenizer with a single line of caller code, no API breakage:

```ts
import { tiktokenEstimator } from '@avant-garde/mastra-self-learning/token-budget';

new SkillRouter(storage, config, agentId, tiktokenEstimator);
```

---

## R4 — Storage Backend Compatibility

**Risk level:** Medium — affects which Mastra users can adopt the package.

The MVP commits to Postgres only. The spec lists LibSQL and MongoDB as targets but defers them.

### Postgres-specific features the MVP relies on

| Feature | Postgres syntax | LibSQL equivalent | MongoDB equivalent |
|---|---|---|---|
| Full-text search | `tsvector` + `ts_rank_cd` + `plainto_tsquery` | FTS5 virtual table | `$text` index |
| Generated columns | `GENERATED ALWAYS AS (...) STORED` | Not supported (use triggers) | Computed indexes |
| Vector type | `VECTOR` (pgvector) | None (would need raw float arrays + manual cosine) | Atlas vector index |
| `ON CONFLICT` | Native | `ON CONFLICT` (sqlite ≥3.24) | `upsert: true` |
| `RETURNING *` | Native | Native | Not direct |
| Transactions across multiple statements | Native via `BEGIN`/`COMMIT` | Native (sqlite) | Multi-doc transactions (replica set) |

### Mitigation

**MVP:** Postgres-only. Throw a clear error if a non-Postgres backend is detected at `ensureSchema()` time, with a link to the issue tracker for backend support requests.

```ts
if (!isPostgres(storage)) {
  throw new Error(
    `@avant-garde/mastra-self-learning v0.1.0 supports Postgres only. ` +
    `LibSQL and MongoDB are planned for v0.2.0. ` +
    `Track at github.com/avant-garde-labs/mastra-self-learning/issues/...`
  );
}
```

**Post-MVP:** behind a `StorageDriver` abstraction:

```ts
interface StorageDriver {
  ftsSearch(query: string, opts): Promise<SkillSearchResult[]>;
  upsert(table, row, conflictKeys): Promise<void>;
  // ...
}
```

Implement `PostgresDriver`, `LibSQLDriver`, `MongoDriver`. Each handles backend-specific dialect; the rest of the code is dialect-agnostic.

### When this fires

If a user opens an issue saying "I'm using LibSQL and ensureSchema() failed", the error message above should redirect them cleanly. **Don't half-support other backends in v0.1.0** — half-support is worse than clear refusal.

---

## R5 — Streaming Edge Cases

**Risk level:** Medium — bugs here corrupt extraction.

The output processor observes streaming chunks. Several edge cases need explicit handling.

### 5a — Aborted streams

If the user cancels mid-stream or the LLM connection drops, `processOutputResult` may never be called. The accumulated state is dropped — no extraction. **This is correct behavior**: an aborted stream wasn't a successful task, so we shouldn't learn from it.

**Verify:** ensure the processor doesn't leak `state` in a long-lived map. State should be per-request and garbage-collected when the request ends.

### 5b — Error chunks

If the LLM emits an `error` chunk type mid-stream, treat it as a task failure signal. Continue accumulating; on `processOutputResult`, the heuristic positive-outcome check should already detect failure language. No special handling needed beyond watching that we don't crash on an unexpected chunk type.

### 5c — Tool call retries

If a tool fails and the agent retries the same call, we'll record both calls in `state.toolCalls`. This inflates the count, potentially triggering extraction on what was actually 2 unique tools. **Mitigation:** dedupe by `(name, JSON.stringify(input))` when computing `toolCalls.length` for the policy check, but preserve the full list for synthesis.

```ts
function distinctToolCallCount(calls): number {
  const seen = new Set();
  for (const c of calls) {
    seen.add(`${c.name}:${JSON.stringify(c.input)}`);
  }
  return seen.size;
}
```

### 5d — Multi-turn loops

If the agent enters a planning loop (call tool → reason → call same tool with refined args → reason → ...), turn count inflates without indicating real complexity. The `minToolCalls` threshold partially mitigates this (one tool called five times doesn't look like five distinct skill candidates). Acceptable for MVP.

### 5e — Concurrent streams

If the same agent is invoked from two concurrent requests, each gets its own `processOutputStream` invocation with its own `state`. Mastra's `Processor` interface guarantees per-request state isolation (verify in Task 1.0). If it doesn't, we have to scope state by request ID manually.

### 5f — Empty trajectories

Zero tool calls and one turn (a pure-text response) should never trigger extraction. The `minToolCalls: 5` default handles this. Verify.

### Mitigation

Test cases for each edge case as part of Phase 3 unit tests. Specifically:
- Test 5c: same tool called 3 times with same args → counts as 1 distinct call.
- Test 5e: two concurrent calls to the processor return independent results.
- Test 5f: empty trajectory → extraction not triggered.

---

## R6 — Synthesis Prompt Reliability

**Risk level:** Medium — affects skill quality.

We ask an LLM to produce valid SKILL.md with specific frontmatter and sections. LLMs sometimes:
- Wrap output in code fences (` ```markdown ... ``` `)
- Add conversational preambles ("Here's the skill document:")
- Skip required sections
- Generate invalid YAML
- Leak instance-specific details despite the prompt's instructions

### Mitigation

**Phase 3.4 — `normalizeSynthesisOutput`:** strip code fences and preambles before parsing.

**Phase 3.4 — single retry:** if `parseSkillDocument(output)` throws, retry the synthesis call once with a stricter prompt addition: "Your previous output was unparseable. Output ONLY the SKILL.md content starting with `---`. No code fences, no commentary."

**Phase 3.4 — validation:** after parsing, check the frontmatter has `name`, `description`, `version`. If missing, fail-closed (don't extract).

**Placeholder leakage:** can't be guaranteed at the prompt level. The pre-processing step in `serializeTrajectoryForPrompt` (Phase 3.4) replaces common identifier patterns with placeholders *before* the LLM sees the trajectory. If the LLM later re-introduces them, that's noise we accept in v0.1.0. Document in `LIMITATIONS.md`.

### Recovery action

If extraction quality is poor in real usage, the highest-leverage fix is improving the synthesis prompt (no code changes). Consider keeping the prompt in a separate file (`packages/core/src/skills/prompts/synthesis.md`) so it can be tuned by non-engineers.

---

## R7 — Deduplication Threshold Calibration

**Risk level:** Medium — wrong threshold means duplicate skills or missed updates.

Phase 3.3 uses FTS `ts_rank_cd` for deduplication with a hand-tuned threshold of 0.5. This is not the same unit as the spec's `deduplicationThreshold: 0.85` (which assumes cosine similarity on embeddings).

### Mitigation

**MVP:** ship with `0.5` and a clear note in `LIMITATIONS.md` that dedup quality improves significantly when Phase 6 (semantic search) lands. Monitor real-world results.

**Tuning approach:** for any extracted skill, log the top-3 FTS results with their scores. If we see `> 80%` of new extractions are flagged as duplicates of unrelated skills, lower the threshold. If duplicates are slipping through (rare in early data), raise it.

### Recovery action

Expose the threshold via config (`deduplicationThreshold` already in the schema). A user encountering bad behavior can override before we ship semantic search.

---

## R8 — Refinement Loops

**Risk level:** Low-medium — could spam version history.

If a skill keeps producing failures, we could refine it repeatedly, generating dozens of patch versions for the same underlying issue.

### Mitigation

**Phase 5.3 — per-skill cooldown:** 60 seconds between refinements of the same skill. Implemented via `listVersions(skill.id)[0].createdAt`.

**Post-MVP:** add a per-skill daily/weekly refinement budget. Demote a skill to `status: 'draft'` if it's been refined 5+ times in a week (gardening territory).

### Recovery action

If a user reports version history flooding, the immediate fix is to raise the cooldown duration in their config (post-MVP: expose it). The structural fix is a refinement budget.

---

## R9 — User Identity in Multi-Tenant Apps

**Risk level:** Low for MVP (deferred), high for adoption.

The MVP scopes skills by `agentId` and treats `agentId = null` as "global". This is insufficient for multi-tenant SaaS apps where different end users of the same agent shouldn't see each other's learned skills.

### Mitigation

**MVP:** out of scope. Document in `LIMITATIONS.md` and reference the deferred user-scoped roadmap.

**Post-MVP:** add `userId` to the skills schema and storage filter. Plumb through `runtimeContext.get('userId')` at the tool layer.

### Recovery action

A multi-tenant adopter today can work around by using a different `agentId` per tenant (a hack — pollutes the agent-identity concept — but functional). Document this workaround clearly.

---

## R10 — Composition with Observational Memory

**Risk level:** Medium — could cause cache misses or duplicate context.

The spec describes our processors as composing cleanly with Mastra's Observational Memory. We have not tested this composition.

### Specific concerns

- **Cache invalidation:** if OM updates its observations every turn, and OM's observations sit *below* our blocks in the system prompt, the prefix containing our Identity/Facts/Skills should still cache. Verify.
- **Duplicate context:** if OM's observations mention facts or skills we've already injected, the LLM sees them twice. Wasted tokens, but not incorrect behavior.
- **Ordering races:** what if OM's input processor runs *after* ours and prepends its own system message? Our merge-into-first-system-message logic could attach our blocks to OM's message instead of `agent.instructions`.

### Mitigation

**Phase 4.5** includes an OM-composition integration test if `@mastra/memory` is available. If not, mark as "deferred verification" and ship the MVP with a note.

### Recovery action

If OM composition breaks, the most likely fix is to register our `SkillContextProcessor` with a specific `priority` or `before: 'observational-memory'` ordering hint, assuming Mastra's processor pipeline supports it. Investigate when we hit the issue.

---

## R11 — Database Schema Migration Path

**Risk level:** Medium — affects upgrades from v0.1.0 to v0.2.0.

Our `ensureSchema()` uses `IF NOT EXISTS` for idempotency, but doesn't handle *changes* to existing tables. When v0.2.0 adds, e.g., a `userId` column or changes a constraint, users upgrading from v0.1.0 will need migration logic we haven't built.

### Mitigation

**MVP:** accept that v0.1.0 → v0.2.0 will require manual migration steps documented in release notes. Don't pretend we have a migration framework.

**Post-MVP:** add a `migrations` table that tracks applied migration versions. Each schema change is a numbered migration script.

### Recovery action

For early adopters who hit a schema-change pain point: provide a one-line migration script in release notes, and offer to walk them through the change in GitHub issues.

---

## R12 — Security Scanner False Positives

**Risk level:** Low — surfaces as developer friction.

The regex scanner in `scanSkillContent` (Phase 1.6) flags procedural docs *about* dangerous commands as unsafe. A skill that says "Do not run `rm -rf /`" triggers the destructive-command pattern.

### Mitigation

**MVP:** false positives route the skill to `status: 'draft'`. A human can review and manually promote to `active` via `updateSkill` (the agent can't, since the scanner runs on every update).

**Post-MVP (Phase 7 of full spec):** LLM-based semantic scanner catches the context.

### Recovery action

If users complain that benign skills keep getting flagged, the highest-leverage fix is to tighten the regex patterns to require a verb form (`rm -rf <path>` not `rm -rf` in a quoted context). Iterate based on real data.

---

## R13 — Async Extraction Failure Modes

**Risk level:** Low — UX impact only.

Extraction runs fire-and-forget. If it fails (aux LLM rate-limited, network error, malformed response), the user never knows. Skills silently don't accumulate.

### Mitigation

**MVP:** all errors logged with a clear prefix (`[self-learning]`). The developer running the app sees them in their logs.

**Post-MVP:** expose a metrics counter (`self_learning_extraction_errors_total`) and an OTel span on every extraction attempt.

### Recovery action

If a user reports "I've been running this for a week and have zero extracted skills", check their logs for `[self-learning]` errors first. The most common causes will be aux LLM credential issues or rate limits.

---

## R14 — Concurrent `ensureSchema()` Calls

**Risk level:** Very low.

Two processes calling `ensureSchema()` simultaneously could theoretically race, but Postgres `IF NOT EXISTS` clauses serialize correctly under the default isolation level. No application-level lock needed.

### Mitigation

Verified by Phase 1's idempotency integration test. Run the test in parallel from two test processes to confirm.

### Recovery action

If a real race is observed, wrap `ensureSchema()` in an advisory lock:

```sql
SELECT pg_advisory_lock(<some constant>);
-- DDL
SELECT pg_advisory_unlock(<same constant>);
```

---

## Risk Heat Map

| Risk | Severity | Probability | Mitigation status |
|---|---|---|---|
| R1 — Mastra API assumptions | High | Medium | Spike Task 1.0 (blocking) |
| R2 — Aux LLM pattern | High | Resolved | Decision in Task 3.0 |
| R3 — Token estimation | Medium | High (will happen) | Pluggable estimator |
| R4 — Storage backends | Medium | Resolved by scoping | Postgres-only MVP |
| R5 — Streaming edges | Medium | Medium | Per-edge unit tests in Phase 3 |
| R6 — Synthesis reliability | Medium | High | Retry + validation + prompt iteration |
| R7 — Dedup threshold | Medium | Medium | Hand-tuned + post-MVP semantic |
| R8 — Refinement loops | Low-medium | Low | Per-skill cooldown |
| R9 — Multi-tenant identity | High for adoption | Resolved by scoping | Deferred to v0.2.0 |
| R10 — OM composition | Medium | Low | Phase 4.5 integration test |
| R11 — Schema migration | Medium | Will happen at v0.2.0 | Release notes for now |
| R12 — Scanner false positives | Low | Low | Draft status + future LLM scanner |
| R13 — Async failure modes | Low | Medium | Clear logging |
| R14 — Concurrent schema | Very low | Very low | Postgres handles natively |

The two risks that can actually block the MVP are **R1** (API assumptions) and **R2** (aux LLM pattern). Both are gated by explicit decision tasks (Task 1.0 and Task 3.0). Everything else is mitigation work that doesn't put the timeline at risk.
