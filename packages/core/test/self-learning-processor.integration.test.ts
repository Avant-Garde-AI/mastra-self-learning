import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresStore } from '@mastra/pg';
import {
  createSelfLearningProcessor,
  type SelfLearningProcessor,
} from '../src/processors/self-learning-processor.js';
import {
  SkillStorageExtension,
  type MastraPostgresLike,
} from '../src/skills/storage-extension.js';
import { serializeSkillDocument } from '../src/skills/parser.js';
import type { SkillFrontmatter } from '../src/skills/types.js';

const PG_IMAGE = 'pgvector/pgvector:pg16';

/**
 * A canned, parseable SKILL.md that the synthesis stub returns. Mirrors what a
 * real auxiliary LLM would emit — frontmatter + 5 standard sections.
 */
function synthesisFixture(name: string, description: string): string {
  const fm: SkillFrontmatter = {
    name,
    description,
    version: '1.0.0',
    author: 'agent',
    trust: 'agent-created',
    tags: ['gcp', 'cloud-run', 'deployment'],
    complexity: 3,
  };
  return serializeSkillDocument(
    fm,
    `## When to Use

Deploy to Cloud Run with traffic splitting.

## Prerequisites

- gcloud CLI
- Docker image

## Procedure

1. Verify the image exists.
2. Deploy with --no-traffic.
3. Split traffic gradually.

## Verification

The service is healthy.

## Pitfalls

Cold start latency.
`,
  );
}

const mkToolCall = (toolName: string, args: Record<string, unknown>, toolCallId: string) => ({
  type: 'tool-call' as const,
  payload: { toolName, args, toolCallId },
});

const mkToolResult = (toolCallId: string, result: unknown) => ({
  type: 'tool-result' as const,
  payload: { toolCallId, result },
});

const mkStepFinish = () => ({ type: 'step-finish' as const, payload: {} });

let container: StartedPostgreSqlContainer;
let store: PostgresStore;
let storage: SkillStorageExtension;

beforeAll(async () => {
  container = await new PostgreSqlContainer(PG_IMAGE)
    .withDatabase('mastra_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  store = new PostgresStore({
    id: 'sl-processor-test',
    connectionString: container.getConnectionUri(),
  });
  storage = new SkillStorageExtension(store as unknown as MastraPostgresLike);
  await storage.ensureSchema();
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

// Drive a "trajectory" through the processor by replaying chunks.
async function runScenario(
  processor: SelfLearningProcessor,
  opts: {
    toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
    turns: number;
    finalUserMessage?: string;
    threadId?: string;
    agentId?: string;
  },
) {
  const state: Record<string, unknown> = {};

  // Feed tool-call + tool-result chunks.
  opts.toolCalls.forEach((c, i) => {
    const callId = `tc-${i}`;
    processor.processOutputStream({
      part: mkToolCall(c.name, c.input, callId),
      state,
    });
    processor.processOutputStream({
      part: mkToolResult(callId, 'ok'),
      state,
    });
  });
  // Turn markers
  for (let i = 0; i < opts.turns; i++) {
    processor.processOutputStream({ part: mkStepFinish(), state });
  }

  await processor.processOutputResult({
    state,
    requestContext: {
      get: (k: string) =>
        k === 'threadId'
          ? opts.threadId ?? 'thread-test'
          : k === 'agentId'
            ? opts.agentId ?? 'ops-agent'
            : undefined,
    },
    messages: [
      { role: 'user', content: opts.finalUserMessage ?? 'thanks, that worked' },
    ],
    result: {
      text: 'Done.',
      finishReason: 'stop',
      steps: [],
    },
  });

  await processor._waitForPendingExtractions();
}

describe('SelfLearningProcessor — Phase 3 end-to-end', () => {
  it('extracts a skill when policy thresholds are met and synthesis is valid', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(synthesisFixture('gcp-cloud-run-deploy', 'Deploy a service to Cloud Run with traffic splitting'));
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      agentId: 'ops-agent',
    });

    await runScenario(processor, {
      toolCalls: [
        { name: 'gcloud_run_deploy', input: { service: 'svc-A' } },
        { name: 'gcloud_run_describe', input: { service: 'svc-A' } },
        { name: 'gcloud_run_services_update_traffic', input: { to: 10 } },
        { name: 'gcloud_run_describe', input: { service: 'svc-B' } },
        { name: 'gcloud_logging_read', input: { filter: 'severity>=ERROR' } },
        { name: 'gcloud_run_services_update_traffic', input: { to: 100 } },
      ],
      turns: 4,
    });

    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('gcp-cloud-run-deploy');
    expect(list[0].trustTier).toBe('agent-created');
    expect(list[0].status).toBe('active');
    // Provenance metadata
    const md = (list[0].frontmatter.metadata?.mastra ?? {}) as Record<string, unknown>;
    expect(md.threadOrigin).toBe('thread-test');
    expect(md.extractionTrigger).toBe('auto');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('skips extraction below minToolCalls threshold', async () => {
    const generate = vi.fn();
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      agentId: 'ops-agent',
    });

    await runScenario(processor, {
      toolCalls: [
        { name: 'gcloud_run_deploy', input: { service: 'svc' } },
        { name: 'gcloud_run_describe', input: { service: 'svc' } },
      ],
      turns: 4,
    });

    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('skips extraction when positiveOutcome cannot be inferred', async () => {
    const generate = vi.fn();
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      agentId: 'ops-agent',
    });
    await runScenario(processor, {
      toolCalls: Array.from({ length: 6 }, (_, i) => ({
        name: `tool_${i}`,
        input: {},
      })),
      turns: 4,
      finalUserMessage: 'hmm, that did not quite work',
    });
    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('deduplicates on the second similar trajectory (tool names appearing in skill content)', async () => {
    // Synthesis fixture that explicitly mentions the tool name (`gcloud_run_describe`)
    // in the Procedure section, so FTS can match it from the dedup query.
    // This reflects realistic LLM behavior — synthesized procedures usually
    // reference the actual commands they wrap.
    const fixtureWithToolName = serializeSkillDocument(
      {
        name: 'gcp-cloud-run-status-checks',
        description: 'Verify Cloud Run service status using gcloud_run_describe',
        version: '1.0.0',
        author: 'agent',
        trust: 'agent-created',
        tags: ['gcp', 'cloud-run'],
        complexity: 3,
      },
      `## When to Use

Check the status of a Cloud Run service after deployment.

## Prerequisites

- gcloud CLI installed

## Procedure

1. Run \`gcloud_run_describe\` for each service.
2. Inspect status.conditions[*].

## Verification

All services report Ready=True.

## Pitfalls

None known.
`,
    );

    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(fixtureWithToolName);
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      extraction: { cooldownMs: 0 },
      agentId: 'ops-agent',
    });

    // First trajectory — extracts.
    await runScenario(processor, {
      toolCalls: Array.from({ length: 6 }, (_, i) => ({
        name: `gcloud_run_describe`,
        input: { i },
      })),
      turns: 4,
    });
    let list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(1);

    // Second near-identical — dedup should fire.
    await runScenario(processor, {
      toolCalls: Array.from({ length: 6 }, (_, i) => ({
        name: `gcloud_run_describe`,
        input: { i: i + 10 },
      })),
      turns: 4,
    });
    list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(1);
    // Generate called twice total: generalizability + synthesis from run #1
    // only. Run #2 short-circuits at the dedup gate (before generalizability).
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does NOT dedup when synthesized skill omits the tool names (known FTS limitation)', async () => {
    // Documented in risks-and-unknowns.md R7 — FTS dedup is coarser than
    // semantic. When synthesis fully abstracts tool names away, FTS won't
    // match them on the next trajectory.
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(synthesisFixture('cloud-run-deploy', 'Deploy a service'))
      // 2nd run also gets a YES + synthesis; we'll observe whether it stores.
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(synthesisFixture('cloud-run-deploy-v2', 'Deploy a service v2'));
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      extraction: { cooldownMs: 0 },
      agentId: 'ops-agent',
    });
    await runScenario(processor, {
      toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: `gcloud_run_describe`, input: { i } })),
      turns: 4,
    });
    await runScenario(processor, {
      toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: `gcloud_run_describe`, input: { i: i + 10 } })),
      turns: 4,
    });
    const list = await storage.listSkills({ agentId: 'ops-agent' });
    // Two distinct skills survive because dedup couldn't find a textual match
    // for the tool name in the abstracted synthesized content.
    expect(list).toHaveLength(2);
  });

  it('respects cooldown between consecutive extractions', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(synthesisFixture('skill-one', 'one'));
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      extraction: { cooldownMs: 60_000 },
      agentId: 'ops-agent',
    });
    await runScenario(processor, {
      toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, input: {} })),
      turns: 4,
    });
    await runScenario(processor, {
      toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: `u${i}`, input: {} })),
      turns: 4,
    });
    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(1);
  });

  it('processOutputStream observes chunks without delaying them', async () => {
    const processor = createSelfLearningProcessor({
      storage,
      generate: vi.fn(),
      agentId: 'ops-agent',
    });
    const state: Record<string, unknown> = {};
    const chunk = mkToolCall('foo', { x: 1 }, 'tc-x');
    const returned = processor.processOutputStream({ part: chunk, state });
    // Returned chunk is the input passed through unchanged
    expect(returned).toBe(chunk);
  });

  it('processOutputResult never throws even if aux LLM rejects', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('boom'));
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      agentId: 'ops-agent',
    });
    // generalizability check returns false on error → no synthesis fires → no
    // throw. We confirm by running and checking nothing was stored.
    await expect(
      runScenario(processor, {
        toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, input: {} })),
        turns: 4,
      }),
    ).resolves.toBeUndefined();
    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(0);
  });

  it('handles result.steps payload as the authoritative trajectory source', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(synthesisFixture('result-steps-skill', 'From result.steps'));
    const processor = createSelfLearningProcessor({
      storage,
      generate,
      agentId: 'ops-agent',
    });
    const state: Record<string, unknown> = {};

    // No chunks at all — feed `result.steps` directly to processOutputResult.
    // 4 steps, each with 2 tool calls, mirrors a realistic agentic-loop shape.
    const steps = Array.from({ length: 4 }, (_, stepIdx) => ({
      text: '',
      toolCalls: [
        {
          toolName: `tool_${stepIdx * 2}`,
          toolCallId: `tc-${stepIdx * 2}`,
          args: { step: stepIdx, n: 0 },
        },
        {
          toolName: `tool_${stepIdx * 2 + 1}`,
          toolCallId: `tc-${stepIdx * 2 + 1}`,
          args: { step: stepIdx, n: 1 },
        },
      ],
      toolResults: [
        { toolCallId: `tc-${stepIdx * 2}`, result: 'ok' },
        { toolCallId: `tc-${stepIdx * 2 + 1}`, result: 'ok' },
      ],
    }));
    await processor.processOutputResult({
      state,
      result: {
        text: 'Done.',
        finishReason: 'stop',
        steps,
      },
      messages: [{ role: 'user', content: 'perfect, thanks' }],
      requestContext: {
        get: (k: string) =>
          k === 'threadId' ? 'thread-result-steps' : k === 'agentId' ? 'ops-agent' : undefined,
      },
    });
    await processor._waitForPendingExtractions();

    const list = await storage.listSkills({ agentId: 'ops-agent' });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('result-steps-skill');
  });
});
