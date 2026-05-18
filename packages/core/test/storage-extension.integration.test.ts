import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresStore } from '@mastra/pg';
import {
  SkillStorageExtension,
  SkillNameConflictError,
  type MastraPostgresLike,
} from '../src/skills/storage-extension.js';
import { serializeSkillDocument } from '../src/skills/parser.js';
import type { SkillFrontmatter } from '../src/skills/types.js';

// pgvector-enabled image so semantic columns can be tested later. The first pull
// is slow; cache the container per file.
const PG_IMAGE = 'pgvector/pgvector:pg16';

const FIXTURE_FRONTMATTER: SkillFrontmatter = {
  name: 'gcp-cloud-run-deploy',
  description: 'Deploy a containerized service to Cloud Run with traffic splitting',
  version: '1.0.0',
  author: 'agent',
  trust: 'agent-created',
  tags: ['gcp', 'cloud-run', 'deployment'],
  platforms: ['gcp'],
  complexity: 3,
};

const FIXTURE_BODY = `## When to Use

Use this when deploying to Cloud Run.

## Prerequisites

- gcloud CLI authenticated
- Docker image pushed

## Procedure

1. Verify image exists.
2. Deploy revision.
3. Split traffic.

## Verification

Service health is green.

## Pitfalls

Cold start latency.
`;

const FIXTURE_CONTENT = serializeSkillDocument(FIXTURE_FRONTMATTER, FIXTURE_BODY);

let container: StartedPostgreSqlContainer | null = null;
let store: PostgresStore;
let storage: SkillStorageExtension;

beforeAll(async () => {
  container = await new PostgreSqlContainer(PG_IMAGE)
    .withDatabase('mastra_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  const connectionString = container.getConnectionUri();
  store = new PostgresStore({ id: 'sl-test', connectionString });
  storage = new SkillStorageExtension(store as unknown as MastraPostgresLike);
  await storage.ensureSchema();
}, 120_000);

afterAll(async () => {
  try {
    await store?.close?.();
  } catch {
    // ignore
  }
  if (container) {
    await container.stop();
  }
}, 30_000);

beforeEach(async () => {
  // Each test gets a clean slate.
  await store.db.none(`
    TRUNCATE
      mastra_self_learning_skill_usage,
      mastra_self_learning_skill_stats,
      mastra_self_learning_skill_search,
      mastra_self_learning_facts,
      mastra_skill_versions,
      mastra_skills
    RESTART IDENTITY CASCADE
  `);
});

describe('SkillStorageExtension.ensureSchema', () => {
  it('is idempotent on second call', async () => {
    await expect(storage.ensureSchema()).resolves.toBeUndefined();
    await expect(storage.ensureSchema()).resolves.toBeUndefined();
  });

  it('creates all auxiliary tables', async () => {
    const tables = await store.db.any<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'mastra_self_learning%'
       ORDER BY table_name`,
    );
    const names = tables.map((t) => t.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'mastra_self_learning_facts',
        'mastra_self_learning_skill_search',
        'mastra_self_learning_skill_stats',
        'mastra_self_learning_skill_usage',
      ]),
    );
  });

  it('reports pgvector availability when extension is present', () => {
    // The pgvector/pgvector image ships the extension.
    expect(storage.semanticSearchAvailable).toBe(true);
  });
});

describe('SkillStorageExtension CRUD', () => {
  it('createSkill round-trips name/description and writes auxiliary rows', async () => {
    const skill = await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });

    expect(skill.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID shape
    expect(skill.name).toBe(FIXTURE_FRONTMATTER.name);
    expect(skill.successCount).toBe(0);
    expect(skill.trustTier).toBe('agent-created');

    // Auxiliary rows
    const statsCount = await store.db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mastra_self_learning_skill_stats WHERE skill_id = $1`,
      [skill.id],
    );
    expect(Number(statsCount.count)).toBe(1);

    const searchCount = await store.db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mastra_self_learning_skill_search WHERE skill_id = $1`,
      [skill.id],
    );
    expect(Number(searchCount.count)).toBe(1);
  });

  it('getSkillByName retrieves a stored skill', async () => {
    await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    const fetched = await storage.getSkillByName(FIXTURE_FRONTMATTER.name, 'ops-agent');
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe(FIXTURE_FRONTMATTER.name);
    expect(fetched?.frontmatter.tags).toEqual(['gcp', 'cloud-run', 'deployment']);
  });

  it('null agentId scopes to global skills', async () => {
    await storage.createSkill({
      name: 'global-skill',
      version: '1.0.0',
      content: serializeSkillDocument({ ...FIXTURE_FRONTMATTER, name: 'global-skill' }, FIXTURE_BODY),
      frontmatter: { ...FIXTURE_FRONTMATTER, name: 'global-skill' },
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: null,
    });
    const found = await storage.getSkillByName('global-skill');
    expect(found?.agentId).toBeNull();
  });

  it('throws SkillNameConflictError on duplicate name within same agent scope', async () => {
    await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    await expect(
      storage.createSkill({
        name: FIXTURE_FRONTMATTER.name,
        version: '1.0.0',
        content: FIXTURE_CONTENT,
        frontmatter: FIXTURE_FRONTMATTER,
        trustTier: 'agent-created',
        status: 'active',
        successCount: 0,
        failCount: 0,
        agentId: 'ops-agent',
      }),
    ).rejects.toThrow(SkillNameConflictError);
  });

  it('listSkills returns active skills ordered by recency', async () => {
    await storage.createSkill({
      name: 'a-skill',
      version: '1.0.0',
      content: serializeSkillDocument({ ...FIXTURE_FRONTMATTER, name: 'a-skill' }, FIXTURE_BODY),
      frontmatter: { ...FIXTURE_FRONTMATTER, name: 'a-skill' },
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    await storage.createSkill({
      name: 'b-skill',
      version: '1.0.0',
      content: serializeSkillDocument({ ...FIXTURE_FRONTMATTER, name: 'b-skill' }, FIXTURE_BODY),
      frontmatter: { ...FIXTURE_FRONTMATTER, name: 'b-skill' },
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list.map((s) => s.name).sort()).toEqual(['a-skill', 'b-skill']);
  });

  it('updateSkill creates a new version and bumps the semver', async () => {
    const created = await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    const newBody = FIXTURE_BODY.replace('Cold start latency.', 'Cold start + IAM propagation latency.');
    const newContent = serializeSkillDocument(FIXTURE_FRONTMATTER, newBody);
    const updated = await storage.updateSkill(created.id, { content: newContent });

    expect(updated.version).toBe('1.0.1');
    expect(updated.content).toContain('IAM propagation latency');

    const versions = await storage.listVersions(created.id);
    expect(versions.length).toBe(2);
  });

  it('listVersions returns DESC by versionNumber', async () => {
    const created = await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    await storage.createVersion({
      skillId: created.id,
      version: '1.0.1',
      content: FIXTURE_CONTENT,
      diffFromPrevious: '+ a line',
      reason: 'manual diff test',
    });
    const versions = await storage.listVersions(created.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    // Newest first
    expect(versions[0].reason).toBe('manual diff test');
  });
});

describe('SkillStorageExtension usage tracking', () => {
  it('recordUsage updates counters atomically', async () => {
    const created = await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });

    for (let i = 0; i < 3; i++) {
      await storage.recordUsage({
        skillId: created.id,
        threadId: `thread-${i}`,
        agentId: 'ops-agent',
        outcome: 'success',
        durationMs: 1000,
        toolCalls: 5,
      });
    }
    for (let i = 0; i < 2; i++) {
      await storage.recordUsage({
        skillId: created.id,
        threadId: `thread-fail-${i}`,
        agentId: 'ops-agent',
        outcome: 'failure',
        durationMs: 500,
        toolCalls: 3,
      });
    }

    const stats = await storage.getUsageStats(created.id);
    expect(stats.totalUses).toBe(5);
    expect(stats.successRate).toBeCloseTo(0.6, 2);
    expect(stats.avgToolCalls).toBeCloseTo((5 * 3 + 3 * 2) / 5, 2);

    const refetched = await storage.getSkill(created.id);
    expect(refetched?.successCount).toBe(3);
    expect(refetched?.failCount).toBe(2);
    expect(refetched?.lastUsed).not.toBeNull();
  });

  it('partial / abandoned outcomes update only last_used', async () => {
    const created = await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    await storage.recordUsage({
      skillId: created.id,
      threadId: 't',
      agentId: 'ops-agent',
      outcome: 'partial',
      durationMs: 100,
      toolCalls: 1,
    });
    const stats = await storage.getUsageStats(created.id);
    expect(stats.totalUses).toBe(1);
    const refetched = await storage.getSkill(created.id);
    expect(refetched?.successCount).toBe(0);
    expect(refetched?.failCount).toBe(0);
    expect(refetched?.lastUsed).not.toBeNull();
  });

  it('returns zero stats when no usage rows exist', async () => {
    const created = await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    const stats = await storage.getUsageStats(created.id);
    expect(stats).toEqual({ totalUses: 0, successRate: 0, avgDurationMs: 0, avgToolCalls: 0 });
  });

  it('soft-fails on FK violation when parent skill was deleted', async () => {
    const created = await storage.createSkill({
      name: FIXTURE_FRONTMATTER.name,
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    // Delete the parent skill
    await store.db.none(`DELETE FROM mastra_skills WHERE id = $1`, [created.id]);
    // Should not throw
    await expect(
      storage.recordUsage({
        skillId: created.id,
        threadId: 't',
        agentId: 'ops-agent',
        outcome: 'success',
        durationMs: 1,
        toolCalls: 1,
      }),
    ).resolves.toBeDefined();
  });
});

describe('SkillStorageExtension.search (FTS)', () => {
  beforeEach(async () => {
    await storage.createSkill({
      name: 'gcp-cloud-run-deploy',
      version: '1.0.0',
      content: FIXTURE_CONTENT,
      frontmatter: FIXTURE_FRONTMATTER,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    await storage.createSkill({
      name: 'k8s-rollback',
      version: '1.0.0',
      content: serializeSkillDocument(
        { ...FIXTURE_FRONTMATTER, name: 'k8s-rollback', description: 'Rollback a Kubernetes deployment to a previous revision', tags: ['k8s', 'rollback'] },
        '## Procedure\n\nRun kubectl rollout undo deployment/SERVICE.',
      ),
      frontmatter: { ...FIXTURE_FRONTMATTER, name: 'k8s-rollback', description: 'Rollback a Kubernetes deployment to a previous revision', tags: ['k8s', 'rollback'] },
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
  });

  it('returns matches ranked by relevance', async () => {
    const results = await storage.search({
      query: 'kubernetes rollback',
      mode: 'fts',
      agentId: 'ops-agent',
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].skill.name).toBe('k8s-rollback');
    expect(results[0].matchType).toBe('fts');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('matches Cloud Run query to the deploy skill', async () => {
    const results = await storage.search({
      query: 'cloud run deploy traffic',
      mode: 'fts',
      agentId: 'ops-agent',
    });
    expect(results[0].skill.name).toBe('gcp-cloud-run-deploy');
  });

  it('returns empty for unmatched query', async () => {
    const results = await storage.search({
      query: 'completely unrelated nonsense xyzzy',
      mode: 'fts',
      agentId: 'ops-agent',
    });
    expect(results).toEqual([]);
  });

  it('semantic / hybrid without a query vector degrade to FTS (no throw)', async () => {
    // This `storage` has no embedder configured.
    const sem = await storage.search({
      query: 'kubernetes rollback',
      mode: 'semantic',
      agentId: 'ops-agent',
    });
    const hyb = await storage.search({
      query: 'kubernetes rollback',
      mode: 'hybrid',
      agentId: 'ops-agent',
    });
    expect(sem.length).toBeGreaterThan(0);
    expect(hyb.length).toBeGreaterThan(0);
    expect(sem[0].matchType).toBe('fts');
    expect(hyb[0].matchType).toBe('fts');
  });

  it('semantic search with a query embedding ranks by cosine (pgvector)', async () => {
    const { SkillStorageExtension } = await import('../src/skills/storage-extension.js');
    const { hashEmbedder } = await import('../src/skills/embedding.js');
    // The vector column dim is fixed by the suite's beforeAll storage (1536).
    const embed = hashEmbedder(1536);
    const semStore = new SkillStorageExtension(store as unknown as never, {
      embed,
      embeddingDimensions: 1536,
    });
    await semStore.ensureSchema();
    await semStore.backfillEmbeddings({ all: true });

    const [qvec] = await embed(['rollback a kubernetes deployment']);
    const results = await semStore.search({
      query: 'rollback a kubernetes deployment',
      mode: 'semantic',
      queryEmbedding: qvec,
      agentId: 'ops-agent',
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe('semantic');
    expect(results[0].skill.name).toBe('k8s-rollback');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('filters by agentId', async () => {
    const results = await storage.search({
      query: 'cloud run',
      mode: 'fts',
      agentId: 'different-agent',
    });
    expect(results).toEqual([]);
  });
});
