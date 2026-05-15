# Phase 1 — Storage Foundation

## Goal

After this phase, `SkillStorageExtension` is a fully functional persistence layer against Postgres: it creates its schema on demand, performs all CRUD operations on skills, version history, and usage records, and exposes a working FTS search against skill content. Nothing in the agent loop runs yet — but every downstream phase has a real storage object to call.

This is the **critical-path** phase. Phases 2–5 cannot start in parallel — they all depend on the storage contract this phase nails down.

## Prerequisites

- A running Postgres instance (local Docker is fine) reachable via `DATABASE_URL`.
- `@mastra/core` peer-dep resolved at `^1.25.0`. The package's `devDependencies` pin `^1.31.0` for testing; `node_modules` are not currently installed — `pnpm install` must succeed first.
- `@mastra/pg` available as the Postgres backend (`^1.31.0` already pinned in `devDependencies`).
- A copy of `@mastra/core`'s source or distributed `.d.ts` files available for **API inspection** (see Task 1.0 below).

## Task Breakdown

### 1.0 — Inspect Mastra's storage and skills APIs (blocking spike)

**Why this is first:** Every downstream task in this phase assumes a specific shape for `MastraStorage`, `SkillsStorage`, `createTool`, and the `Processor` interface. The spec describes these APIs from a designer's view; we have not yet verified the exact TypeScript signatures, method names, or behavior. Do this before writing any extension code.

**Steps:**

1. Run `pnpm install` at the monorepo root. Confirm `node_modules/@mastra/core` and `node_modules/@mastra/pg` populate.
2. Open `node_modules/@mastra/core/dist` and locate the type declarations for:
   - `MastraStorage` (or whatever the storage base class is named)
   - `SkillsStorage` (the skills domain mentioned in `01-architecture.md`)
   - `BlobStore` / `S3BlobStore`
   - `createTool` factory and the `Tool` interface
   - `Processor`, `ProcessorState`, `MastraMessageV2`, `ChunkType`, `TracingContext`
3. Open `node_modules/@mastra/pg` and locate `PostgresStore` (or equivalent). Note its constructor signature, what raw-SQL escape hatch it exposes (a `.query()`? a `.db` property? a `.client`?), and whether it owns a connection pool.
4. Write findings to a new file `packages/core/MASTRA_API_NOTES.md`. Include for each API:
   - File path in `node_modules`
   - Exact TypeScript signature
   - Whether the API behaves as the spec describes, or diverges
   - The escape hatch we will use when no public API exists (e.g., the raw SQL client we'll use to add `skill_versions`)

**Specific questions this spike must answer:**

| Question | Why it matters |
|---|---|
| Does `SkillsStorage` already create a `skills` table? With what columns? | Decides whether we `ALTER TABLE` or own the table outright. |
| Does `SkillsStorage` expose `listSkills`, `getSkill`, `createSkill`, etc., or do we hit raw storage? | Decides whether our extension wraps Mastra's domain or sidesteps it. |
| How are skills *versioned* in Mastra's built-in scheme? Separate table? `version` column? Content-addressed BlobStore? | Decides whether our `skill_versions` table duplicates work or augments. |
| What is the exact `Processor` interface shape (especially `processOutputStream` and `processOutputResult`)? | Phase 3 cannot start until we know this. |
| Does `processOutputStream` truly receive a `state` object that survives across chunks? | Core assumption of the whole learning loop. |
| What is the public type of `agent.tools` — is it `Record<string, Tool>` or a richer shape? | Decides the return type of `createSelfLearningTools`. |
| Does `createTool` validate that `execute` returns data matching `outputSchema`? | Decides how strict our `outputSchema`s need to be. |
| Can we access the raw `pg.Pool` from `PostgresStore` to run `CREATE TABLE IF NOT EXISTS`? | Required for `ensureSchema()`. |

**Output:** `packages/core/MASTRA_API_NOTES.md` with answers to each question and code references. **Stop and ask the user** if any answer breaks a core assumption before continuing (e.g., if Mastra does not in fact ship a `SkillsStorage` domain in the version we depend on).

**Estimated scope:** 1–2 days of focused reading. No production code is written in this task.

---

### 1.1 — Implement `SkillStorageExtension.ensureSchema()`

**File:** `packages/core/src/skills/storage-extension.ts`

**Mastra surface used:** Whatever raw SQL escape hatch the API spike revealed in Task 1.0 (likely `PostgresStore.db` or `PostgresStore.pool`).

**What it does:**

`ensureSchema()` creates or augments the storage tables needed for the learning loop. Idempotent — safe to call on every process start. Throws if the storage backend is not Postgres in v0.1.0 (LibSQL / MongoDB are deferred).

**Schema to create (Postgres DDL, MVP-final):**

```sql
-- Skills table.
-- If Mastra's SkillsStorage already owns `skills`, we ALTER TABLE to add the
-- six learning-loop columns. If not, we CREATE TABLE outright.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS success_count INT NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS fail_count    INT NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS last_used     TIMESTAMPTZ;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS trust_tier    TEXT NOT NULL DEFAULT 'agent-created';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_id      TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS embedding     VECTOR;  -- nullable; pgvector optional

-- Generated tsvector column for FTS. Coalesce nulls so missing fields don't break the index.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')),        'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')),     'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS skills_search_idx        ON skills USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS skills_agent_status_idx  ON skills (agent_id, status);

-- Skill version history.
CREATE TABLE IF NOT EXISTS skill_versions (
  id            TEXT PRIMARY KEY,          -- ULID
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version       TEXT NOT NULL,             -- semver string
  content       TEXT NOT NULL,             -- full SKILL.md snapshot
  diff          TEXT,                      -- unified diff from previous version
  reason        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);
CREATE INDEX IF NOT EXISTS skill_versions_skill_idx ON skill_versions (skill_id, created_at DESC);

-- Skill usage tracking.
CREATE TABLE IF NOT EXISTS skill_usage (
  id           TEXT PRIMARY KEY,           -- ULID
  skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  thread_id    TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial', 'abandoned')),
  feedback     TEXT,
  duration_ms  INT NOT NULL DEFAULT 0,
  tool_calls   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_usage_skill_idx ON skill_usage (skill_id, created_at DESC);

-- Facts (used by Phase 4 but the table belongs here so storage owns it).
CREATE TABLE IF NOT EXISTS facts (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT,
  category           TEXT NOT NULL CHECK (category IN (
    'preference','context','project','credential','constraint','relationship'
  )),
  content            TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 1.0,
  source_thread_id   TEXT NOT NULL,
  ttl_seconds        INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reinforced    TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector      TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
);
CREATE INDEX IF NOT EXISTS facts_agent_idx        ON facts (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS facts_search_idx       ON facts USING GIN (search_vector);
```

**Implementation notes:**

- Run the DDL inside a single transaction. If any statement fails, roll back so the database is unchanged.
- The `VECTOR` column type requires the `pgvector` extension. In v0.1.0, **make the column optional** — if `CREATE EXTENSION IF NOT EXISTS vector` fails (no extension, no superuser), skip the `embedding` column entirely and continue. Log a warning that semantic search will be unavailable until pgvector is installed.
- The `skills` table may or may not exist depending on whether Mastra's `SkillsStorage` has been initialized. The `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` form handles both cases; if `skills` doesn't exist at all, fall through to a `CREATE TABLE skills (...)` path with the full column set, so the package is usable without Mastra's domain being initialized first.
- Use `pg_catalog` queries (`SELECT 1 FROM pg_class WHERE relname = 'skills'`) to detect existence rather than relying on `IF NOT EXISTS` semantics alone, so we can log "creating fresh" vs. "augmenting existing".

**Edge cases:**

- **Permission errors on `CREATE EXTENSION`**: Catch, log, continue without `pgvector`. Mark the storage instance as `semanticSearchAvailable: false` (an internal flag) so Phase 4 can detect and either error or silently fall back to FTS-only.
- **Race condition on first call:** If two processes call `ensureSchema()` concurrently, Postgres `IF NOT EXISTS` clauses serialize correctly. No application-level lock needed.
- **Pre-existing `skills` table with conflicting column types:** Validate column types via `information_schema.columns` before issuing `ALTER` statements. Throw a clear error pointing the user at the manual migration path if conflicts are detected.

**Testing:** Integration test against a Testcontainers Postgres instance. Run `ensureSchema()` on fresh DB, assert all expected tables and columns exist. Run again, assert no errors. Drop one column, run again, assert column is restored.

---

### 1.2 — Implement `SkillStorageExtension` CRUD

**File:** `packages/core/src/skills/storage-extension.ts`

**Methods to implement (signatures already in the stub):**

```ts
createSkill(skill: Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<SkillRecord>
getSkill(id: string): Promise<SkillRecord | null>
getSkillByName(name: string, agentId?: string): Promise<SkillRecord | null>
updateSkill(id: string, updates: Partial<SkillRecord>): Promise<SkillRecord>
listSkills(options?: { agentId?: string; trustTiers?: TrustTier[]; status?: SkillRecord['status']; limit?: number; offset?: number }): Promise<SkillRecord[]>
```

**Implementation logic:**

- `createSkill`: Generate ULID for `id`. Run `parseSkillDocument(skill.content)` defensively to validate frontmatter matches `skill.frontmatter`. Set `createdAt`/`updatedAt` to `now()`. `INSERT ... RETURNING *`. Return the freshly inserted record reshaped to `SkillRecord` (snake_case → camelCase).
- `getSkill` / `getSkillByName`: Plain `SELECT * WHERE id = $1` / `WHERE name = $1 AND (agent_id = $2 OR ($2 IS NULL AND agent_id IS NULL))`. Note the null-agent matching is for global skills.
- `updateSkill`: Build a dynamic `UPDATE skills SET col1 = $1, ... RETURNING *` from the provided keys. Always bump `updated_at = now()`. Reject `id`, `createdAt`, `successCount`, `failCount`, `lastUsed` from the update payload (those have dedicated methods).
- `listSkills`: Filter by all provided options. Default `status = 'active'` and `agentId = null OR agentId = options.agentId` (so global + agent-specific skills both show). Order by `last_used DESC NULLS LAST, created_at DESC`. Default limit = 100.

**Type mapping:** The DB stores `snake_case`, the TS types are `camelCase`. Build a single `rowToSkillRecord(row)` helper to centralize the mapping, including JSON-parsing the `frontmatter` column (or re-parsing `content` via `parseSkillDocument` — decide in Task 1.0; both work, parsing the column is faster).

**Edge cases:**

- **Duplicate name within agent scope:** `INSERT` will violate a unique constraint (we add `UNIQUE (name, agent_id)` in 1.1 — add it). Catch the unique-violation error and rethrow as a typed `SkillNameConflictError`.
- **Updating `name` to collide with another skill:** Same unique-violation path.
- **`getSkillByName` with no `agentId`:** Must match only global skills (`agent_id IS NULL`). Document this clearly in the JSDoc.

**Testing:** Integration tests against Testcontainers Postgres. Insert / list / update / re-list. Verify unique constraint by inserting duplicate name. Verify camelCase round-trip.

---

### 1.3 — Implement `SkillStorageExtension` version history

**File:** `packages/core/src/skills/storage-extension.ts`

**Methods:**

```ts
createVersion(version: Omit<SkillVersionRecord, 'id' | 'createdAt'>): Promise<SkillVersionRecord>
listVersions(skillId: string): Promise<SkillVersionRecord[]>
```

**Logic:**

- `createVersion`: Generate ULID. `INSERT INTO skill_versions ... RETURNING *`. The caller (Phase 5 refiner) is responsible for computing the unified diff against the previous version; the storage layer just persists what it's given.
- `listVersions`: `SELECT * FROM skill_versions WHERE skill_id = $1 ORDER BY created_at DESC`.

**Why this lives in Phase 1 even though the refiner is in Phase 5:** Storage owns its tables. Implementing the methods now (against the schema we just created) means Phase 5 has nothing to invent — it just calls `storage.createVersion(...)`.

**Testing:** Integration test — insert a skill, create two versions, list. Assert ordering and `UNIQUE (skill_id, version)` enforcement.

---

### 1.4 — Implement `SkillStorageExtension` usage tracking

**File:** `packages/core/src/skills/storage-extension.ts`

**Methods:**

```ts
recordUsage(usage: Omit<SkillUsageRecord, 'id' | 'createdAt'>): Promise<SkillUsageRecord>
getUsageStats(skillId: string): Promise<{ totalUses: number; successRate: number; avgDurationMs: number; avgToolCalls: number }>
```

**Logic for `recordUsage`:**

This method does **two writes in one transaction**:

1. `INSERT INTO skill_usage (...) VALUES (...) RETURNING *`.
2. Atomically increment counters on the parent `skills` row:
   ```sql
   UPDATE skills
   SET success_count = success_count + CASE WHEN $1 = 'success' THEN 1 ELSE 0 END,
       fail_count    = fail_count    + CASE WHEN $1 = 'failure' THEN 1 ELSE 0 END,
       last_used     = now()
   WHERE id = $2;
   ```

Wrapping in a transaction prevents the parent row from drifting if the usage `INSERT` succeeds but the counter `UPDATE` fails (or vice versa). `partial` and `abandoned` outcomes update `last_used` only.

**Logic for `getUsageStats`:**

Single aggregation query:

```sql
SELECT
  COUNT(*)::INT AS total_uses,
  AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END)::FLOAT AS success_rate,
  COALESCE(AVG(duration_ms), 0)::FLOAT AS avg_duration_ms,
  COALESCE(AVG(tool_calls), 0)::FLOAT  AS avg_tool_calls
FROM skill_usage
WHERE skill_id = $1;
```

Return `{ totalUses: 0, successRate: 0, avgDurationMs: 0, avgToolCalls: 0 }` if no rows.

**Edge cases:**

- **Recording usage for a skill that was deleted mid-task:** `FK skill_id` will fail. Treat as a soft failure — log the error, don't throw to the caller. The agent loop should not crash because the agent edited skills mid-task.

**Testing:** Integration test — record 3 successes + 2 failures, assert `getUsageStats` returns `successRate ≈ 0.6` and counters on the parent row are correct.

---

### 1.5 — Validate `parseSkillDocument` / `serializeSkillDocument` against edge cases

**File:** `packages/core/src/skills/parser.ts` (already implemented; this task is hardening)

**What's already done:** gray-matter wrapping for frontmatter parsing, body trimming, `extractSection` for L2 access.

**What's missing — add tests for:**

- Missing frontmatter entirely (raw markdown, no `---` block) → must not crash, must produce `frontmatter.name = 'unnamed-skill'`, `description = ''`.
- Frontmatter present but `name` field missing → same defaults.
- Frontmatter with extra unknown fields → preserved on round-trip.
- YAML parse errors (malformed YAML) → gray-matter throws; wrap and rethrow as typed `SkillParseError`.
- `extractSection` with case-insensitive matching (`## Procedure` vs. `## procedure`).
- `extractSection` when section is the last in the document (no trailing `##` boundary).
- `extractSection` when the requested section doesn't exist → returns `null` (already implemented; just verify).
- Round-trip stability: `serialize(parse(doc)) === doc` for a real Hermes Agent skill file (fixture).

**Fix expected:** the current implementation silently produces `frontmatter.name = 'unnamed-skill'` for documents missing a `name`. Consider whether to make this stricter — for MVP, keep it lenient but log a warning.

**Files to add:** `packages/core/src/skills/parser.test.ts`.

---

### 1.6 — Add tests for `scanSkillContent`

**File:** `packages/core/src/skills/scanner.ts` (already implemented) + new `scanner.test.ts`

**What's there:** Six regex pattern categories: destructive `rm -rf`, SQL `DROP`, `curl | sh`, hardcoded credentials, prompt injection, jailbreak strings.

**Tests to add:**

- One positive test per pattern category, asserting `safe: false` and correct `type` / `severity` / `line`.
- A negative test using a real benign skill (e.g., a fixture of `gcp-cloud-run-deploy.md`) asserting `safe: true`.
- A false-positive sanity check: skills that *describe* destructive operations as something to *avoid* (e.g., "Do not run `rm -rf /`") will trigger the regex. Document this as a known limitation; the Phase 2 LLM scan would catch the context. For the MVP, accept that benign procedural docs about dangerous commands get flagged → they go to `status: 'draft'` and a human reviews.

---

### 1.7 — Implement `SkillSearch` (FTS only)

**File:** `packages/core/src/skills/search.ts`

**What MVP needs:** A `search({ query, mode: 'fts', limit, ... })` that uses Postgres `tsvector` and returns results ranked by `ts_rank_cd`. `mode: 'semantic'` and `mode: 'hybrid'` throw with a clear "Phase 4" message.

**Query:**

```sql
SELECT *,
       ts_rank_cd(search_vector, plainto_tsquery('english', $1)) AS rank
FROM skills
WHERE search_vector @@ plainto_tsquery('english', $1)
  AND ($2::text IS NULL OR agent_id = $2 OR agent_id IS NULL)
  AND status = 'active'
  AND ($3::text[] IS NULL OR trust_tier = ANY($3))
  AND ($4::text[] IS NULL OR tags && $4)  -- only if tags are stored as a text[]
ORDER BY rank DESC
LIMIT $5;
```

Map results to `SkillSearchResult[]` with `matchType: 'fts'` and `score = rank`.

**Note on `tags`:** The schema in 1.1 doesn't include a `tags` column on `skills` because tags live inside the frontmatter (and thus in `content`). FTS over `content` will match tag terms naturally. If tag-based filtering becomes a hot path, denormalize tags into a column post-MVP.

**Testing:** Integration test — insert 3 skills with distinct content, search for terms from each, assert correct ranking.

---

### 1.8 — Wire up the public API surface

**File:** `packages/core/src/index.ts` (already exports correctly; verify no broken type imports)

Confirm:
- `SkillStorageExtension` is exported with full types
- All Phase 1 modules compile cleanly with `pnpm typecheck`
- Stub tools (Phase 2 will fill them in) still export type-correctly

---

## Critical Integration Points

1. **Mastra `SkillsStorage` may not exist in the version we pin.** The spec dates this feature to Feb 2026 (this conversation's date is May 2026, so it should exist), but we have not verified. If Task 1.0 reveals there is no `SkillsStorage` domain in `@mastra/core@^1.25.0`, switch to owning the `skills` table outright and document the divergence loudly. Do not block the MVP on a Mastra feature that hasn't shipped.

2. **`PostgresStore`'s raw-SQL escape hatch.** We need to issue arbitrary SQL for `ensureSchema()` and the FTS query. If Mastra's storage abstracts SQL completely, we fall back to importing `pg` directly and constructing our own pool from the same `DATABASE_URL`. Note this as a hack in `MASTRA_API_NOTES.md` and revisit when Mastra exposes a query primitive.

3. **`createTool` exact signature.** The spec's example signature is illustrative. Verify against real source — particularly whether `execute` receives `{ context }` or `{ input }`, and whether `runtimeContext` is available the way we assume.

4. **`SkillsStorage` BlobStore.** If Mastra stores skill content in a BlobStore (S3 or local), our `content TEXT` column in the `skills` table will conflict. Option: accept the BlobStore reference (`content_blob_id`) and dereference on read; track this in 1.0's notes.

## Exit Criteria

This phase is done when **every** statement below is testable and true:

- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm test packages/core/src/skills/parser.test.ts` passes (8+ cases).
- [ ] `pnpm test packages/core/src/skills/scanner.test.ts` passes (7+ cases).
- [ ] An integration test calling `ensureSchema()` against a fresh Testcontainers Postgres database creates all expected tables/columns and is idempotent.
- [ ] An integration test inserts 3 skills, lists them, searches via `tsvector`, and the results are ranked correctly.
- [ ] An integration test records 5 usages and `getUsageStats` returns the correct aggregates.
- [ ] Version history insert + list round-trips with `UNIQUE (skill_id, version)` enforced.
- [ ] `MASTRA_API_NOTES.md` exists and answers every question in Task 1.0.

## Estimated Scope

| Sub-task | Files touched | Complexity |
|---|---|---|
| 1.0 Spike | New: `MASTRA_API_NOTES.md` | Medium — reading-heavy |
| 1.1 ensureSchema | `storage-extension.ts` | Medium |
| 1.2 CRUD | `storage-extension.ts` | Medium |
| 1.3 Versions | `storage-extension.ts` | Low |
| 1.4 Usage | `storage-extension.ts` | Low-medium |
| 1.5 Parser tests | New: `parser.test.ts` | Low |
| 1.6 Scanner tests | New: `scanner.test.ts` | Low |
| 1.7 Search | `search.ts`, integration test | Low-medium |
| 1.8 API surface | `index.ts` | Trivial |

**Total**: roughly 8 files written/modified. Estimated 1.5 weeks for a single experienced TypeScript developer, dominated by Task 1.0 (spike) and Task 1.1 (`ensureSchema` DDL).
