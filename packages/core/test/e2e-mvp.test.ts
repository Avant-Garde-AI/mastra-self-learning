/**
 * The single end-to-end MVP exit-gate test.
 *
 * Walks the full closed loop against a real Postgres (Testcontainers) with a
 * deterministically scripted auxiliary LLM:
 *
 *   ACT 1  Complex task in thread A           → skill auto-extracted
 *   ACT 2  New thread B starts                → skill appears in L0 index
 *   ACT 3  Agent follows skill, reports success → usage recorded, counters bump
 *   ACT 4  Skill fails + user corrects        → skill refined → new version + diff
 *
 * If this passes, the MVP user story is satisfied.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresStore } from '@mastra/pg';
import {
  SkillStorageExtension,
  type MastraPostgresLike,
} from '../src/skills/storage-extension.js';
import { createSelfLearningProcessor } from '../src/processors/self-learning-processor.js';
import { createSkillContextProcessor } from '../src/processors/skill-context-processor.js';
import { createSelfLearningTools } from '../src/tools/skill-tools.js';
import { serializeSkillDocument } from '../src/skills/parser.js';
import { IdentitySchema } from '../src/config.js';
import type { SkillFrontmatter } from '../src/skills/types.js';

const PG_IMAGE = 'pgvector/pgvector:pg16';
const SKILL_NAME = 'gcp-cloud-run-deploy';

function skillMd(version: string, pitfalls: string): string {
  const fm: SkillFrontmatter = {
    name: SKILL_NAME,
    description: 'Deploy a containerized service to Cloud Run with traffic splitting',
    version,
    author: 'agent',
    trust: 'agent-created',
    tags: ['gcp', 'cloud-run', 'deployment'],
    complexity: 3,
  };
  return serializeSkillDocument(
    fm,
    `## When to Use

Deploy a containerized service to Cloud Run with gradual traffic splitting.

## Prerequisites

- gcloud CLI authenticated
- Docker image in Artifact Registry

## Procedure

1. Verify the image exists with gcloud_run_describe.
2. Deploy a new revision with --no-traffic.
3. Split traffic gradually with gcloud_run_services_update_traffic.

## Verification

No 5xx errors for 10 minutes after the split.

## Pitfalls

${pitfalls}
`,
  );
}

const SKILL_V1 = skillMd('1.0.0', 'Cold start latency on the first request.');
const SKILL_V2 = skillMd(
  '1.0.1',
  'Cold start latency on the first request.\n- IAM propagation delay: wait 60s after granting roles before deploying.',
);

const toolCall = (toolName: string, args: Record<string, unknown>, id: string) => ({
  type: 'tool-call' as const,
  payload: { toolName, args, toolCallId: id },
});
const toolResult = (id: string, result: unknown) => ({
  type: 'tool-result' as const,
  payload: { toolCallId: id, result },
});
const stepFinish = () => ({ type: 'step-finish' as const, payload: {} });

let container: StartedPostgreSqlContainer;
let store: PostgresStore;
let storage: SkillStorageExtension;

beforeAll(async () => {
  container = await new PostgreSqlContainer(PG_IMAGE)
    .withDatabase('mastra_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  store = new PostgresStore({ id: 'sl-e2e', connectionString: container.getConnectionUri() });
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

describe('MVP exit gate — full closed loop', () => {
  it('extract → recall → feedback → refine', async () => {
    // Scripted aux LLM. Calls, in order:
    //   1. generalizability (ACT 1)  → YES
    //   2. synthesis        (ACT 1)  → SKILL_V1
    //   3. refinement       (ACT 4)  → SKILL_V2
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(SKILL_V1)
      .mockResolvedValueOnce(SKILL_V2);

    const outProc = createSelfLearningProcessor({
      storage,
      generate,
      agentId: 'ops-agent',
      // Disable cooldown so ACT 4 isn't blocked by ACT 1's extraction timer.
      extraction: { cooldownMs: 0 },
      // ACT 1 creates v1 milliseconds before ACT 4 refines; real tasks span
      // minutes. Disable the per-skill refinement cooldown for this test.
      refinementCooldownMs: 0,
    });
    const inProc = createSkillContextProcessor({
      storage,
      agentId: 'ops-agent',
      identity: IdentitySchema.parse({
        personality: 'You are a GCP deployment expert.',
        expertise: ['gcp', 'cloud-run'],
      }),
    });
    const tools = createSelfLearningTools({ storage, agentId: 'ops-agent' });
    const ctx = (threadId: string) =>
      ({
        agent: {
          agentId: 'ops-agent',
          threadId,
          toolCallId: 'tc',
          messages: [],
          suspend: async () => undefined,
        },
      }) as unknown as Parameters<NonNullable<typeof tools.skill_feedback.execute>>[1];

    // ─── ACT 1: complex task in thread A → extraction ────────────────────
    {
      const state: Record<string, unknown> = {};
      const calls = [
        'gcloud_run_describe',
        'gcloud_run_deploy',
        'gcloud_run_describe',
        'gcloud_run_services_update_traffic',
        'gcloud_logging_read',
        'gcloud_run_services_update_traffic',
      ];
      calls.forEach((name, i) => {
        outProc.processOutputStream({ part: toolCall(name, { i }, `a-${i}`), state });
        outProc.processOutputStream({ part: toolResult(`a-${i}`, 'ok'), state });
      });
      for (let i = 0; i < 4; i++) {
        outProc.processOutputStream({ part: stepFinish(), state });
      }
      await outProc.processOutputResult({
        state,
        result: { text: 'Deployment complete.', finishReason: 'stop', steps: [] },
        messages: [{ role: 'user', content: 'perfect, thanks — that worked great' }],
        requestContext: {
          get: (k: string) =>
            k === 'threadId' ? 'thread-A' : k === 'agentId' ? 'ops-agent' : undefined,
        },
      });
      await outProc._waitForPendingExtractions();
    }

    const afterAct1 = await storage.listSkills({ agentId: 'ops-agent' });
    expect(afterAct1).toHaveLength(1);
    expect(afterAct1[0].name).toBe(SKILL_NAME);
    expect(afterAct1[0].trustTier).toBe('agent-created');
    expect(afterAct1[0].status).toBe('active');
    const md = (afterAct1[0].frontmatter.metadata?.mastra ?? {}) as Record<string, unknown>;
    expect(md.threadOrigin).toBe('thread-A');
    expect(md.extractionTrigger).toBe('auto');
    const skillId = afterAct1[0].id;

    // ─── ACT 2: new thread B → skill appears in L0 index ─────────────────
    {
      const result = await inProc.processInput({
        messages: [{ role: 'user', content: 'I need to deploy our API to Cloud Run safely' }],
        systemMessages: [{ role: 'system', content: 'You are a helpful assistant.' }],
        state: {},
      });
      const injected = result.systemMessages.map((m) => m.content).join('\n');
      expect(injected).toContain('## Identity');
      expect(injected).toContain('GCP deployment expert');
      expect(injected).toContain('# Available Skills');
      expect(injected).toContain(SKILL_NAME);
    }

    // ─── ACT 3: agent follows the skill, reports success ─────────────────
    {
      const view = await tools.skill_view.execute!({ name: SKILL_NAME }, ctx('thread-B'));
      expect(view.found).toBe(true);
      expect(view.content).toContain('## Procedure');

      const fb = await tools.skill_feedback.execute!(
        { name: SKILL_NAME, outcome: 'success', durationMs: 4200, toolCalls: 6 },
        ctx('thread-B'),
      );
      expect(fb.recorded).toBe(true);

      const stats = await storage.getUsageStats(skillId);
      expect(stats.totalUses).toBe(1);
      expect(stats.successRate).toBe(1);
      const refreshed = await storage.getSkill(skillId);
      expect(refreshed?.successCount).toBe(1);
    }

    // ─── ACT 4: skill fails + user correction → refinement ───────────────
    {
      const state: Record<string, unknown> = {};
      // Agent loads the skill, then it fails.
      outProc.processOutputStream({
        part: toolCall('skill_view', { name: SKILL_NAME }, 'd-0'),
        state,
      });
      outProc.processOutputStream({ part: toolResult('d-0', SKILL_V1), state });
      outProc.processOutputStream({
        part: toolCall('gcloud_run_deploy', { service: 'svc' }, 'd-1'),
        state,
      });
      outProc.processOutputStream({ part: toolResult('d-1', 'PERMISSION_DENIED'), state });
      outProc.processOutputStream({
        part: toolCall(
          'skill_feedback',
          { name: SKILL_NAME, outcome: 'failure', feedback: 'deploy denied' },
          'd-2',
        ),
        state,
      });
      outProc.processOutputStream({ part: toolResult('d-2', { recorded: true }), state });
      for (let i = 0; i < 3; i++) {
        outProc.processOutputStream({ part: stepFinish(), state });
      }

      // Record the failure usage (as the real skill_feedback tool would).
      await tools.skill_feedback.execute!(
        { name: SKILL_NAME, outcome: 'failure', feedback: 'deploy denied' },
        ctx('thread-C'),
      );

      await outProc.processOutputResult({
        state,
        result: { text: 'The deployment failed with PERMISSION_DENIED.', finishReason: 'stop', steps: [] },
        messages: [
          {
            role: 'user',
            content:
              "no, that won't work because we just granted the IAM role and it hasn't propagated yet",
          },
        ],
        requestContext: {
          get: (k: string) =>
            k === 'threadId' ? 'thread-C' : k === 'agentId' ? 'ops-agent' : undefined,
        },
      });
      await outProc._waitForPendingExtractions();
    }

    // Refinement assertions.
    const versions = await storage.listVersions(skillId);
    // At minimum: v1 (extraction), plus the refinement version.
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const refinementVersion = versions.find((v) => v.version === '1.0.1');
    expect(refinementVersion).toBeDefined();
    expect(refinementVersion!.diffFromPrevious).toMatch(/IAM propagation/);

    const finalSkill = await storage.getSkill(skillId);
    expect(finalSkill?.version).toBe('1.0.1');
    expect(finalSkill?.content).toMatch(/IAM propagation delay/);
    expect(finalSkill?.failCount).toBe(1);
  });
});
