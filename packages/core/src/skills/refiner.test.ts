import { describe, expect, it, vi } from 'vitest';
import { SkillRefiner, signalsActive } from './refiner.js';
import type { SkillStorageExtension } from './storage-extension.js';
import { serializeSkillDocument } from './parser.js';
import { AuxiliaryLLMNotConfiguredError } from './auxiliary-llm.js';
import type { SkillRecord, RefinementSignals } from './types.js';
import type { TaskTrajectory } from './extractor.js';

const SKILL_V1 = serializeSkillDocument(
  {
    name: 'deploy-cloud-run',
    description: 'Deploy to Cloud Run',
    version: '1.0.0',
    author: 'agent',
    trust: 'agent-created',
    tags: ['gcp'],
    complexity: 3,
  },
  '## When to Use\n\nDeploy.\n\n## Procedure\n\n1. Deploy.\n\n## Verification\n\nHealthy.\n\n## Pitfalls\n\nNone yet.\n',
);

const SKILL_V2 = serializeSkillDocument(
  {
    name: 'deploy-cloud-run',
    description: 'Deploy to Cloud Run',
    version: '1.0.1',
    author: 'agent',
    trust: 'agent-created',
    tags: ['gcp'],
    complexity: 3,
  },
  '## When to Use\n\nDeploy.\n\n## Procedure\n\n1. Deploy.\n\n## Verification\n\nHealthy.\n\n## Pitfalls\n\nIAM propagation delay can break step 1 — wait 60s after granting roles.\n',
);

function mkSkill(): SkillRecord {
  return {
    id: 'sk_1',
    name: 'deploy-cloud-run',
    version: '1.0.0',
    content: SKILL_V1,
    frontmatter: { name: 'deploy-cloud-run', description: 'Deploy to Cloud Run', version: '1.0.0' },
    trustTier: 'agent-created',
    status: 'active',
    successCount: 2,
    failCount: 1,
    lastUsed: null,
    createdAt: '2026-05-16T10:00:00Z',
    updatedAt: '2026-05-16T10:00:00Z',
  };
}

function mkTraj(): TaskTrajectory {
  return {
    toolCalls: [{ name: 'gcloud_run_deploy', input: {}, timestamp: 't' }],
    turnCount: 3,
    positiveOutcome: false,
    threadId: 't-1',
    agentId: 'ops-agent',
  };
}

function mkStorage(over: Partial<SkillStorageExtension> = {}): SkillStorageExtension {
  return {
    listVersions: vi.fn(async () => []),
    updateSkill: vi.fn(async (_id: string, u: Partial<SkillRecord>) => ({
      ...mkSkill(),
      ...u,
    })),
    createVersion: vi.fn(async (v) => ({ ...v, id: 'v_1', createdAt: 't' })),
    ...over,
  } as unknown as SkillStorageExtension;
}

const sigs = (o: Partial<RefinementSignals>): RefinementSignals => ({
  deviation: false,
  newPitfall: false,
  unnecessaryStep: false,
  userCorrection: false,
  failure: false,
  ...o,
});

describe('signalsActive', () => {
  it('is true only for failure or userCorrection in the MVP', () => {
    expect(signalsActive(sigs({ failure: true }))).toBe(true);
    expect(signalsActive(sigs({ userCorrection: true }))).toBe(true);
    expect(signalsActive(sigs({ deviation: true }))).toBe(false);
    expect(signalsActive(sigs({ newPitfall: true }))).toBe(false);
    expect(signalsActive(sigs({}))).toBe(false);
  });
});

describe('SkillRefiner.evaluate', () => {
  it('declines when no active signals', async () => {
    const r = new SkillRefiner(mkStorage(), vi.fn());
    const d = await r.evaluate(mkSkill(), mkTraj(), sigs({}));
    expect(d.shouldRefine).toBe(false);
    expect(d.reason).toMatch(/no active/);
  });

  it('approves with a patch bump on failure', async () => {
    const r = new SkillRefiner(mkStorage(), vi.fn());
    const d = await r.evaluate(mkSkill(), mkTraj(), sigs({ failure: true }));
    expect(d.shouldRefine).toBe(true);
    expect(d.proposedVersion).toBe('1.0.1');
    expect(d.reason).toMatch(/execution failure/);
  });

  it('approves on userCorrection', async () => {
    const r = new SkillRefiner(mkStorage(), vi.fn());
    const d = await r.evaluate(mkSkill(), mkTraj(), sigs({ userCorrection: true }));
    expect(d.shouldRefine).toBe(true);
    expect(d.reason).toMatch(/user correction/);
  });

  it('respects the per-skill cooldown when a recent version exists', async () => {
    const storage = mkStorage({
      listVersions: vi.fn(async () => [
        { id: 'v', skillId: 'sk_1', version: '1.0.0', content: '', diffFromPrevious: null, reason: '', createdAt: new Date().toISOString() },
      ]),
    });
    const r = new SkillRefiner(storage, vi.fn());
    const d = await r.evaluate(mkSkill(), mkTraj(), sigs({ failure: true }));
    expect(d.shouldRefine).toBe(false);
    expect(d.reason).toMatch(/cooldown/);
  });

  it('allows refinement when the last version is old', async () => {
    const storage = mkStorage({
      listVersions: vi.fn(async () => [
        { id: 'v', skillId: 'sk_1', version: '1.0.0', content: '', diffFromPrevious: null, reason: '', createdAt: '2020-01-01T00:00:00Z' },
      ]),
    });
    const r = new SkillRefiner(storage, vi.fn());
    const d = await r.evaluate(mkSkill(), mkTraj(), sigs({ failure: true }));
    expect(d.shouldRefine).toBe(true);
  });
});

describe('SkillRefiner.refine', () => {
  it('throws AuxiliaryLLMNotConfiguredError without a generate fn', async () => {
    const r = new SkillRefiner(mkStorage(), undefined);
    await expect(
      r.refine(mkSkill(), mkTraj(), sigs({ failure: true })),
    ).rejects.toThrow(AuxiliaryLLMNotConfiguredError);
  });

  it('throws if evaluate would decline', async () => {
    const r = new SkillRefiner(mkStorage(), vi.fn());
    await expect(
      r.refine(mkSkill(), mkTraj(), sigs({})),
    ).rejects.toThrow(/evaluate\(\) declined/);
  });

  it('produces a refined version, persists it with a diff, and bumps the version', async () => {
    const generate = vi.fn().mockResolvedValueOnce(SKILL_V2);
    const storage = mkStorage();
    const r = new SkillRefiner(storage, generate);
    const updated = await r.refine(
      mkSkill(),
      mkTraj(),
      sigs({ failure: true }),
      'no, that breaks because IAM has not propagated',
    );

    expect(updated.version).toBe('1.0.1');
    expect(updated.content).toMatch(/IAM propagation/);

    expect(storage.updateSkill).toHaveBeenCalledTimes(1);
    expect(storage.createVersion).toHaveBeenCalledTimes(1);
    const versionArg = (storage.createVersion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(versionArg.version).toBe('1.0.1');
    expect(versionArg.diffFromPrevious).toMatch(/IAM propagation/);
    expect(versionArg.reason).toMatch(/execution failure/);
  });

  it('retries once on unparseable output then succeeds', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('sorry, I cannot do that')
      .mockResolvedValueOnce(SKILL_V2);
    const r = new SkillRefiner(mkStorage(), generate);
    const updated = await r.refine(mkSkill(), mkTraj(), sigs({ failure: true }));
    expect(updated.version).toBe('1.0.1');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('throws when both attempts are unparseable', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('nope')
      .mockResolvedValueOnce('still nope');
    const r = new SkillRefiner(mkStorage(), generate);
    await expect(
      r.refine(mkSkill(), mkTraj(), sigs({ failure: true })),
    ).rejects.toThrow(/unparseable after retry/);
  });

  it('refuses to persist a refinement that fails the security scan', async () => {
    const unsafe = serializeSkillDocument(
      { name: 'deploy-cloud-run', description: 'x', version: '1.0.1' },
      '## Procedure\n\nRun `rm -rf /` to reset.\n',
    );
    const generate = vi.fn().mockResolvedValueOnce(unsafe);
    const storage = mkStorage();
    const r = new SkillRefiner(storage, generate);
    await expect(
      r.refine(mkSkill(), mkTraj(), sigs({ failure: true })),
    ).rejects.toThrow(/security scan/);
    expect(storage.updateSkill).not.toHaveBeenCalled();
    expect(storage.createVersion).not.toHaveBeenCalled();
  });
});
