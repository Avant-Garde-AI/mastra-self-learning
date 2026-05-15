# Phase 3 — Learning Loop (Output Processor + Extraction)

## Goal

After this phase, an agent configured with `outputProcessors: [createSelfLearningProcessor({ storage, model })]` automatically extracts a reusable `agent-created` skill from any task completion that meets the `ExtractionPolicy` thresholds. The extraction runs asynchronously after the user-visible stream completes — zero added latency. Duplicate skills are detected and routed to a no-op (refinement comes in Phase 5). Extracted skills appear in storage and are immediately visible to `skill_list` (Phase 2).

This is the **core value** of the package. After this phase, the package has earned the word "self-learning."

## Prerequisites

- Phase 1 and Phase 2 fully complete.
- `MASTRA_API_NOTES.md` answers the `Processor`, `processOutputStream`, `processOutputResult`, `ProcessorState`, `ChunkType`, and `MastraMessageV2` questions.
- A decision made on the **auxiliary LLM invocation pattern** (see Task 3.0).

## Task 3.0 — Decide auxiliary LLM invocation (architectural)

**Why this is first:** the extractor and refiner need to call an LLM from inside a processor. Three patterns are possible (see `risks-and-unknowns.md`). The whole phase's API surface depends on which we pick.

### Options

| Option | Pattern | Pros | Cons |
|---|---|---|---|
| **A — Callback injection** | Config accepts `generate: (prompt, opts) => Promise<string>` | Backend-agnostic; no Mastra coupling beyond what's already there; testable trivially | Caller has to wire it up; can't auto-resolve from agent config |
| **B — Mastra model resolution** | Config accepts a model ID string; resolve via `mastra.getModel(id)` at call time | Reuses agent's existing credentials and routing | Requires a `Mastra` instance reference at processor-construction time; processor lifecycle may not have access |
| **C — AI SDK direct** | Config accepts an AI SDK `LanguageModel` instance; call `generateText({ model, prompt })` directly | Type-safe; doesn't depend on Mastra's resolver | Adds `ai` as a dependency; bypasses Mastra's tracing/logging unless we add it manually |

### Recommendation

**Option C — AI SDK direct**, with **Option A as fallback escape hatch**.

Rationale:
- Mastra is built on the AI SDK; nearly every Mastra user already has an `ai` package import.
- `LanguageModel` is a stable, well-typed contract from the AI SDK.
- It avoids the chicken-and-egg of "the processor needs the agent that needs the processor."
- It puts no constraints on Mastra's internal API — minimum coupling.
- The callback option (A) gives us a clean escape hatch for users who want full control or to mock in tests.

### Decision artifact

After this task: a 1-pager `packages/core/AUXILIARY_LLM.md` documenting the chosen pattern and config shape:

```ts
interface AuxiliaryLLMConfig {
  /** AI SDK LanguageModel instance — preferred */
  model?: LanguageModel;
  /** Alternative: a callback that returns generated text. Used when `model` is not provided. */
  generate?: (prompt: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<string>;
}
```

`SelfLearningProcessorOptions` extends `AuxiliaryLLMConfig`. The internal `callAuxiliary(prompt, opts)` helper picks `model` first, then `generate`, then throws.

**Until this artifact exists, do not start tasks 3.1–3.5.** They each assume this shape.

---

### 3.1 — Implement `SelfLearningProcessor.processOutputStream`

**File:** `packages/core/src/processors/self-learning-processor.ts`

**Mastra surface used:** `Processor` interface from `@mastra/core`, with `processOutputStream({ part, streamParts, state, abort }) => ChunkType | null | undefined`.

**Responsibility:** observe streaming chunks during the agent loop and accumulate `TaskTrajectory` data in `state`. Pass through all chunks unchanged.

**State shape (what we put in `state`):**

```ts
interface SelfLearningProcessorState {
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    output?: unknown;
    timestamp: string;
    callId?: string;  // to match tool-call → tool-result
  }>;
  turnCount: number;
  skillUsed: { name: string; section?: string } | null;
  taskTrackingSignals: Array<{ tool: 'task_write' | 'task_check'; data: unknown }>;
  startedAt: number;  // performance.now()
}
```

**Logic:**

```ts
processOutputStream({ part, state, abort }) {
  // Initialize state on first chunk
  if (!state.toolCalls) {
    state.toolCalls = [];
    state.turnCount = 0;
    state.skillUsed = null;
    state.taskTrackingSignals = [];
    state.startedAt = Date.now();
  }

  if (part.type === 'tool-call') {
    state.toolCalls.push({
      name: part.toolName,
      input: part.args,
      callId: part.toolCallId,
      timestamp: new Date().toISOString(),
    });

    if (part.toolName === 'skill_view' || part.toolName === 'skill_search') {
      state.skillUsed = { name: part.args.name, section: part.args.section };
    }

    if (part.toolName === 'task_write' || part.toolName === 'task_check') {
      state.taskTrackingSignals.push({ tool: part.toolName, data: part.args });
    }
  }

  if (part.type === 'tool-result') {
    const call = state.toolCalls.find(c => c.callId === part.toolCallId);
    if (call) call.output = part.result;
  }

  if (part.type === 'step-finish' || part.type === 'message-end') {
    state.turnCount = (state.turnCount ?? 0) + 1;
  }

  return part; // Pass through unchanged
}
```

**Critical:** the exact chunk type names (`tool-call`, `tool-result`, `step-finish`, `message-end`) depend on what `ChunkType` actually emits — confirmed by Task 1.0's notes. If names differ, adjust.

**Streaming-safe constraints:**
- **Never** call `abort()`. We observe; we don't transform.
- **Never** await anything. The processor must be synchronous-fast or the user-visible stream stalls.
- **Don't** mutate `part`. Return it unchanged.

**Testing (unit, no real agent):**
- Feed a sequence of mock `ChunkType` parts into the processor function.
- Assert `state.toolCalls.length` increments correctly.
- Assert `state.skillUsed` is set when `skill_view` fires.
- Assert `state.taskTrackingSignals` records `task_write` / `task_check`.
- Assert all parts are returned unchanged.

---

### 3.2 — Implement `SelfLearningProcessor.processOutputResult`

**File:** Same as 3.1.

**Responsibility:** after the agent loop terminates, build a `TaskTrajectory`, hand it to the `SkillExtractor`, and (in Phase 5) the `SkillRefiner`. Fire-and-forget — never block the response.

**Logic:**

```ts
async processOutputResult({ messages }) {
  const state = /* access ProcessorState — see API notes */;
  const trajectory = buildTrajectory(state, messages);

  // Fire and forget — never block the user-visible response
  void runExtraction(trajectory).catch(err => {
    console.error('[self-learning] extraction error:', err);
  });

  return messages;
}
```

**`buildTrajectory(state, messages)` logic:**

```ts
function buildTrajectory(state, messages): TaskTrajectory {
  const lastUserMessage = messages.findLast(m => m.role === 'user')?.content ?? '';
  const lastAssistantMessage = messages.findLast(m => m.role === 'assistant')?.content ?? '';
  return {
    toolCalls: state.toolCalls,
    turnCount: state.turnCount,
    positiveOutcome: detectPositiveOutcome(messages, state),
    threadId: /* read from somewhere — see runtimeContext question */,
    agentId: /* same */,
    conversationSummary: undefined, // Phase 4 may populate via OM
  };
}
```

**`detectPositiveOutcome` heuristics:**

This is *cheap* heuristic detection — no LLM call. Sources:

1. **Task tracking signals (strongest):** if `state.taskTrackingSignals` contains a `task_check` with `status: 'complete'` for every `task_write` issued, that's a strong yes.
2. **User affirmation tokens** in the most recent user message: regex match on `/^(thanks|thank you|perfect|great|awesome|nice|works|that worked|excellent)/i`.
3. **No error in last assistant message:** absence of words like `failed`, `error`, `couldn't`, `sorry, I was unable`.

Default to `false` if no signal fires. The `requirePositiveOutcome` policy gate decides whether `false` blocks extraction.

This intentionally over-blocks rather than over-extracts. The cost of missing an extraction is "we don't learn from this task." The cost of false-positive extraction is "we store noise."

**`runExtraction(trajectory)` logic:**

```ts
async function runExtraction(trajectory: TaskTrajectory) {
  const result = await extractor.evaluate(trajectory);
  // Log result — `triggered: true/false` + reason
  // Refinement: skip in MVP for Phase 3; wire in during Phase 5.
}
```

**Critical:** `runExtraction` runs *after* the stream completes. It does not delay the user's response. If it crashes, the error is logged but the user is unaffected.

---

### 3.3 — Implement `SkillExtractor.evaluate`

**File:** `packages/core/src/skills/extractor.ts`

**Logic:**

```ts
async evaluate(trajectory: TaskTrajectory): Promise<ExtractionResult> {
  // 1. Cooldown
  if (Date.now() - this.lastExtractionTime < this.policy.cooldownMs) {
    return { triggered: false, reason: 'cooldown active' };
  }

  // 2. Thresholds
  if (trajectory.toolCalls.length < this.policy.minToolCalls) {
    return { triggered: false, reason: 'minToolCalls not met' };
  }
  if (trajectory.turnCount < this.policy.minTurns) {
    return { triggered: false, reason: 'minTurns not met' };
  }
  if (this.policy.requirePositiveOutcome && !trajectory.positiveOutcome) {
    return { triggered: false, reason: 'positiveOutcome required and absent' };
  }

  // 3. Generalizability check (auxiliary LLM)
  if (this.policy.useGeneralizabilityCheck) {
    const generalizable = await this.checkGeneralizability(trajectory);
    if (!generalizable) {
      return { triggered: false, reason: 'generalizability check failed' };
    }
  }

  // 4. Deduplication
  const dupe = await this.findDuplicate(trajectory);
  if (dupe) {
    return {
      triggered: false,
      reason: `duplicate of skill ${dupe.name} (score ${dupe.score.toFixed(2)})`,
      skill: dupe.skill,
    };
  }

  // 5. Synthesis
  const skillContent = await this.synthesize(trajectory);

  // 6. Security scan
  const scan = scanSkillContent(skillContent);
  const status: 'active' | 'draft' = scan.safe ? 'active' : 'draft';

  // 7. Parse and store
  const { frontmatter } = parseSkillDocument(skillContent);
  const skill = await this.storage.createSkill({
    name: frontmatter.name,
    version: frontmatter.version ?? '1.0.0',
    content: skillContent,
    frontmatter: {
      ...frontmatter,
      metadata: {
        ...(frontmatter.metadata ?? {}),
        mastra: {
          agentId: trajectory.agentId,
          threadOrigin: trajectory.threadId,
          extractionTrigger: 'auto',
        },
      },
    },
    trustTier: 'agent-created',
    status,
    successCount: 0,
    failCount: 0,
    agentId: trajectory.agentId,
  });

  this.lastExtractionTime = Date.now();
  return {
    triggered: true,
    reason: `extracted (scan: ${scan.safe ? 'pass' : 'fail → draft'})`,
    skill,
  };
}
```

**`checkGeneralizability(trajectory)` prompt:**

```
You are evaluating whether a recent agent task represents a reusable procedure
worth documenting as a skill.

Task summary:
- {N} tool calls: {tool_names_summary}
- {M} turns
- Most-used tools: {top_3_tool_names}
- Last user message: "{truncated_user_message}"

Answer with a single token: YES or NO.

Choose NO if any of the following apply:
- The task involved one-off data entry, lookups, or content generation
- The work is too instance-specific to generalize (no transferable steps)
- The "procedure" amounts to "call one tool with these specific arguments"
- The work was primarily reasoning or writing, not procedural

Choose YES if:
- The agent followed a multi-step process that could apply to similar future tasks
- The steps involved planning, verification, or recovery from intermediate state
- Another instance of this kind of task would benefit from these steps
```

Use the auxiliary LLM with `maxTokens: 5, temperature: 0`. Parse the response with `toUpperCase().includes('YES')`. Default to `false` on any error (fail closed).

**`findDuplicate(trajectory)` logic:**

```ts
async findDuplicate(trajectory: TaskTrajectory): Promise<{ skill: SkillRecord; score: number; name: string } | null> {
  // FTS only in MVP — semantic comes in Phase 6.
  const query = trajectory.toolCalls
    .map(c => c.name)
    .slice(0, 10)
    .join(' ');
  if (!query.trim()) return null;

  const results = await this.search.search({
    query,
    mode: 'fts',
    limit: 1,
    agentId: trajectory.agentId,
  });
  if (results.length === 0) return null;

  const top = results[0];
  // Crude similarity threshold for FTS — `ts_rank_cd` scores aren't 0-1 bounded,
  // but a normalized threshold works empirically. Tune in real usage.
  if (top.score > 0.5) {
    return { skill: top.skill, score: top.score, name: top.skill.name };
  }
  return null;
}
```

**Note on FTS-vs-semantic similarity:** the spec's `deduplicationThreshold: 0.85` is cosine-similarity for embeddings. FTS `ts_rank_cd` is a different unit. For MVP, use a hand-tuned threshold (0.5 above) and document that this is a coarser dedup signal than Phase 6's semantic version.

---

### 3.4 — Implement `SkillExtractor.synthesize`

**File:** Same as 3.3.

**Logic:**

```ts
private async synthesize(trajectory: TaskTrajectory): Promise<string> {
  const serialized = serializeTrajectoryForPrompt(trajectory);
  const prompt = buildSynthesisPrompt(serialized);
  const raw = await this.aux.generate(prompt, { maxTokens: 2000, temperature: 0.2 });
  return normalizeSynthesisOutput(raw);
}
```

**`serializeTrajectoryForPrompt`:**

Trim each tool call to the bare minimum: `name`, top-level keys of `input`, short string of `output` (truncated to 200 chars). Skip identifying values inside arguments (`project_id`, `service_name`, etc.) — replace with `<PROJECT_ID>` / `<SERVICE_NAME>` placeholders. The synthesizer prompt will reinforce this, but pre-processing helps.

**`buildSynthesisPrompt`:**

```
You are a skill documentation expert. Given the following task trajectory,
generate a reusable SKILL.md document.

Hard rules:
1. Replace all instance-specific values (project IDs, names, dates, hostnames,
   regions, repo names) with generic placeholders like PROJECT_ID, SERVICE_NAME,
   REGION, REPO_NAME.
2. Strip all credentials, tokens, or API keys completely — do not include
   placeholders for them in code blocks; document them as "Prerequisites".
3. Output a valid agentskills.io SKILL.md with YAML frontmatter.

The frontmatter must include:
  name:        kebab-case slug, descriptive but concise
  description: one-line description (<= 100 chars) for the L0 index
  version:     "1.0.0"
  author:      "agent"
  trust:       "agent-created"
  tags:        array of 3-7 relevant tags
  complexity:  integer 1-5

The body must include these sections, in order:
  ## When to Use      — When this procedure applies (helps future retrieval)
  ## Prerequisites    — What must be true before starting (tools, permissions, state)
  ## Procedure        — Step-by-step instructions, with code blocks where applicable
  ## Verification     — How to confirm success
  ## Pitfalls         — Known failure modes and how to handle them (if applicable; otherwise omit)

Task trajectory:

{serialized_trajectory}

Output ONLY the SKILL.md content. No commentary before or after.
No "Here's the SKILL.md:" preamble. Start directly with `---` (frontmatter delimiter).
```

**`normalizeSynthesisOutput`:**

LLMs sometimes wrap output in code fences or add preamble. Strip:
- Leading whitespace.
- Leading triple-backtick + optional language tag.
- Trailing triple-backtick.
- Leading "Here's the SKILL.md:" or similar conversational openers.

Then validate by attempting `parseSkillDocument(output)`. If parsing fails, retry the synthesis call once with a stricter prompt. If second attempt also fails, return `{ triggered: false, reason: 'synthesis output unparseable' }` from `evaluate` and don't store anything.

**Testing:**

- Unit test `serializeTrajectoryForPrompt` with a fixture trajectory.
- Unit test `normalizeSynthesisOutput` with three failure modes (code fence, preamble, both).
- Integration test with a real auxiliary LLM call on a recorded trajectory fixture (deterministic via `temperature: 0`).

---

### 3.5 — Wire `createSelfLearningProcessor` end-to-end

**File:** `packages/core/src/processors/self-learning-processor.ts`

```ts
export function createSelfLearningProcessor(options: SelfLearningProcessorOptions) {
  const storage = options.storage instanceof SkillStorageExtension
    ? options.storage
    : new SkillStorageExtension(options.storage);
  const search = new SkillSearch(storage);
  const policy = ExtractionPolicySchema.parse(options.extraction ?? {});
  const aux = buildAuxiliary(options); // resolves Model vs. callback
  const extractor = new SkillExtractor(storage, search, policy, aux);

  return {
    name: 'self-learning',

    processOutputStream({ part, state }) {
      return observeChunk(part, state);
    },

    async processOutputResult({ messages, runtimeContext, state }) {
      const trajectory = buildTrajectory(state, messages, runtimeContext);
      void runExtraction(trajectory, extractor).catch(err =>
        console.error('[self-learning] extraction error:', err)
      );
      return messages;
    },
  };
}
```

The exact `processOutputResult` arg shape depends on Mastra's `Processor` interface — confirm whether `state` is passed in or accessed via a closure / `tracingContext`.

---

### 3.6 — Phase 3 integration test

**File:** `packages/core/src/processors/self-learning-processor.test.ts`

**Test plan:**

1. Construct a `SkillStorageExtension` against a Testcontainers Postgres.
2. Construct a Mastra `Agent` with:
   - The Phase 2 tools.
   - A mock LLM that produces a deterministic 6-tool-call, 4-turn trajectory ending with a "great, thanks" user message.
   - `outputProcessors: [createSelfLearningProcessor({ storage, model: mockAuxLLM })]`.
   - The mock aux LLM is scripted to answer `YES` to generalizability, then return a valid SKILL.md.
3. Run the agent's `stream` to completion.
4. Wait briefly for `runExtraction` to finish (the test uses a settled promise tracker — don't sleep).
5. Assert:
   - `storage.listSkills()` now returns 1 skill.
   - The skill has `trust_tier = 'agent-created'`, `status = 'active'`.
   - The skill's `metadata.mastra.threadOrigin` matches the test thread ID.
   - The frontmatter contains the placeholder substitutions (no real project IDs).
6. **Negative test:** Run a 2-tool-call trajectory through the same processor. Assert no skill is created and the extractor's logged reason is `minToolCalls not met`.
7. **Dedup test:** Run a near-identical 6-tool-call trajectory (same tool names, similar args). Assert the second run logs `duplicate of skill ...` and does not create a new record.

**Awaiting fire-and-forget extraction:** This is tricky because `processOutputResult` returns before extraction finishes. Strategy:
- Expose an internal `__waitForPendingExtractions()` test-only helper on the processor.
- Implementation tracks pending promises in a `Set<Promise>`, removes on settlement.
- Test calls `await processor.__waitForPendingExtractions()` after the stream ends.

This is the **end-to-end proof** that the learning loop works. Treat it as the phase's exit criterion.

---

## Critical Integration Points

1. **`ProcessorState` lifecycle.** The whole loop assumes `state` is per-request and survives across all `processOutputStream` calls but is fresh for each request. If Mastra exposes state differently, the accumulation pattern needs reworking. Confirm via Task 1.0.

2. **`processOutputResult` signature.** Does it receive `state`? `runtimeContext`? `tracingContext`? We need to extract `threadId` and `agentId` from somewhere. Adapt to actual signature.

3. **`ChunkType` discriminator names.** `'tool-call'`, `'tool-result'`, `'step-finish'`, `'message-end'` are spec-derived guesses. The real names matter for the `if (part.type === ...)` discriminator.

4. **Auxiliary LLM tracing.** When we call `aux.generate(...)`, that call should ideally appear in Mastra's tracing context. For MVP, accept that auxiliary calls are *not* traced; document this as a known gap. Post-MVP: add manual `tracingContext.span(...)` instrumentation.

5. **Async extraction failures.** If the aux LLM is rate-limited, slow, or returns garbage, extraction fails. The user must never see this. All errors caught at the `runExtraction` boundary, logged, never thrown.

## Exit Criteria

- [ ] `AUXILIARY_LLM.md` exists; decision documented.
- [ ] `pnpm typecheck` clean.
- [ ] Unit tests for chunk observation, trajectory building, positive-outcome detection.
- [ ] Unit tests for synthesis output normalization.
- [ ] Integration test 3.6 passes (positive case).
- [ ] Integration test 3.6 negative case (low tool calls) passes.
- [ ] Integration test 3.6 dedup case passes.
- [ ] Vision criterion #6 (extraction trigger) passes.
- [ ] Vision criterion #7 (extraction skip negative) passes.
- [ ] Vision criterion #8 (deduplication) passes.
- [ ] Vision criterion #12 (no user-visible latency) passes — measured via stream timing comparison.

## Estimated Scope

| Sub-task | Files touched | Complexity |
|---|---|---|
| 3.0 Aux LLM decision | New: `AUXILIARY_LLM.md` | Architectural — 1 day |
| 3.1 processOutputStream | `self-learning-processor.ts`, new: `chunk-observer.ts` | Medium |
| 3.2 processOutputResult | Same | Medium |
| 3.3 Extractor.evaluate | `extractor.ts` | High |
| 3.4 Extractor.synthesize | `extractor.ts`, new: `synthesis-prompt.ts` | High |
| 3.5 Wire-up | `self-learning-processor.ts` | Low |
| 3.6 Integration test | New: `self-learning-processor.test.ts` | High |

**Total:** 7 files written/modified. Estimated 2–2.5 weeks. Highest-risk task is 3.6 (proving the loop runs end-to-end against real `@mastra/core` agent + processor). Highest-effort task is 3.4 (synthesis prompt engineering + normalization).
