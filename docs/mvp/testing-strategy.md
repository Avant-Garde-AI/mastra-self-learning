# Testing Strategy

The MVP has three layers of tests, each answering a different question:

1. **Unit tests** — does this function behave correctly in isolation?
2. **Integration tests** — does this module work against a real backend (Postgres)?
3. **Agent-in-the-loop tests** — does the whole loop work when wired into a real Mastra `Agent`?

The end-to-end MVP integration test (`test/e2e-mvp.test.ts`, Phase 5.6) is the single gate that proves the user story works. Every other test exists to make that test debuggable when it fails.

## Tooling

- **Test runner:** Vitest (already pinned in `package.json` devDependencies).
- **Postgres for integration tests:** Testcontainers (`@testcontainers/postgresql` — needs adding as a devDep). Spins up an ephemeral Postgres per test file.
- **LLM mocking:** depends on Task 1.0's findings. Likely candidates: AI SDK's `MockLanguageModelV1` from `ai/test`, or a hand-rolled mock matching whatever pattern Task 3.0 lands on.
- **Coverage:** Vitest's built-in V8 coverage. Aim for ≥80% line coverage in `packages/core/src/skills/` and `packages/core/src/processors/`. Don't enforce a single global percentage — some modules (stubs, type-only files) shouldn't count.

## Layer 1 — Unit Tests

### What lives here

Pure functions and small classes with no I/O. Mock everything external.

| Module | What to test |
|---|---|
| `skills/parser.ts` | Edge cases (missing frontmatter, malformed YAML, section extraction with case/boundary variations) |
| `skills/scanner.ts` | Each regex category fires; benign content passes; known false-positive (procedural docs about `rm -rf`) flagged but documented |
| `skills/token-budget.ts` | Heuristic returns reasonable values for short, long, code, and empty inputs |
| `skills/version-utils.ts` | `bumpPatch`/`bumpMinor`/`bumpMajor` for `'1.0.0'`, `'0.9.99'`, `'2.5.0-beta'`; `unifiedDiff` for empty, identical, and divergent inputs |
| `skills/router.ts` | Index building with mocked storage — empty, under-budget, overflow strategies, cache hit/miss, invalidation |
| `processors/self-learning-processor.ts` — chunk observer | Each `ChunkType` discriminator routes correctly; state initialized on first chunk; chunks return unchanged; `state.skillUsed` set when `skill_view` fires |
| `skills/extractor.ts` — policy gate | Each policy threshold's pass/fail path returns the correct `reason` |
| `skills/extractor.ts` — `normalizeSynthesisOutput` | Strips code fences, conversational preambles, both combined |
| `skills/refiner.ts` — signal detection | `userCorrection` heuristic regex on various message bodies |
| `processors/skill-context-processor.ts` — `mergeIntoSystemMessage` | With/without existing system message; with structured content arrays |
| `memory/identity.ts` — `buildIdentityBlock` | Full identity, minimal identity, missing optional fields |
| `config.ts` | Zod schemas parse defaults and validate user-provided values |

### How to write them

Keep each test small and focused. Each test name describes a single behavior:

```ts
describe('parseSkillDocument', () => {
  it('returns default name when frontmatter omits it', () => {
    const { frontmatter } = parseSkillDocument('---\ndescription: hi\n---\nbody');
    expect(frontmatter.name).toBe('unnamed-skill');
  });

  it('throws SkillParseError on malformed YAML', () => {
    expect(() => parseSkillDocument('---\n[invalid yaml\n---\n')).toThrow(SkillParseError);
  });
});
```

### What to mock at this layer

- **Storage:** Mock the `SkillStorageExtension` directly with `vi.fn()` returning fixture data.
- **LLM:** Mock as a function returning a hardcoded string.
- **Time:** Use `vi.useFakeTimers()` when testing cooldowns.
- **Console:** Capture warnings via `vi.spyOn(console, 'warn')`.

## Layer 2 — Integration Tests

### What lives here

Tests that need a real database. Postgres-specific behavior (FTS, generated columns, transactions, constraint violations) cannot be reliably mocked.

### Fixture: shared Postgres setup helper

`packages/core/test/fixtures/postgres.ts`:

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export async function setupPostgres() {
  const container = await new PostgreSqlContainer().start();
  const connectionString = container.getConnectionUri();
  // Construct a SkillStorageExtension against this connection
  const storage = await createTestStorage(connectionString);
  await storage.ensureSchema();
  return { storage, container, cleanup: () => container.stop() };
}
```

Use this in each integration test's `beforeAll`/`afterAll`. Note: starting a Postgres container takes ~3–5 seconds; group integration tests in the same file when possible to amortize.

### What to test

| File | What it proves |
|---|---|
| `storage-extension.integration.test.ts` | `ensureSchema()` idempotent; CRUD round-trips; version history insert/list; usage tracking + counter atomicity; constraint violations throw typed errors |
| `search.integration.test.ts` | FTS ranks by `ts_rank_cd`; agentId / status / trustTiers filters work; mode 'semantic' / 'hybrid' throws Phase-6 error |
| `fact-layer.integration.test.ts` | Persist/recall/reinforce/decay; TTL expiry; confidence-ordered fallback when query is empty |
| `tools.integration.test.ts` | All 8 tools' `execute` functions hit storage correctly; `skill_create` rejects malformed content; `skill_feedback` is soft-fail on missing skill |

### Testcontainers caveat

Testcontainers requires Docker. CI environments need Docker available. Locally, contributors need Docker Desktop or Colima. Document this in `CONTRIBUTING.md` as a prerequisite for running integration tests; provide a `pnpm test:unit` script that skips integration tests for contributors who don't have Docker set up.

### What NOT to mock at this layer

- The Postgres backend (the whole point is real DB behavior).
- ULID generation (it's deterministic enough; if we need fixed IDs, override at call sites).

### What still gets mocked

- The aux LLM (we're not testing LLM behavior — we're testing our handling of its output).
- The agent's tool dispatch (these tests run our code directly, not through `Agent`).

## Layer 3 — Agent-in-the-Loop Tests

### What lives here

Tests that exercise our code through a real `@mastra/core` `Agent` instance with a mock LLM. These prove the contract with Mastra is correct.

### The single most important test

`packages/core/test/e2e-mvp.test.ts` (Phase 5.6) — described in detail in `05-phase-refinement.md`. This is the **MVP exit gate**.

### Supporting agent-in-the-loop tests

| File | What it proves |
|---|---|
| `skill-tools.agent.test.ts` (Phase 2.4) | Agent with tools attached can call each tool and receive correct outputs |
| `self-learning-processor.agent.test.ts` (Phase 3.6) | Output processor accumulates state across real streaming chunks; extraction fires correctly; negative + dedup cases |
| `skill-context-processor.agent.test.ts` (Phase 4.5) | Input processor injects correct system message; nudge mechanism fires; cross-thread skill discovery works |

### LLM mocking strategy

The hardest part of agent-in-the-loop tests is making the mock LLM predictable. Strategy:

```ts
// A scripted mock that returns predetermined responses per "turn"
const script = [
  // Turn 1: agent calls skill_list
  { toolCall: { name: 'skill_list', args: {} } },
  // Turn 2: agent reads result and responds
  { textResponse: 'I see no relevant skills. Let me proceed manually.' },
  // Turn 3: agent calls a series of deployment tools
  { toolCall: { name: 'gcloud_run_deploy', args: { service: '<SERVICE>' } } },
  // ...
];

const mockLLM = createScriptedLLM(script);
```

The exact shape of `createScriptedLLM` depends on what Task 1.0 finds for Mastra's `model` parameter type. Likely it's an AI SDK `LanguageModelV1`, which has a known mock pattern.

For tests that involve aux LLM calls (synthesis, refinement), use **separate scripts** for the aux LLM and the primary agent LLM. Pass the aux script via `model` in the processor options.

### Determinism

All agent-in-the-loop tests must:
- Use scripted (not random) LLM responses.
- Use Vitest's fake timers when checking cooldowns.
- Wait deterministically for fire-and-forget work via `__waitForPendingExtractions()` (Phase 3.6 helper) — never `setTimeout`-then-assert.
- Avoid Date.now() drift via `vi.setSystemTime()`.

## Test Fixtures

Centralize reusable fixtures under `packages/core/test/fixtures/`:

### Skill documents

- `fixtures/skills/gcp-cloud-run-deploy.md` — a realistic Cloud Run deployment skill with all five sections, used as the "successful extraction" target.
- `fixtures/skills/k8s-rollback.md` — a Kubernetes rollback skill, distinct from the first, used to verify multiple-skill scenarios and search ranking.
- `fixtures/skills/hermes-imported.md` — a real Hermes Agent skill file (sourced from agentskills.io public examples), used to verify parser compatibility.
- `fixtures/skills/malformed-yaml.md` — for parser error-path tests.
- `fixtures/skills/no-frontmatter.md` — for parser default-handling tests.
- `fixtures/skills/security-fail.md` — contains a triggered regex pattern, used to verify scanner.

### Task trajectories

- `fixtures/trajectories/cloud-run-deploy.json` — a complete `TaskTrajectory` representing a real-looking Cloud Run deployment session. Used as the input to extraction tests.
- `fixtures/trajectories/short-task.json` — 2 tool calls, used as the "should not extract" negative case.
- `fixtures/trajectories/refinement-failure.json` — a trajectory that used an existing skill but ended in failure. Used for refinement tests.

### Conversation transcripts

- `fixtures/conversations/successful-deploy.json` — a sequence of `MastraMessageV2` from user, assistant, and tool turns. Used as the inputs to `processOutputResult`.
- `fixtures/conversations/user-correction.json` — a conversation where the user corrects the agent mid-task. Used to test `detectUserCorrection`.

### Mock LLM scripts

- `fixtures/llm-scripts/generalizability-yes.ts` — scripted to return `YES` to the generalizability check.
- `fixtures/llm-scripts/synthesis-cloud-run.ts` — scripted to return a valid SKILL.md for the Cloud Run trajectory.
- `fixtures/llm-scripts/synthesis-malformed.ts` — scripted to return content with a code-fence wrapper (for normalizeSynthesisOutput tests).

### Identities

- `fixtures/identities/devops-engineer.ts` — a full `Identity` config used in cross-thread tests.

## Coverage Targets

| Path | Target |
|---|---|
| `packages/core/src/skills/parser.ts` | 100% |
| `packages/core/src/skills/scanner.ts` | 100% |
| `packages/core/src/skills/router.ts` | ≥90% |
| `packages/core/src/skills/extractor.ts` | ≥85% (some branches are LLM-dependent) |
| `packages/core/src/skills/refiner.ts` | ≥80% |
| `packages/core/src/skills/storage-extension.ts` | ≥90% (integration test heavy) |
| `packages/core/src/processors/*` | ≥85% |
| `packages/core/src/memory/*` | ≥85% |
| `packages/core/src/tools/skill-tools.ts` | ≥80% (each tool tested) |

Stubs in `packages/core/src/harness/`, `packages/core/src/workflows/`, `packages/core/src/evals/` are excluded from MVP coverage — they're Phase 6+ work.

## CI

Two `pnpm` scripts in `packages/core/package.json`:

```json
{
  "test": "vitest run",
  "test:unit": "vitest run --exclude '**/*.integration.test.ts' --exclude '**/*.agent.test.ts' --exclude 'test/e2e-mvp.test.ts'",
  "test:integration": "vitest run **/*.integration.test.ts",
  "test:agent": "vitest run **/*.agent.test.ts test/e2e-mvp.test.ts"
}
```

GitHub Actions:

- **PR check (fast)**: `pnpm test:unit` + `pnpm typecheck` + `pnpm lint`. Runs in <60s, blocks merge.
- **Full suite (slow)**: `pnpm test` (everything). Runs on `main` and tags only. Requires Docker for Postgres testcontainers.
- **Release gate:** the v0.1.0 tag does not get published until the full suite is green and the vision-criteria-report.md shows 13 PASSes.

## Don't Test

To save effort, explicitly do **not** test:

- Pure type-only files (they're either compiled or they're not).
- Auto-generated code.
- Third-party library behavior (gray-matter, zod, ulid).
- Mastra's internal behavior (we test our contract with Mastra, not Mastra itself).
- Production LLM behavior (use mocks; real LLM testing is for evals, post-MVP).
- Performance — we have one perf criterion (vision #12: no user-visible latency). Measure it once and call it done.

## When a Test Fails

A failing test in this codebase should mean exactly one of three things:

1. A bug in the code under test. Fix the code.
2. A drift in `@mastra/core`'s API that our code hasn't kept up with. Update `MASTRA_API_NOTES.md`, fix the code, fix the test.
3. A change in the spec or vision criteria. Update both spec and test deliberately.

If a test is "flaky" — passing sometimes, failing sometimes — that almost always means a real race condition or determinism gap. Investigate before retrying.
