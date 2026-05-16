# Mastra API Notes — Phase 1 Spike Findings

Spike conducted against `@mastra/core@1.34.0` and `@mastra/pg@1.10.1`. Date: 2026-05-15.

## TL;DR

**Mastra ships a far richer SkillsStorage domain than the MVP spec anticipated.** It is not exported at the top level (no `./skills` subpath in `package.json#exports`), but it is fully usable via `import { ... } from '@mastra/core/storage/domains/skills'` and via `PostgresStore.getStore('skills')`.

The MVP plan's "additive extension to Mastra's `skills` table" framing was correct in spirit but wrong in detail — Mastra has already implemented:

- Versioned skill records (every change is a new immutable version)
- Content-addressable BlobStore tree manifests (`tree: SkillVersionTree`)
- A `metadata: Record<string, unknown>` JSONB column on the version snapshot
- A `status: 'draft' | 'published' | 'archived'` workflow
- Multi-tenant `authorId` scoping
- Pagination, ordering, metadata filtering on `list`

This **simplifies our work substantially**. We do not own `mastra_skills` or `mastra_skill_versions`. We add three auxiliary tables for learning-loop-specific data (counters, usage, facts), and we stash all skill content in Mastra's existing schema.

## 1. Storage Layer

### Top-level surface

```ts
import { PostgresStore } from '@mastra/pg';

const storage = new PostgresStore({
  id: 'self-learning-storage',
  connectionString: process.env.DATABASE_URL,
});

await storage.init(); // bootstraps every domain's schema, idempotent

// Domain access (typed)
const skills = await storage.getStore('skills'); // → SkillsPG
const memory = await storage.getStore('memory'); // → MemoryPG
// etc.

// Raw SQL escape hatch — documented and stable
const rows = await storage.db.any<MyRow>('SELECT * FROM my_table WHERE id = $1', [id]);
const pool = storage.pool; // raw pg.Pool
```

### DbClient interface (pgPromise-style)

```ts
interface DbClient {
  readonly $pool: Pool;
  connect(): Promise<PoolClient>;
  none(query, values?): Promise<null>;
  one<T>(query, values?): Promise<T>;          // throws if !==1 rows
  oneOrNone<T>(query, values?): Promise<T|null>; // throws if >1 rows
  any<T>(query, values?): Promise<T[]>;
  many<T>(query, values?): Promise<T[]>;        // throws if 0 rows
  manyOrNone<T>(query, values?): Promise<T[]>;
  query(query, values?): Promise<QueryResult>;
  tx<T>(callback: (t: TxClient) => Promise<T>): Promise<T>;
}
```

`tx()` is what we'll use for atomic counter updates in `recordUsage`.

### `PostgresStore.init()` lifecycle

`init()` creates all domain tables idempotently. The storage instance is created lazily-initialized via `augmentWithInit` — domain methods auto-trigger init on first call. We can rely on this and not call `init()` explicitly, **but** we should call it ourselves anyway for predictable startup ordering when our `ensureSchema()` runs.

## 2. Skills Domain

### Mastra-owned tables

```
mastra_skills
├── id              TEXT PK
├── status          TEXT  ('draft' | 'published' | 'archived')
├── activeVersionId TEXT  (FK → mastra_skill_versions.id, nullable)
├── authorId        TEXT  (nullable; multi-tenant filter)
├── createdAt       TIMESTAMP
└── updatedAt       TIMESTAMP

mastra_skill_versions
├── id            TEXT PK
├── skillId       TEXT  (FK → mastra_skills.id)
├── versionNumber INT
├── name          TEXT
├── description   TEXT
├── instructions  TEXT  ← the SKILL.md body
├── license       TEXT  (nullable)
├── compatibility JSONB (nullable)
├── source        JSONB (nullable)
├── references    JSONB (nullable; string[])
├── scripts       JSONB (nullable; string[])
├── assets        JSONB (nullable; string[])
├── metadata      JSONB (nullable; arbitrary)  ← where we put trust_tier, extractionTrigger, threadOrigin
├── tree          JSONB (nullable; SkillVersionTree)
├── changedFields JSONB (nullable)
├── changeMessage TEXT  (nullable)
└── createdAt     TIMESTAMP

mastra_skill_blobs
├── hash          TEXT PK (SHA-256, content-addressable)
└── ... (managed by Mastra's BlobStore; we don't touch this)
```

### Type shapes from `@mastra/core/storage`

```ts
interface StorageSkillType {
  id: string;
  status: 'draft' | 'published' | 'archived';
  activeVersionId?: string;
  authorId?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface StorageSkillSnapshotType {
  name: string;
  description: string;
  instructions: string;             // The Markdown body
  license?: string;
  compatibility?: unknown;
  source?: StorageContentSource;
  references?: string[];
  scripts?: string[];
  assets?: string[];
  metadata?: Record<string, unknown>; // Free-form JSONB — our integration point
  tree?: SkillVersionTree;
}

type StorageResolvedSkillType =
  StorageSkillType & StorageSkillSnapshotType & { resolvedVersionId?: string };

type StorageCreateSkillInput = { id: string; authorId?: string } & StorageSkillSnapshotType;
type StorageUpdateSkillInput = { id: string; authorId?: string; activeVersionId?: string; status?: ... } & Partial<StorageSkillSnapshotType>;
```

### `SkillsPG` operations (from `@mastra/pg`)

```ts
class SkillsPG extends SkillsStorage {
  static readonly MANAGED_TABLES = ['mastra_skills', 'mastra_skill_versions'];
  init(): Promise<void>;
  getById(id: string): Promise<StorageSkillType | null>;
  create(input: { skill: StorageCreateSkillInput }): Promise<StorageSkillType>;
  update(input: StorageUpdateSkillInput): Promise<StorageSkillType>;
  delete(id: string): Promise<void>;
  list(args?: StorageListSkillsInput): Promise<StorageListSkillsOutput>;
  createVersion(input: CreateSkillVersionInput): Promise<SkillVersion>;
  getVersion(id: string): Promise<SkillVersion | null>;
  getVersionByNumber(skillId, versionNumber): Promise<SkillVersion | null>;
  getLatestVersion(skillId): Promise<SkillVersion | null>;
  listVersions(input: ListSkillVersionsInput): Promise<ListSkillVersionsOutput>;
  deleteVersion(id: string): Promise<void>;
  countVersions(skillId: string): Promise<number>;
}
```

**Notable observations:**

- `list()` does NOT support full-text search natively — it takes `authorId`, `metadata` (key/value AND), `perPage`, `page`, `orderBy`. **No `query` parameter.** This means our FTS search runs through `storage.db.any(...)` against `mastra_skill_versions` directly.
- `update()` performs a smart split: changes to `name`/`description`/`instructions`/`metadata` produce a new version automatically; changes to `status`/`activeVersionId` update the skill row in place. This is critical for refinement — we don't manage version numbers manually.
- The `metadata` JSONB column is per-version. Anything we put there is frozen to that version. **Implication:** `trust_tier`, `extractionTrigger`, `threadOrigin` belong here. Mutable counters (`success_count`, `fail_count`, `last_used`) do NOT — they need an auxiliary table.

### `StorageListSkillsInput.metadata` filter behavior

The `metadata` filter expects `Record<string, unknown>` with AND semantics over key-value pairs. Useful for `WHERE metadata->>'trust_tier' = 'agent-created'` queries without raw SQL.

## 3. Our Schema Strategy

Given Mastra's surface, we own only auxiliary tables:

```sql
-- Per-skill mutable counters and learning-loop metadata not version-tied.
CREATE TABLE IF NOT EXISTS mastra_self_learning_skill_stats (
  skill_id      TEXT PRIMARY KEY REFERENCES mastra_skills(id) ON DELETE CASCADE,
  success_count INT  NOT NULL DEFAULT 0,
  fail_count    INT  NOT NULL DEFAULT 0,
  last_used     TIMESTAMPTZ,
  -- agent_id mirrors Mastra's authorId; we re-store for fast filter without joining
  agent_id      TEXT,
  -- pgvector column for semantic search; nullable; created only if pgvector ext present
  embedding     VECTOR
);
CREATE INDEX IF NOT EXISTS msl_skill_stats_agent_idx ON mastra_self_learning_skill_stats (agent_id);

-- Per-invocation usage logs.
CREATE TABLE IF NOT EXISTS mastra_self_learning_skill_usage (
  id          TEXT PRIMARY KEY,                          -- ULID
  skill_id    TEXT NOT NULL REFERENCES mastra_skills(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('success','failure','partial','abandoned')),
  feedback    TEXT,
  duration_ms INT  NOT NULL DEFAULT 0,
  tool_calls  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS msl_skill_usage_skill_idx ON mastra_self_learning_skill_usage (skill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS msl_skill_usage_thread_idx ON mastra_self_learning_skill_usage (thread_id);

-- Cross-thread persistent facts.
CREATE TABLE IF NOT EXISTS mastra_self_learning_facts (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT,
  category          TEXT NOT NULL CHECK (category IN (
    'preference','context','project','credential','constraint','relationship'
  )),
  content           TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 1.0,
  source_thread_id  TEXT NOT NULL,
  ttl_seconds       INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reinforced   TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
);
CREATE INDEX IF NOT EXISTS msl_facts_agent_idx ON mastra_self_learning_facts (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS msl_facts_search_idx ON mastra_self_learning_facts USING GIN (search_vector);

-- Generated tsvector for FTS over Mastra's skill versions.
-- We don't ALTER mastra_skill_versions (we don't own it); instead we keep our own
-- search projection in a small denormalized table that we refresh on skill create/update.
CREATE TABLE IF NOT EXISTS mastra_self_learning_skill_search (
  skill_id     TEXT PRIMARY KEY REFERENCES mastra_skills(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  instructions TEXT NOT NULL,
  trust_tier   TEXT NOT NULL DEFAULT 'agent-created',
  status       TEXT NOT NULL,
  agent_id     TEXT,
  tags         TEXT[],
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')),         'A') ||
    setweight(to_tsvector('english', coalesce(description, '')),  'B') ||
    setweight(to_tsvector('english', coalesce(instructions, '')), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS msl_skill_search_idx ON mastra_self_learning_skill_search USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS msl_skill_search_agent_status_idx ON mastra_self_learning_skill_search (agent_id, status);
CREATE INDEX IF NOT EXISTS msl_skill_search_tags_idx ON mastra_self_learning_skill_search USING GIN (tags);
```

The `mastra_self_learning_skill_search` table is a **denormalized search projection** — kept in sync with Mastra's versioned skills via the `SkillStorageExtension`'s `createSkill`/`updateSkill` methods. We do this because:

1. We can't `ALTER mastra_skill_versions ADD COLUMN search_vector` (we don't own that table; Mastra might add migrations that conflict).
2. We need a fast FTS-by-`agent_id`+`status` index for the L0 router and the deduplication check.
3. Trust tier and tags are filter-hot fields we want at the table level, not buried in JSONB.

Yes, this is duplication. The alternative (writing FTS queries that join `mastra_skills` → `mastra_skill_versions` and pull metadata fields per-row) is slower and harder to reason about, especially when we want to filter by `trust_tier` which lives in `metadata` JSONB.

## 4. Processors

### Key types in `@mastra/core/processors`

```ts
interface Processor<TId extends string = string, TTripwireMetadata = unknown> {
  readonly id: TId;
  readonly name?: string;
  readonly description?: string;
  readonly providesSkillDiscovery?: 'on-demand';
  processorIndex?: number;
  processDataParts?: boolean;
  onViolation?: (violation: ProcessorViolation) => void | Promise<void>;
  processInput?(args: ProcessInputArgs): Promise<ProcessInputResult> | ProcessInputResult;
  processOutputStream?(args: ProcessOutputStreamArgs): Promise<ChunkType | null | undefined>;
  processOutputResult?(args: ProcessOutputResultArgs): ProcessorMessageResult;
  processInputStep?(args): ...;
  processLLMRequest?(args): ...;
  processLLMResponse?(args): ...;
  processOutputStep?(args): ...;
  processAPIError?(args): ...;
  __registerMastra?(mastra: Mastra<...>): void;
}
```

### Critical findings vs. MVP plan

| MVP plan assumption | Reality |
|---|---|
| `Processor.name` is primary identifier | **WRONG** — `id` is primary; `name` is optional human label |
| `processOutputStream` returns `ChunkType \| null \| undefined` | Correct, but can be `Promise<...>` (async OK) |
| `state: Record<string, any>` per-request | Correct (`Record<string, unknown>`) |
| Single way to get tool calls — accumulate from chunks | **BETTER** — `processOutputResult.args.result.steps[].toolCalls` is already aggregated. The MVP can use `result.steps` directly and skip most chunk-level accumulation. |
| No way to access Mastra for aux LLM | **WRONG** — `__registerMastra(mastra)` lifecycle hook gives processors access. **This resolves R2: Option B (Mastra model resolution) is fully viable.** |
| Mastra has no native skill-discovery concept | **WRONG** — `providesSkillDiscovery?: 'on-demand'` is a built-in declaration on the Processor interface. There may be other parts of Mastra that look at this flag (skill loaders, agent prompt builders). Worth investigating in Phase 2. |

### Chunk types

`ChunkType` is a discriminated union of `AgentChunkType` variants. Relevant ones for the learning loop:

- `{ type: 'tool-call', payload: ToolCallPayload }` — payload has `.toolName`, `.toolCallId`, `.args`
- `{ type: 'tool-result', payload: ToolResultPayload }` — has `.toolCallId`, `.result`
- `{ type: 'step-finish', payload: StepFinishPayload }` — once per agent loop step
- `{ type: 'finish', payload: FinishPayload }` — once per generation
- `{ type: 'error', payload: ErrorPayload }`
- `{ type: 'is-task-complete', payload: IsTaskCompletePayload }` — useful for positive-outcome detection
- `{ type: 'tool-error', payload: ToolErrorPayload }` — failure signal

**Important:** the spec wrote `part.toolName` directly; the real path is `part.payload.toolName`.

### `processOutputResult` is the heavy lifter

Mastra hands us `result.steps: LLMStepResult[]` — already grouped per step, each step has tool calls and results pre-correlated. We don't need to manually match `tool-call` to `tool-result` by `toolCallId`. This **massively simplifies** the extractor and shortens Phase 3.

## 5. Tools

### `createTool` signature

```ts
function createTool<...>(opts: CreateToolOpts<...>): Tool<...>;
```

Where `CreateToolOpts` accepts `id`, `description`, `inputSchema`, `outputSchema`, `execute`, etc. The `execute` callback receives `(inputData, context)` — input data as first positional arg, NOT destructured from `{ context }`:

```ts
createTool({
  id: 'get-weather',
  description: '...',
  inputSchema: z.object({ location: z.string() }),
  execute: async (inputData, context) => {  // ← positional, not destructured
    return await fetchWeather(inputData.location);
  },
});
```

**The MVP Phase 2 plan incorrectly had `execute: async ({ context }) => {...}`.** That destructure pattern was AI-SDK V1 style. Phase 2 implementations must use the positional form.

### `context` shape (the second arg)

Includes `mastra`, `runtimeContext`, `runId`, `threadId`, `resourceId`, `runtimeContext`, etc. — exact shape is `ToolExecutionContext`. Our `skill_feedback` tool will pull `threadId` from this object.

## 6. Versioning Model

Mastra's skill versioning is `versionNumber: integer` (1, 2, 3, ...), not semver. Our `SkillRecord.version` field (semver string) does not align.

**Resolution:** We store our semver string in `mastra_skill_versions.metadata.semver` for display/UX purposes. Mastra's `versionNumber` is the canonical version identifier internally. Refinement creates a new version via Mastra's `update()` (which auto-bumps `versionNumber`) and we record the equivalent semver bump in metadata.

## 7. Mastra Init Lifecycle

```ts
const store = new PostgresStore({ id, connectionString });
// First call to any domain method triggers init() automatically.
// Or call explicitly:
await store.init();
// Idempotent — safe to call multiple times.
```

Our `SkillStorageExtension.ensureSchema()` should:

1. Call `store.init()` first to ensure Mastra's tables exist.
2. Then create our auxiliary tables.

The full operation is idempotent.

## 8. Recommendations for the MVP Plan

These spike findings argue for the following updates to the implementation plan:

### Update 1: Phase 1 ensureSchema

Drop the `ALTER TABLE skills ADD COLUMN ...` approach. We never touch Mastra's tables. Our `ensureSchema()` creates only the four auxiliary tables in §3.

### Update 2: Phase 1 CRUD

`SkillStorageExtension` becomes a **thin adapter** over `SkillsPG` plus our auxiliary tables. `createSkill` calls `skills.create(...)` + INSERTs a row into our `mastra_self_learning_skill_stats` and `mastra_self_learning_skill_search` tables, transactionally if possible. `getSkill` calls `skills.getById(...)` and LEFT JOINs our stats. `updateSkill` calls `skills.update(...)` (which auto-versions) and updates our search projection.

### Update 3: Phase 2 createTool

Switch from `execute: async ({ context }) => ...` to `execute: async (inputData, context) => ...`. Update all 8 tools.

### Update 4: Phase 3 trajectory building

Use `result.steps[].toolCalls` from `processOutputResult` rather than manual chunk accumulation. Keep `processOutputStream` minimal — maybe just for `is-task-complete` detection.

### Update 5: Phase 3 aux LLM

Resolve R2 in favor of **Option B** (Mastra model resolution via `__registerMastra`) as the **default**, with the AI SDK direct (Option C) and callback (Option A) as fallback when Mastra isn't yet registered. This is more idiomatic and aligns with Mastra's processor lifecycle.

## 9. Remaining Unknowns

- **`providesSkillDiscovery` semantics.** What happens when a processor declares this flag? Is there a built-in Mastra prompt builder that defers to such a processor for skill context? If so, we may want to set this on `SkillContextProcessor` and possibly avoid Phase 4's manual system-message merge entirely. **Action:** investigate at the start of Phase 4.
- **Mastra's BlobStore integration with skills.** Skills have `tree?: SkillVersionTree` and `mastra_skill_blobs` table. We currently don't use the BlobStore (we put full content in `instructions: TEXT`). If users want to ship multi-file skills (Hermes Agent supports this), we need to integrate BlobStore. **Defer to post-MVP** — single-file skills are sufficient.
- **`StorageContentSource` for `source?` field.** Could be useful to declare `extractionTrigger`/`threadOrigin` here instead of metadata. **Investigate before Phase 3.**

## 10. Risk Register Updates

| Risk | New status |
|---|---|
| R1 — Mastra API assumptions | **MOSTLY RESOLVED.** SkillsStorage exists and is far richer than expected. We pivot to "thin adapter" framing instead of "additive extension." |
| R2 — Aux LLM pattern | **RESOLVED.** Option B (`__registerMastra`) is the primary recommendation. |
| R4 — Storage backends | Unchanged — Postgres only for MVP. |
| R10 — OM composition | New angle: investigate `providesSkillDiscovery` — Mastra may already have OM-compatible composition primitives we should use. |
