import { ulid } from 'ulid';
import {
  createSelfLearningProcessor,
  serializeSkillDocument,
  type AuxiliaryGenerate,
} from '@avant-garde/mastra-self-learning';
import { skillStorage, AGENT_ID, embedder } from './storage.js';
import { recordEvent } from './events.js';

/**
 * A scripted, credential-free demonstration of the full learning loop.
 *
 * Drives the real `SelfLearningProcessor` against the real Postgres-backed
 * storage with a *scripted* auxiliary LLM, so the harness is self-
 * demonstrating even without an ANTHROPIC_API_KEY. Every step emits real
 * events into the live timeline and produces real rows the skill browser
 * reads back.
 *
 * ACT 1  6-tool deployment task + positive outcome  → extraction
 * ACT 2  skill reused, deploy fails, user corrects   → refinement (v1.0.1)
 */
export async function runSelfDemo(): Promise<{
  skillName: string;
  extracted: boolean;
  refined: boolean;
}> {
  const suffix = ulid().slice(-6).toLowerCase();
  const skillName = `gcp-cloud-run-deploy-${suffix}`;

  const fm = (version: string) => ({
    name: skillName,
    description: 'Deploy a containerized service to Cloud Run with traffic splitting',
    version,
    author: 'agent' as const,
    trust: 'agent-created' as const,
    tags: ['gcp', 'cloud-run', 'deployment', 'demo'],
    complexity: 3,
  });

  const body = (pitfalls: string) => `## When to Use

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
`;

  const v1 = serializeSkillDocument(
    fm('1.0.0'),
    body('Cold start latency on the first request.'),
  );
  const v2 = serializeSkillDocument(
    fm('1.0.1'),
    body(
      'Cold start latency on the first request.\n' +
        '- IAM propagation delay: wait 60s after granting roles before deploying.',
    ),
  );

  const generate: AuxiliaryGenerate = (() => {
    const queue = ['YES', v1, v2];
    return async () => queue.shift() ?? 'NO';
  })();

  // Each demo run must be deterministic. With semantic dedup now live,
  // prior demo skills (near-identical bodies) would correctly dedup a fresh
  // run's ACT-1 extraction. Clear prior demo-tagged skills first so every
  // run extracts+refines cleanly. (Cascades to versions/stats/search/usage.)
  await skillStorage.db.none(
    `DELETE FROM mastra_skills WHERE id IN (
       SELECT skill_id FROM mastra_self_learning_skill_search WHERE 'demo' = ANY(tags)
     )`,
  );

  const proc = createSelfLearningProcessor({
    storage: skillStorage,
    agentId: AGENT_ID,
    generate,
    embed: embedder,
    extraction: { minToolCalls: 4, minTurns: 2, cooldownMs: 0 },
    refinementCooldownMs: 0,
    onEvent: recordEvent,
  });

  const tc = (toolName: string, args: Record<string, unknown>, id: string) => ({
    type: 'tool-call' as const,
    payload: { toolName, args, toolCallId: id },
  });
  const tr = (id: string, result: unknown) => ({
    type: 'tool-result' as const,
    payload: { toolCallId: id, result },
  });
  const sf = () => ({ type: 'step-finish' as const, payload: {} });

  // ── ACT 1: extraction ────────────────────────────────────────────────
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
      proc.processOutputStream({ part: tc(name, { i }, `a-${i}`), state });
      proc.processOutputStream({ part: tr(`a-${i}`, 'ok'), state });
    });
    for (let i = 0; i < 4; i++) proc.processOutputStream({ part: sf(), state });
    await proc.processOutputResult({
      state,
      result: { text: 'Deployment complete.', finishReason: 'stop', steps: [] },
      messages: [{ role: 'user', content: 'perfect, thanks — that worked great' }],
      requestContext: {
        get: (k: string) =>
          k === 'threadId' ? `demo-A-${suffix}` : k === 'agentId' ? AGENT_ID : undefined,
      },
    });
    await proc._waitForPendingExtractions();
  }

  const afterAct1 = await skillStorage.getSkillByName(skillName, AGENT_ID);
  const extracted = Boolean(afterAct1);

  // ── ACT 2: refinement (only if ACT 1 produced the skill) ─────────────
  let refined = false;
  if (afterAct1) {
    const state: Record<string, unknown> = {};
    proc.processOutputStream({ part: tc('skill_view', { name: skillName }, 'd-0'), state });
    proc.processOutputStream({ part: tr('d-0', v1), state });
    proc.processOutputStream({
      part: tc('gcloud_run_deploy', { service: 'svc' }, 'd-1'),
      state,
    });
    proc.processOutputStream({ part: tr('d-1', 'PERMISSION_DENIED'), state });
    proc.processOutputStream({
      part: tc(
        'skill_feedback',
        { name: skillName, outcome: 'failure', feedback: 'deploy denied' },
        'd-2',
      ),
      state,
    });
    proc.processOutputStream({ part: tr('d-2', { recorded: true }), state });
    for (let i = 0; i < 3; i++) proc.processOutputStream({ part: sf(), state });

    await skillStorage.recordUsage({
      skillId: afterAct1.id,
      threadId: `demo-C-${suffix}`,
      agentId: AGENT_ID,
      outcome: 'failure',
      feedback: 'deploy denied',
      durationMs: 800,
      toolCalls: 2,
    });

    await proc.processOutputResult({
      state,
      result: {
        text: 'The deployment failed with PERMISSION_DENIED.',
        finishReason: 'stop',
        steps: [],
      },
      messages: [
        {
          role: 'user',
          content:
            "no, that won't work because we just granted the IAM role and it hasn't propagated yet",
        },
      ],
      requestContext: {
        get: (k: string) =>
          k === 'threadId' ? `demo-C-${suffix}` : k === 'agentId' ? AGENT_ID : undefined,
      },
    });
    await proc._waitForPendingExtractions();

    const afterAct2 = await skillStorage.getSkillByName(skillName, AGENT_ID);
    refined = afterAct2?.version === '1.0.1';
  }

  return { skillName, extracted, refined };
}

/**
 * R7 acceptance probe: take an existing skill, run a qualifying extraction
 * whose synthesized content is (near-)identical, and confirm semantic dedup
 * routes it to the existing skill instead of storing a near-duplicate.
 */
export async function runDedupProbe(): Promise<{
  ran: boolean;
  deduped: boolean;
  reason: string;
  against?: string;
}> {
  const existing = (await skillStorage.listSkills({ agentId: AGENT_ID, limit: 1 }))[0];
  if (!existing) {
    return { ran: false, deduped: false, reason: 'no skill to probe against' };
  }

  // Scripted aux LLM: YES to generalizability, then re-emit the existing
  // skill's own content (a maximal near-duplicate).
  const queue = ['YES', existing.content];
  const generate: AuxiliaryGenerate = async () => queue.shift() ?? 'NO';

  const proc = createSelfLearningProcessor({
    storage: skillStorage,
    agentId: AGENT_ID,
    generate,
    embed: embedder,
    extraction: { minToolCalls: 4, minTurns: 2, cooldownMs: 0 },
    refinementCooldownMs: 0,
    onEvent: recordEvent,
  });

  const before = (await skillStorage.listSkills({ agentId: AGENT_ID, limit: 500 })).length;

  const trajectory = {
    toolCalls: Array.from({ length: 6 }, (_, i) => ({
      name: `gcloud_run_describe`,
      input: { i },
      timestamp: new Date().toISOString(),
    })),
    turnCount: 4,
    positiveOutcome: true,
    threadId: `dedup-probe-${ulid().slice(-6)}`,
    agentId: AGENT_ID,
    conversationSummary: existing.frontmatter.description ?? existing.name,
  };
  const result = await proc.extractor.evaluate(trajectory);

  const after = (await skillStorage.listSkills({ agentId: AGENT_ID, limit: 500 })).length;
  const deduped = !result.triggered && after === before;
  return {
    ran: true,
    deduped,
    reason: result.reason,
    against: existing.name,
  };
}
