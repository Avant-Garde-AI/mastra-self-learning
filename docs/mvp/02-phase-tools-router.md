# Phase 2 — Skill Tools + Router

## Goal

After this phase, a Mastra `Agent` configured with `tools: { ...createSelfLearningTools({ storage }) }` is fully functional in **Tier 1** mode: the LLM can discover skills via `skill_list`, load them with `skill_view`, search via FTS with `skill_search`, manually create or update them, and record outcomes via `skill_feedback`. The `SkillRouter` enforces token budgets and progressive disclosure. There is still no automatic learning loop (Phase 3) and no system-prompt injection (Phase 4) — but a developer can pick up the package today and ship a useful integration.

This phase delivers the first **user-facing** capability of the package. It also turns Phase 1's untyped `unknown` storage references into a real wire-up against `@mastra/core`'s `createTool`.

## Prerequisites

- Phase 1 fully complete and exit criteria met.
- `MASTRA_API_NOTES.md` answers the `createTool` signature question.
- A working `SkillStorageExtension` instance against a test Postgres database.

## Task Breakdown

### 2.1 — Implement `SkillRouter`

**File:** `packages/core/src/skills/router.ts`

**Methods:**

```ts
buildIndex(): Promise<string>
loadSkill(name: string, section?: string): Promise<string | null>
suggestSkills(message: string, limit?: number): Promise<SkillRecord[]>  // throws in MVP
```

**Constructor signature change:** Add `agentId?: string` as a constructor parameter so the router is created once per agent and doesn't need it threaded through method calls. This is a small ergonomic win that pays off in `createSelfLearningTools`.

```ts
new SkillRouter(storage: SkillStorageExtension, config: SkillRouterConfig, agentId?: string)
```

**Logic for `buildIndex()`:**

1. Fetch `storage.listSkills({ agentId, status: 'active' })`.
2. Format each as a line: `- {name}: {description}`.
3. Estimate tokens via the heuristic helper (see 2.2 below).
4. If accumulated tokens > `config.indexBudget`, apply overflow strategy:
   - `recent`: Sort by `lastUsed DESC NULLS LAST, createdAt DESC`. Truncate the tail.
   - `frequent`: Sort by `(successCount - failCount) DESC`. Truncate the tail.
   - `relevant`: **MVP fallback** — log a one-time warning per process and call the `recent` strategy. Phase 4 wires up embeddings.
5. Prefix the output with a stable header: `"# Available Skills\n\n"`. Empty library → return `"# Available Skills\n\n(none yet)"`.
6. Cache the result per agent for ~30 seconds — `SkillContextProcessor` (Phase 4) will call this on every request. Use a simple `Map<agentId, { value, expiresAt }>`. Invalidate on `createSkill` / `updateSkill` by exposing a `router.invalidate()` method that the tools call.

**Logic for `loadSkill()`:**

1. `storage.getSkillByName(name, agentId)`.
2. If not found, return `null`.
3. If `section` provided, parse the body via `parseSkillDocument`, then `extractSection(body, section)`. Return that (L2). If section not found, return `null`.
4. Otherwise return the full `content` (L1, including frontmatter — agents seeing the YAML helps them understand the skill's metadata).

**Note on `activeBudget`:** Don't enforce `activeBudget` here. The budget is a *post-condition* of `SkillContextProcessor` after assembling the full system prompt; `loadSkill` returns whatever content the skill actually has. Truncation at the skill level would corrupt the agent's understanding of the procedure.

**Logic for `suggestSkills()`:**

Throw `Error('Semantic skill suggestion is a Phase 4 feature — use skill_search (FTS) instead')`. Keep the method on the interface so Phase 4 doesn't change the public surface.

**Edge cases:**

- Skill content with no `description` in frontmatter → fall back to first non-empty line of body. If still empty, omit from index.
- Skill with extremely long name → keep as-is; the LLM handles it. We could truncate at 80 chars but that risks ambiguity.

**Testing:** Unit tests with a mocked `SkillStorageExtension`:

- Empty library → returns the "(none yet)" string.
- 3 skills under budget → all 3 in order.
- 100 skills with low budget + `recent` strategy → most recent N included.
- 100 skills with low budget + `frequent` strategy → most-used N included.
- `relevant` strategy → logs warning once, falls back to `recent`.
- `loadSkill` L1 → full content returned.
- `loadSkill` L2 valid section → just that section.
- `loadSkill` L2 invalid section → `null`.
- `loadSkill` missing skill → `null`.
- Cache hit returns same instance on repeat call within TTL.
- `invalidate()` forces fresh fetch.

---

### 2.2 — Token estimation helper

**File:** `packages/core/src/skills/token-budget.ts` (new)

A trivial module that isolates the heuristic so it's pluggable later.

```ts
export interface TokenEstimator {
  (text: string): number;
}

/**
 * MVP token estimator: characters / 4.
 *
 * Accurate to within ~20% for English prose, less accurate for code-heavy
 * skills (which trend tokens-per-char lower) and non-English text (higher).
 * See risks-and-unknowns.md for when this breaks and what to swap in.
 */
export const heuristicEstimator: TokenEstimator = (text) =>
  Math.ceil(text.length / 4);

export const defaultEstimator = heuristicEstimator;
```

Re-export from `packages/core/src/skills/index.ts` as `estimateTokens`.

---

### 2.3 — Implement `createSelfLearningTools`

**File:** `packages/core/src/tools/skill-tools.ts`

**Mastra surface used:** `createTool({ id, description, inputSchema, outputSchema, execute })` from `@mastra/core` (exact import path resolved by Task 1.0).

**Construction order:**

```ts
export function createSelfLearningTools(options: SelfLearningToolsOptions) {
  const storage = options.storage instanceof SkillStorageExtension
    ? options.storage
    : new SkillStorageExtension(options.storage);
  const search = new SkillSearch(storage);
  const router = new SkillRouter(storage, SkillRouterConfigSchema.parse({}), options.agentId);

  return {
    skill_list: createSkillListTool(storage, options.agentId),
    skill_view: createSkillViewTool(router),
    skill_search: createSkillSearchTool(search, options.agentId),
    skill_create: createSkillCreateTool(storage, router, options.agentId),
    skill_update: createSkillUpdateTool(storage, router, options.agentId),
    skill_feedback: createSkillFeedbackTool(storage, options.agentId),
    memory_persist: createMemoryPersistStubTool(),
    memory_recall: createMemoryRecallStubTool(),
  } as const;
}
```

**Critical:** `SkillStorageExtension`, `SkillSearch`, `SkillRouter` are constructed **once** here and closed over by each tool's `execute`. Do not recreate per-call.

**The 8 tools:**

#### `skill_list`

```ts
description: 'List all available skills (the L0 index). Call this at the start of a complex task to discover what reusable procedures exist before you reason from scratch.'

inputSchema: z.object({
  tags: z.array(z.string()).optional().describe('Filter by tags'),
  limit: z.number().int().min(1).max(100).optional().default(50),
})

outputSchema: z.object({
  skills: z.array(z.object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    successCount: z.number(),
    failCount: z.number(),
    tags: z.array(z.string()),
  })),
})

execute: async ({ context }) => {
  const skills = await storage.listSkills({
    agentId, status: 'active', limit: context.limit,
  });
  const filtered = context.tags
    ? skills.filter(s => context.tags!.some(t => s.frontmatter.tags?.includes(t)))
    : skills;
  return {
    skills: filtered.map(s => ({
      name: s.name,
      description: s.frontmatter.description,
      version: s.version,
      successCount: s.successCount,
      failCount: s.failCount,
      tags: s.frontmatter.tags ?? [],
    })),
  };
}
```

#### `skill_view`

```ts
description: 'Load the full content of a skill (L1), or a specific section (L2). Use this when you have decided to follow a skill listed by skill_list.'

inputSchema: z.object({
  name: z.string(),
  section: z.string().optional().describe('Load only this section (e.g., "Procedure", "Pitfalls"). Omit for full content.'),
})

outputSchema: z.object({
  content: z.string(),
  found: z.boolean(),
})

execute: async ({ context }) => {
  const content = await router.loadSkill(context.name, context.section);
  return { content: content ?? '', found: content !== null };
}
```

#### `skill_search`

```ts
description: 'Search skills by keyword or phrase. Returns ranked matches. Use this when the L0 index does not contain an obvious match for your task.'

inputSchema: z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(20).optional().default(5),
})

outputSchema: z.object({
  results: z.array(z.object({
    name: z.string(),
    description: z.string(),
    score: z.number(),
  })),
})

execute: async ({ context }) => {
  const results = await search.search({
    query: context.query,
    mode: 'fts',
    limit: context.limit,
    agentId,
  });
  return {
    results: results.map(r => ({
      name: r.skill.name,
      description: r.skill.frontmatter.description,
      score: r.score,
    })),
  };
}
```

#### `skill_create`

```ts
description: 'Create a new skill from a SKILL.md document. Most skills are created automatically by the learning loop — use this tool only when you have been explicitly asked to formalize a procedure.'

inputSchema: z.object({
  content: z.string().describe('Full SKILL.md content including YAML frontmatter'),
})

outputSchema: z.object({
  skill: z.object({ id: z.string(), name: z.string(), version: z.string(), status: z.string() }),
  scanFindings: z.array(z.object({
    type: z.string(),
    severity: z.string(),
    description: z.string(),
    line: z.number().optional(),
  })),
})

execute: async ({ context }) => {
  const { frontmatter } = parseSkillDocument(context.content);
  const scan = scanSkillContent(context.content);
  const skill = await storage.createSkill({
    name: frontmatter.name,
    version: frontmatter.version ?? '1.0.0',
    content: context.content,
    frontmatter,
    trustTier: 'agent-created',
    status: scan.safe ? 'active' : 'draft',
    successCount: 0,
    failCount: 0,
    agentId,
  });
  router.invalidate();
  return {
    skill: { id: skill.id, name: skill.name, version: skill.version, status: skill.status },
    scanFindings: scan.findings,
  };
}
```

#### `skill_update`

```ts
description: 'Update an existing skill. Provide the new SKILL.md content. The previous version is preserved automatically.'

inputSchema: z.object({
  name: z.string(),
  content: z.string(),
  reason: z.string().describe('Why the update is being made'),
})

outputSchema: z.object({
  skill: z.object({ id: z.string(), version: z.string() }),
})

execute: async ({ context }) => {
  const existing = await storage.getSkillByName(context.name, agentId);
  if (!existing) throw new Error(`Skill not found: ${context.name}`);

  const { frontmatter } = parseSkillDocument(context.content);
  const newVersion = frontmatter.version ?? bumpPatch(existing.version);

  const updated = await storage.updateSkill(existing.id, {
    content: context.content,
    frontmatter,
    version: newVersion,
  });
  await storage.createVersion({
    skillId: existing.id,
    version: newVersion,
    content: context.content,
    diff: unifiedDiff(existing.content, context.content),
    reason: context.reason,
  });
  router.invalidate();
  return { skill: { id: updated.id, version: updated.version } };
}
```

Helpers to add (in `packages/core/src/skills/version-utils.ts`):

```ts
export function bumpPatch(version: string): string { /* '1.0.0' -> '1.0.1' */ }
export function bumpMinor(version: string): string { /* '1.0.0' -> '1.1.0' */ }
export function bumpMajor(version: string): string { /* '1.0.0' -> '2.0.0' */ }
export function unifiedDiff(before: string, after: string): string { /* use `diff` npm package or inline implementation */ }
```

The `diff` npm package is small and battle-tested. Add as a dependency: `pnpm --filter @avant-garde/mastra-self-learning add diff`.

#### `skill_feedback`

```ts
description: 'Record the outcome after using a skill. Call this immediately after completing a task that was guided by a skill (whether the skill helped or not).'

inputSchema: z.object({
  name: z.string(),
  outcome: z.enum(['success', 'failure', 'partial', 'abandoned']),
  feedback: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  toolCalls: z.number().int().min(0).optional(),
})

outputSchema: z.object({ recorded: z.boolean() })

execute: async ({ context, runtimeContext }) => {
  const skill = await storage.getSkillByName(context.name, agentId);
  if (!skill) {
    // Soft fail — don't crash the agent loop because of bookkeeping
    return { recorded: false };
  }
  await storage.recordUsage({
    skillId: skill.id,
    threadId: runtimeContext?.get?.('threadId') ?? 'unknown',
    agentId: agentId ?? 'unknown',
    outcome: context.outcome,
    feedback: context.feedback ?? null,
    durationMs: context.durationMs ?? 0,
    toolCalls: context.toolCalls ?? 0,
  });
  return { recorded: true };
}
```

The `runtimeContext` API may not match this access pattern exactly — confirm in Task 1.0 and adjust. The intent is: pull `threadId` from whatever request-scoped context Mastra exposes to tools.

#### `memory_persist` (stub)

```ts
description: 'Store a fact in your persistent memory. Use this when the user shares a fact about themselves, their environment, projects, or preferences that should be remembered across conversations.'

inputSchema: z.object({
  category: z.enum(['preference','context','project','credential','constraint','relationship']),
  content: z.string(),
})

outputSchema: z.object({ id: z.string().optional(), persisted: z.boolean() })

execute: async () => {
  console.warn('[mastra-self-learning] memory_persist called but FactLayer is not wired up yet (Phase 4)');
  return { persisted: false };
}
```

#### `memory_recall` (stub)

```ts
description: 'Retrieve facts stored in your persistent memory. Use this when you need to recall what you know about the user, their environment, or their projects.'

inputSchema: z.object({
  query: z.string(),
  category: z.enum([
    'preference','context','project','credential','constraint','relationship'
  ]).optional(),
  limit: z.number().int().min(1).max(20).optional().default(5),
})

outputSchema: z.object({
  facts: z.array(z.object({
    id: z.string(),
    category: z.string(),
    content: z.string(),
    confidence: z.number(),
  })),
})

execute: async () => {
  console.warn('[mastra-self-learning] memory_recall called but FactLayer is not wired up yet (Phase 4)');
  return { facts: [] };
}
```

The schemas are **stable now**: Phase 4 swaps the stub `execute` implementations without changing the tool surface, so an agent built today against these tools will keep working when Phase 4 ships.

**Tool description discipline:** the LLM only sees the `description` field when choosing tools. Each one is written as a "when to use this" sentence aimed at the agent. Resist the temptation to put implementation detail or developer warnings in the description — that pollutes the LLM's tool-selection context.

---

### 2.4 — Tier-1 smoke test

**File:** `packages/core/src/tools/skill-tools.test.ts`

**What:** End-to-end smoke test using a real Mastra `Agent` (no `inputProcessors` / `outputProcessors` yet) and a deterministic mock LLM. The test should walk the full Tier-1 user flow:

1. Construct an `Agent` with `tools: { ...createSelfLearningTools({ storage }) }`.
2. Pre-seed storage with two skills (`gcp-cloud-run-deploy`, `k8s-rollback`).
3. Mock the LLM to call `skill_list` on the first turn → assert it sees both skills.
4. Mock the LLM to call `skill_view({ name: 'gcp-cloud-run-deploy' })` → assert full content returned.
5. Mock the LLM to call `skill_view({ name: 'gcp-cloud-run-deploy', section: 'Pitfalls' })` → assert only the Pitfalls section returned.
6. Mock the LLM to call `skill_search({ query: 'rollback' })` → assert `k8s-rollback` ranks first.
7. Mock the LLM to call `skill_feedback({ name: 'gcp-cloud-run-deploy', outcome: 'success' })` → assert `skills.success_count` incremented.

**How to mock the LLM:** depends on what Task 1.0 finds. Options:
- If Mastra's `Agent` accepts a `model` that's a custom function, build a function-style mock.
- If Mastra uses AI SDK's `LanguageModel`, use the AI SDK's `MockLanguageModelV1` from `ai/test`.
- If neither, build the smallest possible compatible shape.

This is the first test that exercises the **real** `@mastra/core` API. Treat any failure here as a blocker — adjust the implementation, don't skip the test.

---

### 2.5 — Update public exports

**File:** `packages/core/src/index.ts`

After this phase:
- `createSelfLearningTools` is a real function with strongly-typed return.
- `SkillRouter` is exported with `agentId` constructor param.
- `SkillSearch` (Phase 1) is exported.
- `estimateTokens` is exported from `./skills/token-budget.js`.
- `SelfLearningToolsOptions` is exported.

Run `pnpm typecheck` and `pnpm build`. The published package surface should compile cleanly.

---

## Critical Integration Points

1. **`createTool` exact shape.** The 8 tools live or die by matching the real API. If `execute` receives `{ input }` instead of `{ context }`, or if `runtimeContext` isn't available the way we assume, every tool needs the same edit. Validate against the real `@mastra/core` build before scaling out to all 8.

2. **`Agent` tool registration shape.** Whether `tools` is `Record<string, Tool>`, `Tool[]`, or a `ToolSet` object matters for the return type of `createSelfLearningTools`. Match Mastra's expected shape exactly; do not invent a wrapper type.

3. **`runtimeContext.get('threadId')`.** `skill_feedback` needs the current thread ID for the `skill_usage` record. The exact API surface for accessing per-request context inside a tool execute is one of the spike questions; if Mastra exposes this differently (a function parameter, a separate API, etc.), adapt.

4. **Tool input schemas use Zod.** The package already depends on Zod `^3.24.0`. The schemas here should compose with Mastra's own Zod usage — same `z.object(...)` shape, no different version of Zod imported.

## Exit Criteria

- [ ] `pnpm typecheck` clean.
- [ ] `SkillRouter` unit tests pass (11+ cases).
- [ ] `bumpPatch`/`Minor`/`Major` and `unifiedDiff` helpers tested.
- [ ] All 8 tools are constructed via real `createTool` calls (no `as any`).
- [ ] Tier-1 smoke test (2.4) passes against the real `@mastra/core` build.
- [ ] Storage state changes (new skill, version row, usage row) are observable from outside the agent.
- [ ] Vision criterion #2 (tool surface) passes.
- [ ] Vision criteria #4 and #5 (L1/L2 retrieval) pass.
- [ ] Vision criterion #9 (usage tracking on `skill_feedback`) passes.

## Estimated Scope

| Sub-task | Files touched | Complexity |
|---|---|---|
| 2.1 Router | `router.ts`, `router.test.ts` | Medium |
| 2.2 Token budget | New: `token-budget.ts` | Trivial |
| 2.3 Tools | `skill-tools.ts`, new: `version-utils.ts`, `skill-tools.test.ts` | High |
| 2.4 Smoke test | `skill-tools.test.ts` (extends 2.3) | Medium |
| 2.5 Exports | `index.ts` | Trivial |

**Total:** 5 files written/modified plus 1 dependency added. Estimated 1 week. Highest-risk task is 2.3 (validating against real `createTool`) and 2.4 (validating against real `Agent`).
