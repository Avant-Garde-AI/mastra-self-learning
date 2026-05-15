# Phase 4 — Context Injection (Input Processor + Memory Layers)

## Goal

After this phase, an agent configured with `inputProcessors: [createSkillContextProcessor({ storage, identity })]` has its system prompt automatically prepended with three blocks (Identity → Facts → Skill Index) before the LLM sees any user message. The `memory_persist` and `memory_recall` tool stubs from Phase 2 become real and write through to a working `FactLayer`. The closed loop is now **closed**: skills extracted in Phase 3 become discoverable by the agent in the next thread.

After this phase, the package delivers the full MVP user story end-to-end:

> An agent completes a complex multi-tool task. A reusable skill is automatically extracted (Phase 3). On a subsequent similar task, the agent discovers the skill via its L0 index (this phase), loads it via `skill_view` (Phase 2), follows the procedure, and the trajectory is recorded as skill usage (Phase 2).

## Prerequisites

- Phases 1–3 fully complete.
- `MASTRA_API_NOTES.md` answers the `processInput` signature question and confirms how to access `agentId`/`threadId` from the input processor's context.
- Decision made on **how prompt blocks are injected** into the message list (see Task 4.0).

## Task 4.0 — Decide prompt injection strategy

**Question:** when `processInput` returns the modified message list, where does our context block go?

Three options:

| Strategy | Where the block lives | Pros | Cons |
|---|---|---|---|
| **A — Prepend system message** | New `{ role: 'system' }` at index 0 | Simple; clear separation | If agent already has a system message, do we have two? |
| **B — Merge into existing system message** | Concat onto first message if it's `role: 'system'`; otherwise prepend | One system message; cache-friendly | Must respect Mastra's ownership of the first system message (instructions) |
| **C — Inject before last user message** | Insert as a system-role message just before the most recent user message | Best for "task-time" reminders | Worst cache hit rate; ordering complicates OM composition |

### Recommendation

**Option B — merge into existing system message.**

Rationale:
- Prompt cache hit rates require a stable prefix. Two system messages may or may not get cached as one prefix block depending on the provider.
- The developer-defined `Agent` instructions are the canonical first system message. We append our blocks *underneath* them, with a clear `---` separator and labeled sections.
- Composition with OM: OM's observations are typically injected later in the message list (as ephemeral system messages closer to recent turns), so our static blocks at the top + OM's dynamic blocks lower down doesn't conflict.

The resulting first system message looks like:

```
{Agent.instructions — developer-defined}

---

## Identity

{identity.personality}

**Expertise:** {identity.expertise.join(', ')}

**Guardrails:**
- {guardrail 1}
- {guardrail 2}

---

## Facts

- (preference) User prefers Terraform over ClickOps. [confidence: 1.0]
- (project) Project Atlas is the Q3 migration initiative. [confidence: 0.85]

---

## Available Skills

- gcp-cloud-run-deploy: Deploy a containerized service to Cloud Run with traffic splitting
- k8s-rollback: Rollback a Kubernetes deployment to a previous revision
```

If no existing system message exists, prepend one with just our blocks (no `---` divider at the top).

---

### 4.1 — Implement `FactLayer`

**File:** `packages/core/src/memory/fact-layer.ts`

The `facts` table was created in Phase 1.1. This task wires up the methods.

**Methods to implement:**

```ts
persistFact(fact: Omit<FactEntry, 'id' | 'createdAt' | 'lastReinforced'>): Promise<FactEntry>
getRelevantFacts(context: string, limit?: number): Promise<FactEntry[]>
reinforceFact(id: string): Promise<void>
applyDecay(): Promise<number>  // MVP: implemented but not scheduled
buildFactsBlock(agentId?: string): Promise<string>
```

**Constructor signature:**

```ts
new FactLayer(storage: SkillStorageExtension, config: FactLayerConfig, agentId?: string)
```

(Pass the storage extension, not raw `MastraStorage`. The extension exposes the SQL escape hatch.)

**Logic for `persistFact`:**

```ts
async persistFact(fact) {
  const id = ulid();
  await storage.db.query(
    `INSERT INTO facts (id, agent_id, category, content, confidence, source_thread_id, ttl_seconds, created_at, last_reinforced)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
     RETURNING *`,
    [id, this.agentId ?? null, fact.category, fact.content, fact.confidence ?? 1.0, fact.sourceThreadId, fact.ttl ?? null]
  );
  return rowToFactEntry(result.rows[0]);
}
```

**Logic for `getRelevantFacts(context, limit)`:**

MVP uses keyword retrieval via Postgres FTS over `facts.search_vector`:

```sql
SELECT *,
       ts_rank_cd(search_vector, plainto_tsquery('english', $1)) AS rank
FROM facts
WHERE search_vector @@ plainto_tsquery('english', $1)
  AND ($2::text IS NULL OR agent_id = $2 OR agent_id IS NULL)
  AND confidence >= 0.1
  AND (ttl_seconds IS NULL OR created_at + (ttl_seconds || ' seconds')::interval > now())
ORDER BY rank DESC, confidence DESC
LIMIT $3;
```

If `context` is empty (e.g., first message of a thread), fall back to:

```sql
SELECT * FROM facts
WHERE ($1::text IS NULL OR agent_id = $1 OR agent_id IS NULL)
  AND confidence >= 0.1
ORDER BY confidence DESC, last_reinforced DESC
LIMIT $2;
```

**Logic for `reinforceFact(id)`:**

```sql
UPDATE facts
SET confidence = 1.0, last_reinforced = now()
WHERE id = $1;
```

**Logic for `applyDecay()`:**

Implementable in MVP but **not scheduled**:

```sql
UPDATE facts
SET confidence = confidence * power(1 - $1, EXTRACT(epoch FROM (now() - last_reinforced)) / 604800)
WHERE confidence > 0.1;
```

Returns the count of facts whose confidence was updated. The MVP exposes this method for manual invocation (`harness.runDecay()` or a script); it does **not** wire up a cron. Gardening workflows are a deferred non-goal.

**Logic for `buildFactsBlock(agentId?)`:**

```ts
async buildFactsBlock(agentId?) {
  const facts = await this.getRelevantFacts('', 20); // top-20 by confidence
  if (facts.length === 0) return ''; // No header if empty
  const lines = facts.map(f =>
    `- (${f.category}) ${f.content} [confidence: ${f.confidence.toFixed(2)}]`
  );
  return `## Facts\n\n${lines.join('\n')}`;
}
```

Empty block returns empty string so the calling processor can skip the `---` separator cleanly.

**Edge cases:**

- **Fact deduplication:** When the agent persists "User prefers Terraform" twice, store both (avoid spending an LLM call to detect dupes). Decay + gardening will compress later. For MVP, the second `persistFact` of identical content can short-circuit by checking `SELECT FROM facts WHERE content = $1 AND agent_id = $2` and calling `reinforceFact` instead.

**Testing:**

- Integration test: persist 5 facts, recall by keyword, assert ranking.
- Integration test: reinforce a fact, verify confidence resets to 1.0.
- Integration test: insert old fact, run `applyDecay`, verify confidence dropped.
- Integration test: TTL'd fact past its TTL → not returned by `getRelevantFacts`.

---

### 4.2 — Implement `IdentityLayer`

**File:** `packages/core/src/memory/identity.ts`

**MVP scope:** static identity rendering only. No drift detection. No calibration storage. The identity passed at construction time is what gets rendered, every time.

**Methods:**

```ts
buildIdentityBlock(identity: Identity): string  // already implemented in scaffold
getCurrentIdentity(agentId: string): Promise<Identity>  // returns the seed for MVP
updateCalibration(): Promise<void>  // throws "Phase 6"
measureDrift(): Promise<number>  // throws "Phase 6"
```

**Existing `buildIdentityBlock` implementation needs minor extension** — current code skips `formatting` block. Add:

```ts
if (identity.formatting) {
  parts.push(
    `**Formatting:** ${identity.formatting.defaultLength} responses, ` +
    `${identity.formatting.codeStyle} code, ` +
    `${identity.formatting.listPreference} lists`
  );
}
```

**`getCurrentIdentity(agentId)`:** MVP returns `this.seedIdentity` unchanged. Phase 6 will read from a `identity_calibrations` table.

**Testing:**

- Unit test: identity with all fields → block contains all expected sections.
- Unit test: identity with minimal fields (just `personality`) → block contains only that section.
- Unit test: `updateCalibration` and `measureDrift` throw with Phase-6 messages.

---

### 4.3 — Implement `SkillContextProcessor.processInput`

**File:** `packages/core/src/processors/skill-context-processor.ts`

**Mastra surface:** `Processor.processInput({ messages, abort, tracingContext }) => Promise<MastraMessageV2[]>`.

**Constructor wiring:**

```ts
export function createSkillContextProcessor(options: SkillContextProcessorOptions) {
  const storage = options.storage instanceof SkillStorageExtension
    ? options.storage
    : new SkillStorageExtension(options.storage);
  const router = new SkillRouter(
    storage,
    SkillRouterConfigSchema.parse(options.skillRouter ?? {}),
    options.agentId  // accept agentId in options
  );
  const factLayer = new FactLayer(
    storage,
    FactLayerConfigSchema.parse(options.factLayer ?? {}),
    options.agentId
  );
  const identityLayer = new IdentityLayer(
    storage,
    IdentityLayerConfigSchema.parse({}),
    options.identity ?? { personality: '', expertise: [], formatting: {}, guardrails: [] }
  );
  let turnCount = 0; // for nudge mechanism

  return {
    name: 'skill-context',

    async processInput({ messages, runtimeContext }) {
      turnCount++;

      const agentId = options.agentId ?? runtimeContext?.get?.('agentId');

      const identityBlock = options.identity
        ? identityLayer.buildIdentityBlock(options.identity)
        : '';
      const factsBlock = options.factLayer?.enabled !== false
        ? await factLayer.buildFactsBlock(agentId)
        : '';
      const skillIndex = await router.buildIndex();

      const blocks = [identityBlock, factsBlock, skillIndex].filter(Boolean);
      if (blocks.length === 0) return messages;

      const ourContext = blocks.join('\n\n---\n\n');
      const merged = mergeIntoSystemMessage(messages, ourContext);

      // Nudge mechanism (Phase 4)
      const nudgeInterval = options.factLayer?.nudgeInterval ?? 10;
      if (
        options.factLayer?.enabled !== false &&
        nudgeInterval > 0 &&
        turnCount % nudgeInterval === 0
      ) {
        merged.push({
          role: 'system',
          content: '[Self-Learning Note: If the user has shared any new facts about their environment, preferences, or projects, consider persisting them via the memory_persist tool.]',
        });
      }

      return merged;
    },
  };
}
```

**`mergeIntoSystemMessage(messages, ourContext)`:**

```ts
function mergeIntoSystemMessage(messages, ourContext): MastraMessageV2[] {
  if (messages.length > 0 && messages[0].role === 'system') {
    const first = messages[0];
    const newFirst = {
      ...first,
      content: typeof first.content === 'string'
        ? `${first.content}\n\n---\n\n${ourContext}`
        : /* handle structured content array — see API notes */,
    };
    return [newFirst, ...messages.slice(1)];
  }
  // No pre-existing system message — prepend ours
  return [{ role: 'system', content: ourContext }, ...messages];
}
```

**Critical:** `MastraMessageV2`'s `content` field may be structured (array of parts) rather than a plain string. Handle both forms. The API spike output should specify.

**Token budget enforcement:** the assembled blocks should respect `indexBudget + identity tokens + facts tokens`. If the total exceeds a soft cap (default: `indexBudget + 2000`), log a warning and let it through — we don't truncate identity/facts because that would corrupt agent behavior. Truncation of the skill index is already handled by `SkillRouter`.

**Caching consideration:** `router.buildIndex()` caches for 30s (Phase 2.1). `factLayer.buildFactsBlock()` does **not** cache yet — facts change as the agent persists new ones mid-thread. If profiling reveals this is hot, add caching with explicit invalidation on `memory_persist` calls.

---

### 4.4 — Wire `memory_persist` and `memory_recall` real implementations

**File:** `packages/core/src/tools/skill-tools.ts` (modify the stubs from Phase 2.3)

The stubs need to become real. But `createSelfLearningTools` doesn't currently take a `FactLayer` — Phase 2 didn't have one. Two options:

| Option | Description |
|---|---|
| **A** | `createSelfLearningTools` constructs its own `FactLayer` internally | 
| **B** | Caller passes a `factLayer?` option |

**Recommended: Option A** — simpler caller API, consistent with how `SkillRouter` / `SkillSearch` are constructed internally. The `createSelfLearningTools({ storage, agentId })` signature doesn't change.

```ts
const factLayer = new FactLayer(
  storage,
  FactLayerConfigSchema.parse({}),
  options.agentId
);
```

**Real `memory_persist`:**

```ts
execute: async ({ context, runtimeContext }) => {
  const fact = await factLayer.persistFact({
    category: context.category,
    content: context.content,
    confidence: 1.0,
    sourceThreadId: runtimeContext?.get?.('threadId') ?? 'unknown',
    ttl: null,
  });
  return { id: fact.id, persisted: true };
}
```

**Real `memory_recall`:**

```ts
execute: async ({ context }) => {
  const facts = await factLayer.getRelevantFacts(context.query, context.limit);
  const filtered = context.category
    ? facts.filter(f => f.category === context.category)
    : facts;
  return {
    facts: filtered.map(f => ({
      id: f.id,
      category: f.category,
      content: f.content,
      confidence: f.confidence,
    })),
  };
}
```

The previous stub `console.warn` calls are removed.

---

### 4.5 — Phase 4 integration test

**File:** `packages/core/src/processors/skill-context-processor.test.ts`

**Test plan:**

1. **Setup:** Testcontainers Postgres, fresh schema. Pre-seed 3 skills and 2 facts.
2. Construct an `Agent` with both processors (Phase 3 + Phase 4) attached.
3. Configure a mock LLM that captures the messages it receives, then returns a no-op response.
4. Send a message to the agent. Capture the system message the LLM saw.
5. Assert:
   - System message contains `## Identity` followed by the personality string.
   - System message contains `## Facts` with both pre-seeded facts.
   - System message contains `## Available Skills` with all 3 skills.
   - Ordering: Identity → Facts → Skills.
6. Send 10 messages back-to-back. Assert that turn 10 includes the nudge message.

**Cross-thread test:**

7. Run a thread that triggers Phase 3 extraction (reuse Phase 3 integration test setup). Extract a skill.
8. Start a new thread with the same agent. Capture the first system message.
9. Assert the newly extracted skill appears in `## Available Skills`.

This last test is **Vision criterion #11** — the "round-trip recall" gate.

---

## Critical Integration Points

1. **`processInput` argument shape.** If `runtimeContext` isn't available the way 4.3 assumes, the nudge mechanism and `agentId` resolution change. Adapt to actual signature.

2. **`MastraMessageV2.content` shape.** String vs. structured parts. `mergeIntoSystemMessage` must handle both.

3. **First system message ownership.** If Mastra builds the system message later in the pipeline (e.g., from `agent.instructions` after our processor runs), our merge strategy may inject context too early. Verify the order: do `inputProcessors` run before or after Mastra assembles instructions? Confirm via API notes; adjust merge strategy if needed.

4. **Composition with OM.** When OM is active, its observations are typically injected as system messages further into the message list. Our processor runs *first*; OM's processor runs after. The composition test in 4.5 should verify this works (test with `@mastra/memory` enabled in a follow-up if time permits).

## Exit Criteria

- [ ] `pnpm typecheck` clean.
- [ ] `FactLayer` integration tests pass (persist, recall, reinforce, decay, TTL).
- [ ] `IdentityLayer` unit tests pass.
- [ ] `SkillContextProcessor` integration test 4.5 passes (system message assembly).
- [ ] Cross-thread test 4.5.7–9 passes — Vision criterion #11.
- [ ] Vision criterion #3 (L0 injection) passes.
- [ ] Vision criterion #11 (round-trip recall) passes.
- [ ] Nudge mechanism fires on the configured interval.
- [ ] `memory_persist` / `memory_recall` tools write/read real facts.

## Estimated Scope

| Sub-task | Files touched | Complexity |
|---|---|---|
| 4.0 Injection strategy | New: `INJECTION_STRATEGY.md` (notes) | Architectural — half day |
| 4.1 FactLayer | `fact-layer.ts`, `fact-layer.test.ts` | Medium |
| 4.2 IdentityLayer | `identity.ts`, `identity.test.ts` | Low |
| 4.3 SkillContextProcessor | `skill-context-processor.ts`, new: `merge-system.ts` | High |
| 4.4 Memory tools real impl | `skill-tools.ts` | Low |
| 4.5 Integration test | New: `skill-context-processor.test.ts` | High |

**Total:** 6 files written/modified. Estimated 1.5–2 weeks. Highest-risk task is 4.3 (correctly merging into a possibly-structured system message). Highest-value test is 4.5.7–9 (cross-thread recall — the moment the loop closes).
