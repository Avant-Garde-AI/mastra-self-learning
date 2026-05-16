import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresStore } from '@mastra/pg';
import {
  SkillStorageExtension,
  type MastraPostgresLike,
} from '../src/skills/storage-extension.js';
import { FactLayer } from '../src/memory/fact-layer.js';
import { FactLayerConfigSchema, IdentitySchema } from '../src/config.js';
import { createSkillContextProcessor } from '../src/processors/skill-context-processor.js';
import { createSelfLearningProcessor } from '../src/processors/self-learning-processor.js';
import { createSelfLearningTools } from '../src/tools/skill-tools.js';
import { serializeSkillDocument } from '../src/skills/parser.js';
import type { SkillFrontmatter } from '../src/skills/types.js';

const PG_IMAGE = 'pgvector/pgvector:pg16';

const FM: SkillFrontmatter = {
  name: 'gcp-cloud-run-deploy',
  description: 'Deploy a containerized service to Cloud Run with traffic splitting',
  version: '1.0.0',
  author: 'agent',
  trust: 'agent-created',
  tags: ['gcp', 'cloud-run'],
  complexity: 3,
};
const SKILL_CONTENT = serializeSkillDocument(
  FM,
  '## When to Use\n\nDeploy.\n\n## Procedure\n\n1. Deploy.\n\n## Verification\n\nHealthy.\n',
);

let container: StartedPostgreSqlContainer;
let store: PostgresStore;
let storage: SkillStorageExtension;

beforeAll(async () => {
  container = await new PostgreSqlContainer(PG_IMAGE)
    .withDatabase('mastra_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  store = new PostgresStore({ id: 'sl-ctx-test', connectionString: container.getConnectionUri() });
  storage = new SkillStorageExtension(store as unknown as MastraPostgresLike);
  await storage.ensureSchema();
}, 120_000);

afterAll(async () => {
  try {
    await store?.close?.();
  } catch {
    /* ignore */
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

describe('FactLayer', () => {
  const fl = () =>
    new FactLayer(storage, FactLayerConfigSchema.parse({}), 'ops-agent');

  it('persists and recalls a fact by keyword', async () => {
    const layer = fl();
    await layer.persistFact({
      category: 'preference',
      content: 'User prefers Terraform over ClickOps',
      confidence: 1.0,
      sourceThreadId: 't-1',
    });
    const recalled = await layer.getRelevantFacts('terraform');
    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toMatch(/Terraform/);
    expect(recalled[0].confidence).toBe(1);
  });

  it('soft-dedups identical content (reinforces instead of inserting)', async () => {
    const layer = fl();
    const first = await layer.persistFact({
      category: 'preference',
      content: 'Region is us-central1',
      confidence: 0.5,
      sourceThreadId: 't-1',
    });
    const second = await layer.persistFact({
      category: 'preference',
      content: 'Region is us-central1',
      confidence: 0.5,
      sourceThreadId: 't-2',
    });
    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(1); // reinforced to full
    const all = await layer.getRelevantFacts('');
    expect(all).toHaveLength(1);
  });

  it('reinforceFact resets confidence to 1.0', async () => {
    const layer = fl();
    const f = await layer.persistFact({
      category: 'context',
      content: 'GKE 1.28',
      confidence: 0.3,
      sourceThreadId: 't-1',
    });
    await layer.reinforceFact(f.id);
    const recalled = await layer.getRelevantFacts('GKE');
    expect(recalled[0].confidence).toBe(1);
  });

  it('applyDecay reduces confidence for stale facts', async () => {
    const layer = fl();
    const f = await layer.persistFact({
      category: 'context',
      content: 'Budget ceiling is 2000 USD',
      confidence: 1.0,
      sourceThreadId: 't-1',
    });
    // Backdate last_reinforced by 10 weeks.
    await store.db.none(
      `UPDATE mastra_self_learning_facts SET last_reinforced = now() - interval '70 days' WHERE id = $1`,
      [f.id],
    );
    const updated = await layer.applyDecay();
    expect(updated).toBeGreaterThanOrEqual(1);
    const refetched = await store.db.one<{ confidence: number }>(
      `SELECT confidence FROM mastra_self_learning_facts WHERE id = $1`,
      [f.id],
    );
    expect(Number(refetched.confidence)).toBeLessThan(1);
  });

  it('excludes TTL-expired facts from recall', async () => {
    const layer = fl();
    const f = await layer.persistFact({
      category: 'context',
      content: 'Ephemeral build flag enabled',
      confidence: 1.0,
      sourceThreadId: 't-1',
      ttl: 1,
    });
    await store.db.none(
      `UPDATE mastra_self_learning_facts SET created_at = now() - interval '10 seconds' WHERE id = $1`,
      [f.id],
    );
    const recalled = await layer.getRelevantFacts('ephemeral');
    expect(recalled).toHaveLength(0);
  });

  it('buildFactsBlock returns empty string with no facts', async () => {
    expect(await fl().buildFactsBlock()).toBe('');
  });

  it('buildFactsBlock formats facts with category + confidence', async () => {
    const layer = fl();
    await layer.persistFact({
      category: 'project',
      content: 'Project Atlas is the Q3 migration',
      confidence: 0.9,
      sourceThreadId: 't-1',
    });
    const block = await layer.buildFactsBlock();
    expect(block).toContain('## Facts');
    expect(block).toContain('- (project) Project Atlas is the Q3 migration [confidence: 0.90]');
  });
});

describe('SkillContextProcessor.processInput — system message assembly', () => {
  it('assembles Identity → Facts → Skills in order', async () => {
    // Seed a skill + a fact.
    await storage.createSkill({
      name: FM.name,
      version: '1.0.0',
      content: SKILL_CONTENT,
      frontmatter: FM,
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    const fl = new FactLayer(storage, FactLayerConfigSchema.parse({}), 'ops-agent');
    await fl.persistFact({
      category: 'preference',
      content: 'Prefers YAML over JSON',
      confidence: 1.0,
      sourceThreadId: 't-seed',
    });

    const processor = createSkillContextProcessor({
      storage,
      identity: IdentitySchema.parse({
        personality: 'You are a DevOps automation expert.',
        expertise: ['gcp'],
      }),
      agentId: 'ops-agent',
    });

    const result = await processor.processInput({
      messages: [{ role: 'user', content: 'deploy something' }],
      systemMessages: [{ role: 'system', content: 'You are a helpful assistant.' }],
      state: {},
    });

    // The developer instruction stays first; our block is appended.
    expect(result.systemMessages[0].content).toBe('You are a helpful assistant.');
    const ourBlock = result.systemMessages[1].content;
    const idIdx = ourBlock.indexOf('## Identity');
    const factIdx = ourBlock.indexOf('## Facts');
    const skillIdx = ourBlock.indexOf('# Available Skills');
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(factIdx).toBeGreaterThan(idIdx);
    expect(skillIdx).toBeGreaterThan(factIdx);
    expect(ourBlock).toContain('DevOps automation expert');
    expect(ourBlock).toContain('Prefers YAML over JSON');
    expect(ourBlock).toContain('gcp-cloud-run-deploy');
  });

  it('omits empty blocks (no identity, no facts) and still injects skills', async () => {
    await storage.createSkill({
      name: 'solo-skill',
      version: '1.0.0',
      content: serializeSkillDocument(
        { ...FM, name: 'solo-skill' },
        '## Procedure\n\nStep.\n',
      ),
      frontmatter: { ...FM, name: 'solo-skill' },
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      agentId: 'ops-agent',
    });
    const processor = createSkillContextProcessor({ storage, agentId: 'ops-agent' });
    const result = await processor.processInput({
      messages: [],
      systemMessages: [],
      state: {},
    });
    expect(result.systemMessages).toHaveLength(1);
    expect(result.systemMessages[0].content).toContain('# Available Skills');
    expect(result.systemMessages[0].content).not.toContain('## Identity');
    expect(result.systemMessages[0].content).not.toContain('## Facts');
  });

  it('emits a nudge message every nudgeInterval turns', async () => {
    const processor = createSkillContextProcessor({
      storage,
      agentId: 'ops-agent',
      factLayer: { nudgeInterval: 3 },
    });
    const state: Record<string, unknown> = {};
    let lastResult;
    for (let i = 0; i < 3; i++) {
      lastResult = await processor.processInput({
        messages: [],
        systemMessages: [],
        state,
      });
    }
    const hasNudge = lastResult!.systemMessages.some((m) =>
      m.content.includes('Self-Learning Note'),
    );
    expect(hasNudge).toBe(true);
  });

  it('does not nudge before the interval', async () => {
    const processor = createSkillContextProcessor({
      storage,
      agentId: 'ops-agent',
      factLayer: { nudgeInterval: 10 },
    });
    const state: Record<string, unknown> = {};
    const result = await processor.processInput({
      messages: [],
      systemMessages: [],
      state,
    });
    expect(
      result.systemMessages.some((m) => m.content.includes('Self-Learning Note')),
    ).toBe(false);
  });
});

describe('memory_persist / memory_recall tools — real FactLayer', () => {
  it('round-trips a fact through the tools', async () => {
    const tools = createSelfLearningTools({ storage, agentId: 'ops-agent' });
    const ctx = {
      agent: { agentId: 'ops-agent', threadId: 't-mem', toolCallId: 'tc', messages: [], suspend: async () => undefined },
    } as unknown as Parameters<NonNullable<typeof tools.memory_persist.execute>>[1];

    const persisted = await tools.memory_persist.execute!(
      { category: 'credential', content: 'GCP project ID is atlas-prod-2026' },
      ctx,
    );
    expect(persisted.persisted).toBe(true);
    expect(persisted.id).toBeDefined();

    const recalled = await tools.memory_recall.execute!(
      { query: 'project id', limit: 5 },
      ctx,
    );
    expect(recalled.facts.length).toBeGreaterThanOrEqual(1);
    expect(recalled.facts[0].content).toMatch(/atlas-prod-2026/);
    expect(recalled.facts[0].category).toBe('credential');
  });

  it('memory_recall filters by category', async () => {
    const tools = createSelfLearningTools({ storage, agentId: 'ops-agent' });
    const ctx = {
      agent: { agentId: 'ops-agent', threadId: 't', toolCallId: 'tc', messages: [], suspend: async () => undefined },
    } as unknown as Parameters<NonNullable<typeof tools.memory_persist.execute>>[1];
    await tools.memory_persist.execute!({ category: 'preference', content: 'likes dark mode' }, ctx);
    await tools.memory_persist.execute!({ category: 'project', content: 'project zeta launching' }, ctx);
    const onlyPrefs = await tools.memory_recall.execute!(
      { query: '', category: 'preference', limit: 10 },
      ctx,
    );
    expect(onlyPrefs.facts.every((f) => f.category === 'preference')).toBe(true);
  });
});

describe('Closed loop — cross-thread skill recall (Vision criterion #11)', () => {
  it('a skill extracted in thread A appears in the L0 index for thread B', async () => {
    // --- Thread A: extraction via the output processor ---
    const validSkill = serializeSkillDocument(
      {
        name: 'cross-thread-skill',
        description: 'A procedure learned in thread A',
        version: '1.0.0',
        author: 'agent',
        trust: 'agent-created',
        tags: ['demo'],
        complexity: 2,
      },
      '## When to Use\n\nDemo.\n\n## Procedure\n\n1. Do.\n\n## Verification\n\nDone.\n',
    );
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(validSkill);

    const outProc = createSelfLearningProcessor({
      storage,
      generate,
      agentId: 'ops-agent',
    });

    const stateA: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) {
      outProc.processOutputStream({
        part: { type: 'tool-call', payload: { toolName: `tool_${i}`, args: { i }, toolCallId: `tc-${i}` } },
        state: stateA,
      });
      outProc.processOutputStream({
        part: { type: 'tool-result', payload: { toolCallId: `tc-${i}`, result: 'ok' } },
        state: stateA,
      });
    }
    for (let i = 0; i < 4; i++) {
      outProc.processOutputStream({ part: { type: 'step-finish', payload: {} }, state: stateA });
    }
    await outProc.processOutputResult({
      state: stateA,
      result: { text: 'Done.', finishReason: 'stop', steps: [] },
      messages: [{ role: 'user', content: 'perfect, thanks' }],
      requestContext: {
        get: (k: string) =>
          k === 'threadId' ? 'thread-A' : k === 'agentId' ? 'ops-agent' : undefined,
      },
    });
    await outProc._waitForPendingExtractions();

    // Sanity: the skill exists in storage.
    const stored = await storage.listSkills({ agentId: 'ops-agent' });
    expect(stored.map((s) => s.name)).toContain('cross-thread-skill');

    // --- Thread B: the input processor injects the L0 index ---
    const inProc = createSkillContextProcessor({ storage, agentId: 'ops-agent' });
    const resultB = await inProc.processInput({
      messages: [{ role: 'user', content: 'I have a new but similar task' }],
      systemMessages: [{ role: 'system', content: 'Assistant.' }],
      state: {},
    });
    const injected = resultB.systemMessages.map((m) => m.content).join('\n');
    expect(injected).toContain('cross-thread-skill');
  });
});
