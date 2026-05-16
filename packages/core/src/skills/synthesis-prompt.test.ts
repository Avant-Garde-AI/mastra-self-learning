import { describe, expect, it } from 'vitest';
import {
  serializeTrajectoryForPrompt,
  buildSynthesisPrompt,
  buildGeneralizabilityPrompt,
  normalizeSynthesisOutput,
} from './synthesis-prompt.js';
import type { TaskTrajectory } from './extractor.js';

const traj: TaskTrajectory = {
  toolCalls: [
    {
      name: 'gcloud_run_deploy',
      input: { service: 'api-staging-2026', image: 'us-docker.pkg.dev/atlas-prod-1234/api/api:abc' },
      output: 'Deployment succeeded',
      timestamp: '2026-05-15T10:00:00Z',
    },
    {
      name: 'gcloud_run_describe',
      input: { service: 'api-staging-2026' },
      output: { status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      timestamp: '2026-05-15T10:00:10Z',
    },
    {
      name: 'gcloud_run_describe',
      input: { service: 'api-staging-2026' },
      timestamp: '2026-05-15T10:00:20Z',
    },
  ],
  turnCount: 5,
  positiveOutcome: true,
  threadId: '01HXXX0000000000000000000A',
  agentId: 'ops-agent',
};

describe('serializeTrajectoryForPrompt', () => {
  it('lists tool calls with truncated outputs', () => {
    const out = serializeTrajectoryForPrompt(traj);
    expect(out).toMatch(/Tool calls \(3\):/);
    expect(out).toMatch(/gcloud_run_deploy/);
    expect(out).toMatch(/Turn count: 5/);
    expect(out).toMatch(/Positive outcome detected: yes/);
  });

  it('replaces GCP project IDs with PROJECT_ID placeholder', () => {
    const out = serializeTrajectoryForPrompt(traj);
    expect(out).not.toContain('atlas-prod-1234');
    expect(out).toMatch(/<PROJECT_ID>/);
  });

  it('replaces ULIDs with placeholders inside conversationSummary', () => {
    const withSummary = { ...traj, conversationSummary: 'thread 01HXXX0000000000000000000A finished' };
    const out = serializeTrajectoryForPrompt(withSummary);
    expect(out).not.toMatch(/01HXXX0000000000000000000A/);
    expect(out).toMatch(/<ULID>/);
  });

  it('truncates long outputs to ~200 chars with ellipsis', () => {
    const longTraj = {
      ...traj,
      toolCalls: [
        {
          name: 't',
          input: {},
          output: 'x'.repeat(500),
          timestamp: 'now',
        },
      ],
    };
    const out = serializeTrajectoryForPrompt(longTraj);
    expect(out).toMatch(/x{200}…/);
  });
});

describe('buildGeneralizabilityPrompt', () => {
  it('summarizes tool calls with counts', () => {
    const out = buildGeneralizabilityPrompt(traj);
    // gcloud_run_describe appears 2x
    expect(out).toMatch(/gcloud_run_describe×2/);
    expect(out).toMatch(/YES or NO/);
  });
});

describe('buildSynthesisPrompt', () => {
  it('includes the agentskills.io frontmatter contract', () => {
    const out = buildSynthesisPrompt(traj);
    expect(out).toMatch(/name:\s+kebab-case/);
    expect(out).toMatch(/trust:\s+"agent-created"/);
    expect(out).toMatch(/## Procedure/);
  });

  it('prepends a retry preamble on retry', () => {
    const retry = buildSynthesisPrompt(traj, true);
    expect(retry).toMatch(/previous attempt produced unparseable output/);
    expect(retry).toMatch(/No code fences/);
  });
});

describe('normalizeSynthesisOutput', () => {
  const validBody = `---\nname: x\ndescription: y\nversion: "1.0.0"\n---\n\n## Procedure\n\nStep.\n`;

  it('returns valid input unchanged (after trim)', () => {
    expect(normalizeSynthesisOutput(validBody)).toBe(validBody.trim());
  });

  it('strips leading code fence with language tag', () => {
    const wrapped = '```markdown\n' + validBody + '\n```';
    const out = normalizeSynthesisOutput(wrapped);
    expect(out).toMatch(/^---/);
    expect(out).not.toMatch(/```/);
  });

  it('strips trailing closing fence', () => {
    const wrapped = validBody + '\n```';
    const out = normalizeSynthesisOutput(wrapped);
    expect(out).not.toMatch(/```/);
  });

  it('strips conversational preamble', () => {
    const wrapped = "Here's the SKILL.md you requested:\n\n" + validBody;
    const out = normalizeSynthesisOutput(wrapped);
    expect(out).toMatch(/^---/);
    expect(out).not.toMatch(/here'?s/i);
  });

  it('handles code fence + preamble combined', () => {
    const wrapped = 'Sure! Here is the result:\n```markdown\n' + validBody + '\n```';
    const out = normalizeSynthesisOutput(wrapped);
    expect(out).toMatch(/^---/);
    expect(out).not.toMatch(/```/);
    expect(out).not.toMatch(/sure/i);
  });
});
