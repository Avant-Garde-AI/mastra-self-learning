import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SkillRouter } from './router.js';
import { SkillRouterConfigSchema } from '../config.js';
import type { SkillRecord, SkillFrontmatter } from './types.js';
import type { SkillStorageExtension } from './storage-extension.js';
import { serializeSkillDocument } from './parser.js';

const baseFrontmatter: SkillFrontmatter = {
  name: 'placeholder',
  description: 'placeholder description',
  version: '1.0.0',
  trust: 'agent-created',
  tags: ['x'],
};

function mkSkill(overrides: Partial<SkillRecord>): SkillRecord {
  const fm: SkillFrontmatter = {
    ...baseFrontmatter,
    ...(overrides.frontmatter ?? {}),
    name: overrides.name ?? overrides.frontmatter?.name ?? 'placeholder',
  };
  const body =
    typeof overrides.content === 'string'
      ? overrides.content
      : `## Procedure\n\n1. Do the thing.\n`;
  return {
    id: overrides.id ?? 'sk_test_0',
    name: overrides.name ?? fm.name,
    version: overrides.version ?? '1.0.0',
    content: overrides.content ?? serializeSkillDocument(fm, body),
    frontmatter: fm,
    agentId: overrides.agentId ?? null,
    trustTier: overrides.trustTier ?? 'agent-created',
    status: overrides.status ?? 'active',
    successCount: overrides.successCount ?? 0,
    failCount: overrides.failCount ?? 0,
    lastUsed: overrides.lastUsed ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-05-15T10:00:00Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-05-15T10:00:00Z').toISOString(),
  };
}

function makeMockStorage(skills: SkillRecord[]): SkillStorageExtension {
  const list = vi.fn(async () => skills);
  const getByName = vi.fn(async (name: string) =>
    skills.find((s) => s.name === name) ?? null,
  );
  return {
    listSkills: list,
    getSkillByName: getByName,
  } as unknown as SkillStorageExtension;
}

describe('SkillRouter.buildIndex', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "(none yet)" for an empty library', async () => {
    const router = new SkillRouter(
      makeMockStorage([]),
      SkillRouterConfigSchema.parse({}),
    );
    const index = await router.buildIndex();
    expect(index).toBe('# Available Skills\n\n(none yet)');
  });

  it('returns all skills when under budget', async () => {
    const skills = [
      mkSkill({ id: 'a', name: 'alpha', frontmatter: { ...baseFrontmatter, name: 'alpha', description: 'd1' } }),
      mkSkill({ id: 'b', name: 'beta', frontmatter: { ...baseFrontmatter, name: 'beta', description: 'd2' } }),
    ];
    const router = new SkillRouter(
      makeMockStorage(skills),
      SkillRouterConfigSchema.parse({}),
    );
    const index = await router.buildIndex();
    expect(index).toContain('- alpha: d1');
    expect(index).toContain('- beta: d2');
  });

  it('applies the "recent" strategy when over budget', async () => {
    const old = mkSkill({
      id: 'old',
      name: 'older-skill',
      lastUsed: '2026-01-01T00:00:00Z',
      frontmatter: { ...baseFrontmatter, name: 'older-skill', description: 'X'.repeat(50) },
    });
    const recent = mkSkill({
      id: 'rec',
      name: 'recent-skill',
      lastUsed: '2026-05-15T00:00:00Z',
      frontmatter: { ...baseFrontmatter, name: 'recent-skill', description: 'Y'.repeat(50) },
    });
    // Very small budget — only 1 skill fits.
    const cfg = SkillRouterConfigSchema.parse({ indexBudget: 30, overflowStrategy: 'recent' });
    const router = new SkillRouter(makeMockStorage([old, recent]), cfg);
    const index = await router.buildIndex();
    expect(index).toContain('recent-skill');
    expect(index).not.toContain('older-skill');
    expect(index).toMatch(/omitted/);
  });

  it('applies the "frequent" strategy by net successes', async () => {
    const lo = mkSkill({
      id: 'lo',
      name: 'rarely-used',
      successCount: 1,
      failCount: 0,
      frontmatter: { ...baseFrontmatter, name: 'rarely-used', description: 'X'.repeat(60) },
    });
    const hi = mkSkill({
      id: 'hi',
      name: 'often-used',
      successCount: 100,
      failCount: 0,
      frontmatter: { ...baseFrontmatter, name: 'often-used', description: 'Y'.repeat(60) },
    });
    const cfg = SkillRouterConfigSchema.parse({
      indexBudget: 30,
      overflowStrategy: 'frequent',
    });
    const router = new SkillRouter(makeMockStorage([lo, hi]), cfg);
    const index = await router.buildIndex();
    expect(index).toContain('often-used');
    expect(index).not.toContain('rarely-used');
  });

  it('"relevant" falls back to "recent" with a one-time warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = mkSkill({
      id: 'a',
      name: 'a-skill',
      lastUsed: '2026-01-01T00:00:00Z',
      frontmatter: { ...baseFrontmatter, name: 'a-skill', description: 'X'.repeat(50) },
    });
    const b = mkSkill({
      id: 'b',
      name: 'b-skill',
      lastUsed: '2026-05-15T00:00:00Z',
      frontmatter: { ...baseFrontmatter, name: 'b-skill', description: 'Y'.repeat(50) },
    });
    const cfg = SkillRouterConfigSchema.parse({
      indexBudget: 30,
      overflowStrategy: 'relevant',
    });
    const router = new SkillRouter(makeMockStorage([a, b]), cfg);
    await router.buildIndex();
    await router.buildIndex(); // second call should not warn again
    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0][0]).toMatch(/Phase 4/);
    spy.mockRestore();
  });

  it('caches the result for the TTL window', async () => {
    const skills = [mkSkill({ id: 'a', name: 'cached', frontmatter: { ...baseFrontmatter, name: 'cached', description: 'd' } })];
    const mock = makeMockStorage(skills);
    const router = new SkillRouter(mock, SkillRouterConfigSchema.parse({}));
    await router.buildIndex();
    await router.buildIndex();
    expect(mock.listSkills).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces fresh fetch', async () => {
    const skills = [mkSkill({ id: 'a', name: 'cached', frontmatter: { ...baseFrontmatter, name: 'cached', description: 'd' } })];
    const mock = makeMockStorage(skills);
    const router = new SkillRouter(mock, SkillRouterConfigSchema.parse({}));
    await router.buildIndex();
    router.invalidate();
    await router.buildIndex();
    expect(mock.listSkills).toHaveBeenCalledTimes(2);
  });

  it('cacheTtlMs=0 disables caching', async () => {
    const skills = [mkSkill({ id: 'a', name: 'no-cache', frontmatter: { ...baseFrontmatter, name: 'no-cache', description: 'd' } })];
    const mock = makeMockStorage(skills);
    const router = new SkillRouter(
      mock,
      SkillRouterConfigSchema.parse({}),
      undefined,
      undefined,
      0,
    );
    await router.buildIndex();
    await router.buildIndex();
    expect(mock.listSkills).toHaveBeenCalledTimes(2);
  });

  it('falls back to first body line when description is empty', async () => {
    const fm: SkillFrontmatter = { ...baseFrontmatter, name: 'fb', description: '' };
    const body = '## Procedure\n\nFirst line of body that should appear.\n';
    const skill = mkSkill({
      id: 'fb',
      name: 'fb',
      frontmatter: fm,
      content: serializeSkillDocument(fm, body),
    });
    const router = new SkillRouter(makeMockStorage([skill]), SkillRouterConfigSchema.parse({}));
    const index = await router.buildIndex();
    expect(index).toContain('- fb:');
    expect(index).toMatch(/## Procedure|First line of body/);
  });
});

describe('SkillRouter.loadSkill', () => {
  it('returns full content for L1 (no section)', async () => {
    const skill = mkSkill({ id: 'a', name: 'a', content: '## Procedure\n\nStep.\n' });
    const router = new SkillRouter(makeMockStorage([skill]), SkillRouterConfigSchema.parse({}));
    const content = await router.loadSkill('a');
    expect(content).toBe('## Procedure\n\nStep.\n');
  });

  it('returns only the requested section for L2', async () => {
    const fm = { ...baseFrontmatter, name: 'a' };
    const body = `## When to Use

For tests.

## Procedure

Step one.
Step two.

## Pitfalls

Watch out.
`;
    const skill = mkSkill({
      id: 'a',
      name: 'a',
      frontmatter: fm,
      content: serializeSkillDocument(fm, body),
    });
    const router = new SkillRouter(makeMockStorage([skill]), SkillRouterConfigSchema.parse({}));
    const proc = await router.loadSkill('a', 'Procedure');
    expect(proc).toBe('Step one.\nStep two.');
    const pit = await router.loadSkill('a', 'pitfalls');
    expect(pit).toBe('Watch out.');
  });

  it('returns null for a missing skill', async () => {
    const router = new SkillRouter(makeMockStorage([]), SkillRouterConfigSchema.parse({}));
    expect(await router.loadSkill('nope')).toBeNull();
  });

  it('returns null for a missing section', async () => {
    const skill = mkSkill({ id: 'a', name: 'a', content: '## Procedure\n\nStep.\n' });
    const router = new SkillRouter(makeMockStorage([skill]), SkillRouterConfigSchema.parse({}));
    expect(await router.loadSkill('a', 'Nope')).toBeNull();
  });
});

describe('SkillRouter.suggestSkills', () => {
  it('throws with a Phase 4 marker', async () => {
    const router = new SkillRouter(makeMockStorage([]), SkillRouterConfigSchema.parse({}));
    await expect(router.suggestSkills('x')).rejects.toThrow(/Phase 4/);
  });
});
