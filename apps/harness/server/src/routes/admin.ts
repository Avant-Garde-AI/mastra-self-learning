import { registerApiRoute } from '@mastra/core/server';
import { streamSSE } from 'hono/streaming';
import { skillStorage, factLayer, ensureReady, AGENT_ID } from '../mastra/storage.js';
import { hasLLM } from '../mastra/aux.js';
import { recentEvents, subscribe, eventStats } from '../mastra/events.js';
import { runSelfDemo } from '../mastra/demo.js';

const json = (c: any, body: unknown, status = 200) =>
  c.json(body as Record<string, unknown>, status);

export const adminRoutes = [
  registerApiRoute('/admin/health', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      let dbReady = false;
      try {
        await ensureReady();
        dbReady = true;
      } catch {
        dbReady = false;
      }
      return json(c, {
        ok: true,
        hasLLM,
        agentId: AGENT_ID,
        dbReady,
        events: eventStats(),
      });
    },
  }),

  registerApiRoute('/admin/skills', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      await ensureReady();
      const skills = await skillStorage.listSkills({ agentId: AGENT_ID, limit: 200 });
      return json(c, {
        skills: skills.map((s) => ({
          id: s.id,
          name: s.name,
          version: s.version,
          description: s.frontmatter.description ?? '',
          trustTier: s.trustTier,
          status: s.status,
          successCount: s.successCount,
          failCount: s.failCount,
          tags: s.frontmatter.tags ?? [],
          lastUsed: s.lastUsed,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      });
    },
  }),

  registerApiRoute('/admin/skills/:id', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      await ensureReady();
      const id = c.req.param('id');
      const skill = await skillStorage.getSkill(id);
      if (!skill) return json(c, { error: 'not found' }, 404);
      const [versions, usage] = await Promise.all([
        skillStorage.listVersions(id),
        skillStorage.getUsageStats(id),
      ]);
      return json(c, { skill, versions, usage });
    },
  }),

  registerApiRoute('/admin/skills/:id/versions', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      await ensureReady();
      const versions = await skillStorage.listVersions(c.req.param('id'));
      return json(c, { versions });
    },
  }),

  registerApiRoute('/admin/skills/:id/usage', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      await ensureReady();
      const usage = await skillStorage.getUsageStats(c.req.param('id'));
      return json(c, { usage });
    },
  }),

  registerApiRoute('/admin/facts', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      await ensureReady();
      const q = c.req.query('q') ?? '';
      const facts = await factLayer.getRelevantFacts(q, 100);
      return json(c, { facts });
    },
  }),

  registerApiRoute('/admin/events', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      const stream = c.req.query('stream');
      if (stream !== '1') {
        const limit = Number(c.req.query('limit') ?? 200);
        return json(c, { events: recentEvents(limit) });
      }
      return streamSSE(c, async (s) => {
        // Backfill, then live tail.
        for (const e of recentEvents(100)) {
          await s.writeSSE({ event: e.type, data: JSON.stringify(e) });
        }
        let closed = false;
        const unsub = subscribe((e) => {
          if (closed) return;
          void s.writeSSE({ event: e.type, data: JSON.stringify(e) });
        });
        s.onAbort(() => {
          closed = true;
          unsub();
        });
        // Keep the stream open with periodic heartbeats.
        while (!closed) {
          await s.sleep(15_000);
          if (!closed) await s.writeSSE({ event: 'ping', data: '{}' });
        }
      });
    },
  }),

  registerApiRoute('/admin/demo', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      await ensureReady();
      const result = await runSelfDemo();
      return json(c, result);
    },
  }),
];
