import { describe, expect, it, vi } from 'vitest';
import { SkillExtractor, distinctToolCallCount, type TaskTrajectory } from './extractor.js';
import type { SkillStorageExtension } from './storage-extension.js';
import { SkillSearch } from './search.js';
import { ExtractionPolicySchema } from '../config.js';
import { serializeSkillDocument } from './parser.js';
import { AuxiliaryLLMNotConfiguredError } from './auxiliary-llm.js';
import type { SkillRecord } from './types.js';

const VALID_SKILL = serializeSkillDocument(
  {
    name: 'deploy-cloud-run',
    description: 'Deploy a containerized service to Cloud Run with traffic splitting',
    version: '1.0.0',
    author: 'agent',
    trust: 'agent-created',
    tags: ['gcp', 'cloud-run'],
    complexity: 3,
  },
  `## When to Use

Deploy a containerized service.

## Prerequisites

- gcloud CLI

## Procedure

1. Verify image.
2. Deploy.

## Verification

Service is healthy.

## Pitfalls

Cold start latency.
`,
);

function mkTraj(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
  return {
    toolCalls: Array.from({ length: 6 }, (_, i) => ({
      name: `tool_${i}`,
      input: { i },
      timestamp: '2026-05-15T10:00:00Z',
    })),
    turnCount: 4,
    positiveOutcome: true,
    threadId: 't-1',
    agentId: 'a-1',
    ...overrides,
  };
}

function mkStorage(overrides: Partial<SkillStorageExtension> = {}): SkillStorageExtension {
  return {
    createSkill: vi.fn(async (input: Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt'>) => ({
      id: 'sk_test',
      createdAt: '2026-05-15T10:00:00Z',
      updatedAt: '2026-05-15T10:00:00Z',
      ...input,
    } as SkillRecord)),
    search: vi.fn(async () => []),
    ...overrides,
  } as unknown as SkillStorageExtension;
}

function mkSearch(searchResults: Array<{ skill: SkillRecord; score: number }> = []): SkillSearch {
  return {
    search: vi.fn(async () => searchResults.map((r) => ({ ...r, matchType: 'fts' as const }))),
  } as unknown as SkillSearch;
}

describe('distinctToolCallCount', () => {
  it('dedupes by (name, JSON.stringify(input))', () => {
    const traj = mkTraj({
      toolCalls: [
        { name: 'a', input: { x: 1 }, timestamp: 't' },
        { name: 'a', input: { x: 1 }, timestamp: 't' }, // dup
        { name: 'a', input: { x: 2 }, timestamp: 't' },
        { name: 'b', input: {}, timestamp: 't' },
      ],
    });
    expect(distinctToolCallCount(traj)).toBe(3);
  });
});

describe('SkillExtractor.evaluate — policy gates', () => {
  it('returns cooldown reason when called within cooldownMs', async () => {
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch(),
      ExtractionPolicySchema.parse({ cooldownMs: 60_000, useGeneralizabilityCheck: false }),
      vi.fn(async () => VALID_SKILL),
    );
    // First run succeeds and sets lastExtractionTime
    const first = await ex.evaluate(mkTraj());
    expect(first.triggered).toBe(true);
    // Second run within cooldown
    const second = await ex.evaluate(mkTraj());
    expect(second.triggered).toBe(false);
    expect(second.reason).toMatch(/cooldown/);
  });

  it('skips when minToolCalls not met', async () => {
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch(),
      ExtractionPolicySchema.parse({}),
      vi.fn(),
    );
    const result = await ex.evaluate(
      mkTraj({ toolCalls: [{ name: 't', input: {}, timestamp: 'x' }] }),
    );
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/minToolCalls not met/);
  });

  it('skips when minTurns not met', async () => {
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch(),
      ExtractionPolicySchema.parse({}),
      vi.fn(),
    );
    const result = await ex.evaluate(mkTraj({ turnCount: 1 }));
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/minTurns not met/);
  });

  it('skips when positiveOutcome is required and absent', async () => {
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch(),
      ExtractionPolicySchema.parse({}),
      vi.fn(),
    );
    const result = await ex.evaluate(mkTraj({ positiveOutcome: false }));
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/positiveOutcome required/);
  });

  it('throws AuxiliaryLLMNotConfiguredError when generalizability check is enabled but no LLM is configured', async () => {
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch(),
      ExtractionPolicySchema.parse({ useGeneralizabilityCheck: true }),
      undefined,
    );
    await expect(ex.evaluate(mkTraj())).rejects.toThrow(AuxiliaryLLMNotConfiguredError);
  });

  it('honors a NO answer on generalizability', async () => {
    const generate = vi.fn().mockResolvedValueOnce('NO');
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch(),
      ExtractionPolicySchema.parse({}),
      generate,
    );
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/generalizability/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('skips on duplicate via FTS search', async () => {
    const existing: SkillRecord = {
      id: 'existing',
      name: 'old-skill',
      version: '1.0.0',
      content: VALID_SKILL,
      frontmatter: { name: 'old-skill', description: 'pre-existing' },
      trustTier: 'agent-created',
      status: 'active',
      successCount: 0,
      failCount: 0,
      lastUsed: null,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch([{ skill: existing, score: 0.5 }]),
      ExtractionPolicySchema.parse({ useGeneralizabilityCheck: false }),
      vi.fn(),
    );
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/duplicate/);
    expect(result.skill?.id).toBe('existing');
  });
});

describe('SkillExtractor.evaluate — extraction + synthesis', () => {
  it('extracts when all gates pass and synthesis is parseable', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')      // generalizability
      .mockResolvedValueOnce(VALID_SKILL); // synthesis
    const storage = mkStorage();
    const ex = new SkillExtractor(storage, mkSearch(), ExtractionPolicySchema.parse({}), generate);
    const result = await ex.evaluate(mkTraj());

    expect(result.triggered).toBe(true);
    expect(result.skill?.frontmatter.name).toBe('deploy-cloud-run');
    expect(storage.createSkill).toHaveBeenCalledTimes(1);

    const writtenInput = (storage.createSkill as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writtenInput.trustTier).toBe('agent-created');
    expect(writtenInput.status).toBe('active');
    expect(writtenInput.frontmatter.metadata.mastra.threadOrigin).toBe('t-1');
    expect(writtenInput.frontmatter.metadata.mastra.extractionTrigger).toBe('auto');
  });

  it('routes to draft when scanner flags content', async () => {
    const UNSAFE = serializeSkillDocument(
      {
        name: 'risky',
        description: 'cleanup',
        version: '1.0.0',
      },
      '## Procedure\n\n1. Run `rm -rf /tmp/build`.\n',
    );
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(UNSAFE);
    const storage = mkStorage();
    const ex = new SkillExtractor(storage, mkSearch(), ExtractionPolicySchema.parse({}), generate);
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(true);
    const writtenInput = (storage.createSkill as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writtenInput.status).toBe('draft');
    expect(result.reason).toMatch(/draft/);
  });

  it('retries synthesis once on unparseable output, succeeds on retry', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES') // generalizability
      .mockResolvedValueOnce('I cannot do that.') // bad synthesis
      .mockResolvedValueOnce(VALID_SKILL); // retry succeeds
    const ex = new SkillExtractor(mkStorage(), mkSearch(), ExtractionPolicySchema.parse({}), generate);
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(true);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('returns triggered=false when both synthesis attempts produce garbage', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce('nope, sorry')
      .mockResolvedValueOnce('still no');
    const ex = new SkillExtractor(mkStorage(), mkSearch(), ExtractionPolicySchema.parse({}), generate);
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/synthesis failed/);
  });

  it('skips generalizability when policy turns it off', async () => {
    const generate = vi.fn().mockResolvedValueOnce(VALID_SKILL); // synthesis only
    const ex = new SkillExtractor(
      mkStorage(),
      mkSearch(),
      ExtractionPolicySchema.parse({ useGeneralizabilityCheck: false }),
      generate,
    );
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('requireApproval forces draft status even when scan passes', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(VALID_SKILL);
    const storage = mkStorage();
    const ex = new SkillExtractor(
      storage,
      mkSearch(),
      ExtractionPolicySchema.parse({ requireApproval: true }),
      generate,
    );
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(true);
    const writtenInput = (storage.createSkill as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writtenInput.status).toBe('draft');
  });

  it('returns triggered=false when storage.createSkill throws', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(VALID_SKILL);
    const storage = mkStorage({
      createSkill: vi.fn(async () => {
        throw new Error('db down');
      }) as unknown as SkillStorageExtension['createSkill'],
    });
    const ex = new SkillExtractor(storage, mkSearch(), ExtractionPolicySchema.parse({}), generate);
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/storage write failed/);
  });

  it('survives a search failure during dedup (fails open)', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce(VALID_SKILL);
    const search = {
      search: vi.fn(async () => {
        throw new Error('search broke');
      }),
    } as unknown as SkillSearch;
    const ex = new SkillExtractor(
      mkStorage(),
      search,
      ExtractionPolicySchema.parse({}),
      generate,
    );
    const result = await ex.evaluate(mkTraj());
    expect(result.triggered).toBe(true);
  });
});
