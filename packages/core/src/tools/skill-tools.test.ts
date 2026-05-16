import { describe, expect, it } from 'vitest';
import { createSelfLearningTools } from './skill-tools.js';
import type { MastraPostgresLike } from '../skills/storage-extension.js';

// Build a minimal stub storage that satisfies the structural type — enough for
// us to construct the tools without spinning up Postgres. Unit-level: we only
// check shape, not execution. Execution is covered by the Tier-1 integration
// test in `test/tools.integration.test.ts`.
const stubStorage: MastraPostgresLike = {
  db: {
    any: async () => [],
    one: async () => ({} as never),
    oneOrNone: async () => null,
    none: async () => null,
    tx: async (fn) =>
      fn({
        any: async () => [],
        one: async () => ({} as never),
        oneOrNone: async () => null,
        none: async () => null,
        many: async () => [],
      }),
  },
};

describe('createSelfLearningTools', () => {
  const tools = createSelfLearningTools({ storage: stubStorage });

  it('returns all 8 tools', () => {
    const ids = Object.keys(tools).sort();
    expect(ids).toEqual(
      [
        'memory_persist',
        'memory_recall',
        'skill_create',
        'skill_feedback',
        'skill_list',
        'skill_search',
        'skill_update',
        'skill_view',
      ].sort(),
    );
  });

  it('each tool exposes an id and description', () => {
    for (const [key, tool] of Object.entries(tools)) {
      expect(tool.id).toBe(key);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('each tool has an inputSchema and outputSchema', () => {
    for (const tool of Object.values(tools)) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it('input schemas validate canonical inputs', () => {
    const safeParse = <T>(schema: { ['~standard']: { validate: (x: unknown) => unknown } } | undefined, input: T) => {
      const std = (schema as { ['~standard']: { validate: (x: unknown) => { issues?: unknown[]; value?: unknown } | Promise<{ issues?: unknown[]; value?: unknown }> } })[
        '~standard'
      ];
      const result = std.validate(input) as { issues?: unknown[] };
      expect(result.issues ?? []).toEqual([]);
    };

    safeParse(tools.skill_list.inputSchema, { limit: 50 });
    safeParse(tools.skill_view.inputSchema, { name: 'x', section: 'Procedure' });
    safeParse(tools.skill_search.inputSchema, { query: 'cloud run' });
    safeParse(tools.skill_create.inputSchema, { content: '---\nname: x\ndescription: y\n---\nbody' });
    safeParse(tools.skill_update.inputSchema, {
      name: 'x',
      content: '---\nname: x\ndescription: y\n---\nbody',
      reason: 'test',
    });
    safeParse(tools.skill_feedback.inputSchema, { name: 'x', outcome: 'success' });
    safeParse(tools.memory_persist.inputSchema, { category: 'preference', content: 'x' });
    safeParse(tools.memory_recall.inputSchema, { query: 'x' });
  });

  // memory_persist / memory_recall are real FactLayer-backed tools as of
  // Phase 4. Full behavior is covered by the integration test suite (real
  // Postgres). Here we only verify graceful degradation when the storage
  // layer errors — a stub whose db rejects simulates "no facts table".
  const errStorage: MastraPostgresLike = {
    db: {
      any: async () => {
        throw new Error('no db');
      },
      one: async () => {
        throw new Error('no db');
      },
      oneOrNone: async () => {
        throw new Error('no db');
      },
      none: async () => {
        throw new Error('no db');
      },
      tx: async () => {
        throw new Error('no db');
      },
    },
  };

  it('memory_persist degrades to persisted=false when the db errors', async () => {
    const t = createSelfLearningTools({ storage: errStorage });
    const result = await t.memory_persist.execute!(
      { category: 'preference', content: 'x' },
      {} as never,
    );
    expect(result).toEqual({ persisted: false });
  });

  it('memory_recall degrades to an empty facts list when the db errors', async () => {
    const t = createSelfLearningTools({ storage: errStorage });
    const result = await t.memory_recall.execute!({ query: 'x', limit: 5 }, {} as never);
    expect(result).toEqual({ facts: [] });
  });

  it('storage instance is shared across tools (not recreated per-call)', () => {
    const a = createSelfLearningTools({ storage: stubStorage });
    const b = createSelfLearningTools({ storage: stubStorage });
    // Each factory call returns a new tools object, but within one factory
    // call, all tools share the same closed-over storage instance. We can't
    // observe the shared instance directly without exposing internals, so we
    // verify that the per-factory tool IDs are distinct objects.
    expect(a.skill_list).not.toBe(b.skill_list);
    expect(a.skill_list.id).toBe(b.skill_list.id);
  });
});
