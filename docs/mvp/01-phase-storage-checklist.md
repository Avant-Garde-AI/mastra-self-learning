# Phase 1 — Storage Foundation Checklist

Use this as the live tracker while building Phase 1. Each item is a discrete, verifiable unit. Refer to `01-phase-storage.md` for the *how* behind each line.

## 1.0 — Mastra API spike

- [ ] `pnpm install` succeeds; `node_modules/@mastra/core` and `@mastra/pg` present
- [ ] Inspected `MastraStorage` / storage base class type declarations
- [ ] Inspected `SkillsStorage` domain (or confirmed it does not exist in pinned version)
- [ ] Inspected `BlobStore` / `S3BlobStore` types
- [ ] Inspected `createTool` factory signature
- [ ] Inspected `Processor`, `ProcessorState`, `MastraMessageV2`, `ChunkType`, `TracingContext`
- [ ] Inspected `PostgresStore` constructor + raw-SQL escape hatch
- [ ] Created `packages/core/MASTRA_API_NOTES.md` with answers to all 8 spike questions
- [ ] Confirmed (or escalated to user) any divergence from spec assumptions

## 1.1 — `ensureSchema()`

- [ ] Tries `CREATE EXTENSION IF NOT EXISTS vector`; logs warning on failure, continues without
- [ ] `ALTER TABLE skills` adds: `success_count`, `fail_count`, `last_used`, `trust_tier`, `agent_id`, `embedding`, `search_vector`
- [ ] Fallback `CREATE TABLE skills (...)` path when Mastra's domain hasn't created it
- [ ] `CREATE INDEX skills_search_idx` (GIN on `search_vector`)
- [ ] `CREATE INDEX skills_agent_status_idx`
- [ ] `CREATE TABLE skill_versions` with FK + `UNIQUE (skill_id, version)` + index
- [ ] `CREATE TABLE skill_usage` with FK + `CHECK outcome IN (...)` + index
- [ ] `CREATE TABLE facts` with category CHECK + `search_vector` GIN index
- [ ] All DDL wrapped in a single transaction with rollback on failure
- [ ] Idempotency verified: second call is a no-op
- [ ] Integration test: ensureSchema → assert tables/columns → ensureSchema again → no errors

## 1.2 — Skill CRUD

- [ ] `createSkill()` — ULID generation, parse validation, `INSERT RETURNING *`, camelCase mapping
- [ ] `getSkill(id)` — returns `null` when missing
- [ ] `getSkillByName(name, agentId?)` — null-agent matching documented
- [ ] `updateSkill(id, updates)` — dynamic SET, bumps `updated_at`, rejects forbidden keys
- [ ] `listSkills(options)` — filters + ordering + default limit 100
- [ ] `UNIQUE (name, agent_id)` enforced; duplicate insert throws typed `SkillNameConflictError`
- [ ] `rowToSkillRecord()` helper centralizes mapping
- [ ] Integration test: insert/list/update/duplicate

## 1.3 — Version history

- [ ] `createVersion()` — ULID, INSERT RETURNING *
- [ ] `listVersions()` — DESC by `created_at`
- [ ] Integration test: insert two versions, list, verify `UNIQUE (skill_id, version)`

## 1.4 — Usage tracking

- [ ] `recordUsage()` runs as a transaction with skill counter UPDATE
- [ ] `partial` / `abandoned` outcomes update `last_used` only
- [ ] Foreign key failure on deleted skill is logged as soft failure, not thrown
- [ ] `getUsageStats()` returns zero-defaults when no rows
- [ ] Integration test: 3 successes + 2 failures → successRate ≈ 0.6, counters correct

## 1.5 — Parser tests

- [ ] Missing frontmatter → default `unnamed-skill` + warning
- [ ] Missing `name` field → default
- [ ] Extra unknown fields preserved on round-trip
- [ ] Malformed YAML → typed `SkillParseError`
- [ ] `extractSection` case-insensitive
- [ ] `extractSection` for trailing section (no `##` boundary)
- [ ] `extractSection` non-existent → `null`
- [ ] Round-trip stability test with Hermes fixture

## 1.6 — Scanner tests

- [ ] Positive test per pattern category (6 cases)
- [ ] Benign skill fixture → `safe: true`
- [ ] False-positive documented (procedural docs about `rm -rf`)

## 1.7 — `SkillSearch` (FTS)

- [ ] `search({ mode: 'fts' })` returns ranked results via `ts_rank_cd`
- [ ] Filters: `agentId`, `trustTiers`, `status = 'active'`
- [ ] `mode: 'semantic'` and `'hybrid'` throw "Phase 4" error
- [ ] Integration test: 3 skills, search by each, verify ranking

## 1.8 — Public API

- [ ] `pnpm typecheck` clean
- [ ] `packages/core/src/index.ts` exports compile against the real implementations
- [ ] No `unknown` types remain in the storage public surface

## Exit gate

- [ ] All Phase 1-relevant success criteria from `00-vision.md` (#1 storage) pass
- [ ] `MASTRA_API_NOTES.md` exists with all 8 questions answered
- [ ] Integration test suite runs against Testcontainers Postgres in CI
