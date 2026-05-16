import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresStore } from '@mastra/pg';
import { createSelfLearningTools } from '../src/tools/skill-tools.js';
import { SkillStorageExtension, type MastraPostgresLike } from '../src/skills/storage-extension.js';
import { serializeSkillDocument } from '../src/skills/parser.js';
import type { SkillFrontmatter } from '../src/skills/types.js';

const PG_IMAGE = 'pgvector/pgvector:pg16';

const FM: SkillFrontmatter = {
  name: 'gcp-cloud-run-deploy',
  description: 'Deploy a containerized service to Cloud Run with traffic splitting',
  version: '1.0.0',
  author: 'agent',
  trust: 'agent-created',
  tags: ['gcp', 'cloud-run', 'deployment'],
  platforms: ['gcp'],
  complexity: 3,
};

const BODY = `## When to Use

Deploy with traffic splitting.

## Prerequisites

- gcloud CLI
- Docker image

## Procedure

1. Verify image.
2. Deploy revision.
3. Split traffic.

## Verification

Service is healthy.

## Pitfalls

Cold start latency.
`;

const FULL_CONTENT = serializeSkillDocument(FM, BODY);

let container: StartedPostgreSqlContainer;
let store: PostgresStore;
let storage: SkillStorageExtension;
let tools: ReturnType<typeof createSelfLearningTools>;

beforeAll(async () => {
  container = await new PostgreSqlContainer(PG_IMAGE)
    .withDatabase('mastra_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  store = new PostgresStore({ id: 'sl-tools-test', connectionString: container.getConnectionUri() });
  storage = new SkillStorageExtension(store as unknown as MastraPostgresLike);
  await storage.ensureSchema();
  tools = createSelfLearningTools({ storage, agentId: 'ops-agent' });
}, 120_000);

afterAll(async () => {
  try {
    await store?.close?.();
  } catch {
    // ignore
  }
  if (container) await container.stop();
}, 30_000);

beforeEach(async () => {
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

const mkContext = () =>
  ({
    agent: {
      agentId: 'ops-agent',
      threadId: 'thread-test',
      toolCallId: 'tc-1',
      messages: [],
      suspend: async () => undefined,
    },
  }) as unknown as Parameters<NonNullable<typeof tools.skill_feedback.execute>>[1];

describe('Tier-1 tools — end-to-end through createTool execute()', () => {
  it('skill_create persists a skill and runs the scanner', async () => {
    const result = await tools.skill_create.execute!({ content: FULL_CONTENT }, mkContext());
    expect(result.skill.name).toBe(FM.name);
    expect(result.skill.status).toBe('active');
    expect(result.scanFindings).toEqual([]);

    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(FM.name);
  });

  it('skill_create with unsafe content routes to draft and surfaces findings', async () => {
    const unsafeBody = '## Procedure\n\nRun `rm -rf /` to clear.\n';
    const unsafeContent = serializeSkillDocument(
      { ...FM, name: 'unsafe-skill' },
      unsafeBody,
    );
    const result = await tools.skill_create.execute!({ content: unsafeContent }, mkContext());
    expect(result.skill.status).toBe('draft');
    expect(result.scanFindings.length).toBeGreaterThan(0);
    expect(result.scanFindings.some((f) => f.type === 'destructive-command')).toBe(true);
  });

  it('skill_list returns the L0 summary after a create', async () => {
    await tools.skill_create.execute!({ content: FULL_CONTENT }, mkContext());
    const result = await tools.skill_list.execute!({ limit: 50 }, mkContext());
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe(FM.name);
    expect(result.skills[0].tags).toEqual(FM.tags);
  });

  it('skill_list filters by tags (AND semantics)', async () => {
    await tools.skill_create.execute!({ content: FULL_CONTENT }, mkContext());
    await tools.skill_create.execute!(
      {
        content: serializeSkillDocument(
          { ...FM, name: 'k8s-rollback', description: 'Rollback k8s', tags: ['k8s'] },
          '## Procedure\n\nkubectl rollout undo.\n',
        ),
      },
      mkContext(),
    );
    const result = await tools.skill_list.execute!({ tags: ['gcp'] }, mkContext());
    expect(result.skills.map((s) => s.name)).toEqual([FM.name]);
  });

  it('skill_view L1 returns full content; L2 returns just the section', async () => {
    await tools.skill_create.execute!({ content: FULL_CONTENT }, mkContext());
    const l1 = await tools.skill_view.execute!({ name: FM.name }, mkContext());
    expect(l1.found).toBe(true);
    expect(l1.content).toContain('## Procedure');
    expect(l1.content).toContain('## Pitfalls');

    const l2 = await tools.skill_view.execute!(
      { name: FM.name, section: 'Pitfalls' },
      mkContext(),
    );
    expect(l2.found).toBe(true);
    expect(l2.content).toBe('Cold start latency.');
  });

  it('skill_view returns found=false for missing skill', async () => {
    const r = await tools.skill_view.execute!({ name: 'nope' }, mkContext());
    expect(r.found).toBe(false);
    expect(r.content).toBe('');
  });

  it('skill_search returns FTS-ranked results', async () => {
    await tools.skill_create.execute!({ content: FULL_CONTENT }, mkContext());
    await tools.skill_create.execute!(
      {
        content: serializeSkillDocument(
          {
            ...FM,
            name: 'k8s-rollback',
            description: 'Rollback a Kubernetes deployment',
            tags: ['k8s'],
          },
          '## Procedure\n\nkubectl rollout undo deployment/SERVICE.\n',
        ),
      },
      mkContext(),
    );
    const result = await tools.skill_search.execute!(
      { query: 'kubernetes rollback', limit: 5 },
      mkContext(),
    );
    expect(result.results[0].name).toBe('k8s-rollback');
  });

  it('skill_update persists a new version with a unified diff', async () => {
    await tools.skill_create.execute!({ content: FULL_CONTENT }, mkContext());
    const updatedBody = BODY.replace('Cold start latency.', 'Cold start + IAM propagation latency.');
    const updatedContent = serializeSkillDocument(FM, updatedBody);
    const result = await tools.skill_update.execute!(
      { name: FM.name, content: updatedContent, reason: 'add IAM pitfall' },
      mkContext(),
    );
    expect(result.skill.version).toBe('1.0.1');

    const versions = await storage.listVersions(result.skill.id);
    // 3 versions exist: initial (auto), updateSkill bump, plus our explicit createVersion call
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const last = versions.find((v) => v.reason === 'add IAM pitfall');
    expect(last?.diffFromPrevious).toMatch(/IAM propagation/);
  });

  it('skill_update throws on missing skill', async () => {
    await expect(
      tools.skill_update.execute!(
        { name: 'nope', content: FULL_CONTENT, reason: 'x' },
        mkContext(),
      ),
    ).rejects.toThrow(/Skill not found/);
  });

  it('skill_feedback increments counters and writes a usage row', async () => {
    const created = await tools.skill_create.execute!({ content: FULL_CONTENT }, mkContext());
    const ok = await tools.skill_feedback.execute!(
      {
        name: FM.name,
        outcome: 'success',
        durationMs: 1234,
        toolCalls: 6,
      },
      mkContext(),
    );
    expect(ok.recorded).toBe(true);

    const stats = await storage.getUsageStats(
      (await storage.getSkillByName(FM.name, 'ops-agent'))!.id,
    );
    expect(stats.totalUses).toBe(1);
    expect(stats.successRate).toBe(1);
    expect(stats.avgToolCalls).toBe(6);
    expect(created.skill.id).toBeDefined();
  });

  it('skill_feedback soft-fails on missing skill', async () => {
    const r = await tools.skill_feedback.execute!(
      { name: 'nope', outcome: 'success' },
      mkContext(),
    );
    expect(r).toEqual({ recorded: false });
  });

  it('memory_persist / memory_recall are wired to the real FactLayer (Phase 4)', async () => {
    const persist = await tools.memory_persist.execute!(
      { category: 'preference', content: 'prefers structured logging' },
      mkContext(),
    );
    expect(persist.persisted).toBe(true);
    expect(persist.id).toBeDefined();

    const recall = await tools.memory_recall.execute!(
      { query: 'logging', limit: 5 },
      mkContext(),
    );
    expect(recall.facts.length).toBeGreaterThanOrEqual(1);
    expect(recall.facts[0].content).toMatch(/structured logging/);
  });
});
