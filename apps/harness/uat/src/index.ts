#!/usr/bin/env tsx
/**
 * End-to-end UAT for @avant-garde/mastra-self-learning, driven against a
 * running harness server.
 *
 *   Tier A  (always)        — full learning pipeline via the scripted demo,
 *                              asserted through the admin API. Deterministic,
 *                              no credentials.
 *   Tier B  (needs key)     — a REAL Claude-backed agent correctly operating
 *                              the self-learning tool surface end-to-end:
 *                              create → retrieve → feedback → refine → facts.
 *
 * Usage:  pnpm --filter @avant-garde/harness-uat uat
 * Reads apps/harness/uat/.env (ANTHROPIC_API_KEY, UAT_SERVER_URL, …).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── env ──────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
for (const p of [join(here, '..', '.env'), join(process.cwd(), '.env')]) {
  try {
    (process as unknown as { loadEnvFile: (f: string) => void }).loadEnvFile(p);
    break;
  } catch {
    /* no .env there — fine */
  }
}

const SERVER = process.env.UAT_SERVER_URL ?? 'http://localhost:4111';
const TIMEOUT = Number(process.env.UAT_TIMEOUT_MS ?? 120_000);

// ── tiny ANSI ────────────────────────────────────────────────────────────
const C = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ── http ─────────────────────────────────────────────────────────────────
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}
async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = TIMEOUT,
  intervalMs = 2500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < deadline);
  return last!;
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── types ────────────────────────────────────────────────────────────────
interface Health {
  ok: boolean;
  hasLLM: boolean;
  dbReady: boolean;
  agentId: string;
  events: { total: number };
}
interface Skill {
  id: string;
  name: string;
  version: string;
  status: string;
  trustTier: string;
  successCount: number;
  failCount: number;
}
interface SkillDetail {
  skill: Skill & { content: string };
  versions: Array<{ version: string; reason: string; diffFromPrevious: string | null }>;
  usage: { totalUses: number; successRate: number };
}
interface ChatResult {
  text: string;
  toolCalls: string[];
  threadId: string;
}

// ── scenario harness ─────────────────────────────────────────────────────
type Status = 'pass' | 'fail' | 'skip';
interface Result {
  id: string;
  tier: 'A' | 'B';
  title: string;
  status: Status;
  detail: string;
  ms: number;
}
const results: Result[] = [];
const ctx: { skillName?: string; skillId?: string } = {};

async function run(
  id: string,
  tier: 'A' | 'B',
  title: string,
  fn: () => Promise<string>,
  skip?: string,
) {
  process.stdout.write(`${C.d(`[${id}]`)} ${title} … `);
  if (skip) {
    results.push({ id, tier, title, status: 'skip', detail: skip, ms: 0 });
    console.log(C.y('SKIP'));
    return;
  }
  const t = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t;
    results.push({ id, tier, title, status: 'pass', detail, ms });
    console.log(`${C.g('PASS')} ${C.d(`${ms}ms`)}`);
    if (detail) console.log(`      ${C.d(detail)}`);
  } catch (e) {
    const ms = Date.now() - t;
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ id, tier, title, status: 'fail', detail, ms });
    console.log(`${C.r('FAIL')} ${C.d(`${ms}ms`)}`);
    console.log(`      ${C.r(detail)}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(C.b('\n  Self-Learning Harness — UAT\n'));
  console.log(C.d(`  server: ${SERVER}   timeout: ${TIMEOUT}ms\n`));

  let health: Health;
  try {
    health = await get<Health>('/admin/health');
  } catch (e) {
    console.log(
      C.r(
        `\n  Cannot reach harness at ${SERVER}. Start it first:\n` +
          `    docker compose -f apps/harness/docker-compose.yml up -d\n` +
          `    pnpm --filter @avant-garde/harness-server dev\n`,
      ),
    );
    console.log(C.d(`  (${e instanceof Error ? e.message : e})\n`));
    process.exit(2);
  }

  const noKey = !health.hasLLM
    ? 'ANTHROPIC_API_KEY not set on the server — Tier-B (real-LLM) skipped.'
    : undefined;

  // ── Tier A: deterministic pipeline ─────────────────────────────────────
  await run('A1', 'A', 'Preflight: server + DB healthy', async () => {
    assert(health.ok, 'health.ok is false');
    assert(health.dbReady, 'database not ready');
    return `agent=${health.agentId}  llm=${health.hasLLM ? 'configured' : 'absent'}`;
  });

  await run('A2', 'A', 'Pipeline: scripted demo extracts AND refines a skill', async () => {
    const demo = await post<{ skillName: string; extracted: boolean; refined: boolean }>(
      '/admin/demo',
    );
    assert(demo.extracted, 'demo did not extract a skill');
    assert(demo.refined, 'demo did not refine the skill');
    ctx.skillName = demo.skillName;
    return `skill="${demo.skillName}" extracted+refined`;
  });

  await run('A3', 'A', 'Versioning: active v1.0.1 carries the diff (single-write)', async () => {
    const list = await get<{ skills: Skill[] }>('/admin/skills');
    const s = list.skills.find((x) => x.name === ctx.skillName);
    assert(s, `demo skill "${ctx.skillName}" not in /admin/skills`);
    ctx.skillId = s!.id;
    const d = await get<SkillDetail>(`/admin/skills/${s!.id}`);
    assert(d.skill.version === '1.0.1', `active version is ${d.skill.version}, expected 1.0.1`);
    assert(d.skill.status === 'active', `status is ${d.skill.status}`);
    assert(d.skill.trustTier === 'agent-created', `trust is ${d.skill.trustTier}`);
    assert(d.versions.length === 2, `expected 2 versions, got ${d.versions.length}`);
    const refined = d.versions.find((v) => v.version === '1.0.1');
    assert(refined, 'no 1.0.1 version row');
    assert(
      refined!.diffFromPrevious && /IAM propagation/.test(refined!.diffFromPrevious),
      'refined version is missing the IAM-propagation diff',
    );
    assert(/IAM propagation/.test(d.skill.content), 'active content missing the learned pitfall');
    return `v1.0.1 active, diff present, 2 versions, content has learned pitfall`;
  });

  await run('A4', 'A', 'Usage + events: failure recorded, loop events emitted', async () => {
    const d = await get<SkillDetail>(`/admin/skills/${ctx.skillId}`);
    assert(d.usage.totalUses >= 1, `usage.totalUses=${d.usage.totalUses}`);
    assert(d.skill.failCount >= 1, `failCount=${d.skill.failCount}`);
    const ev = await get<{ events: Array<{ type: string; skillName?: string }> }>(
      '/admin/events?limit=200',
    );
    const mine = ev.events.filter((e) => e.skillName === ctx.skillName);
    const types = new Set(mine.map((e) => e.type));
    assert(types.has('extraction.completed'), 'no extraction.completed event');
    assert(types.has('refinement.completed'), 'no refinement.completed event');
    return `uses=${d.usage.totalUses} fail=${d.skill.failCount} events=[${[...types].join(', ')}]`;
  });

  // ── Tier B: real LLM operating the tool surface ────────────────────────
  const A = 'You have self-learning skill/memory tools. ';
  await run(
    'B1',
    'B',
    'Real agent creates a skill via skill_create',
    async () => {
      const before = (await get<{ skills: Skill[] }>('/admin/skills')).skills.length;
      const chat = await post<ChatResult>('/admin/chat', {
        message:
          A +
          'Formalize this into a reusable skill using the skill_create tool: ' +
          '"Deploying a containerized service to Google Cloud Run with canary ' +
          'traffic splitting" — include When to Use, Prerequisites, a numbered ' +
          'Procedure, Verification, and Pitfalls. Call skill_create with a full ' +
          'SKILL.md (YAML frontmatter + body). Then confirm.',
        threadId: `uat-b1-${Date.now()}`,
      });
      const after = await pollUntil(
        () => get<{ skills: Skill[] }>('/admin/skills'),
        (v) => v.skills.length > before,
      );
      assert(
        after.skills.length > before,
        `no new skill created (toolCalls=[${chat.toolCalls.join(', ')}])`,
      );
      const created = after.skills.sort((a, b) => (a.id < b.id ? 1 : -1))[0];
      ctx.skillName = created.name;
      ctx.skillId = created.id;
      const d = await get<SkillDetail>(`/admin/skills/${created.id}`);
      assert(/##\s*Procedure/i.test(d.skill.content), 'created skill has no Procedure section');
      return `created "${created.name}" via [${chat.toolCalls.join(', ') || 'no tools reported'}]`;
    },
    noKey,
  );

  await run(
    'B2',
    'B',
    'Real agent retrieves the learned skill (L0 → skill_view)',
    async () => {
      assert(ctx.skillName, 'no skill from B1');
      const chat = await post<ChatResult>('/admin/chat', {
        message:
          A +
          'List your available skills with skill_list, then open the Cloud Run ' +
          'deployment one with skill_view and summarize its Procedure.',
        threadId: `uat-b2-${Date.now()}`,
      });
      const used = chat.toolCalls.filter((t) =>
        ['skill_list', 'skill_search', 'skill_view'].includes(t),
      );
      assert(
        used.length > 0,
        `agent did not use any discovery tool (toolCalls=[${chat.toolCalls.join(', ')}])`,
      );
      return `discovery via [${used.join(', ')}]`;
    },
    noKey,
  );

  await run(
    'B3',
    'B',
    'Real agent records usage via skill_feedback',
    async () => {
      assert(ctx.skillId && ctx.skillName, 'no skill from B1');
      await post<ChatResult>('/admin/chat', {
        message:
          A +
          `You just followed the skill "${ctx.skillName}" and it worked. ` +
          'Record the outcome by calling skill_feedback with outcome "success".',
        threadId: `uat-b3-${Date.now()}`,
      });
      const d = await pollUntil(
        () => get<SkillDetail>(`/admin/skills/${ctx.skillId}`),
        (v) => v.usage.totalUses >= 1,
      );
      assert(d.usage.totalUses >= 1, 'no usage recorded via skill_feedback');
      return `usage.totalUses=${d.usage.totalUses}`;
    },
    noKey,
  );

  await run(
    'B4',
    'B',
    'Real agent refines the skill via skill_update (new version + diff)',
    async () => {
      assert(ctx.skillId && ctx.skillName, 'no skill from B1');
      const before = (await get<SkillDetail>(`/admin/skills/${ctx.skillId}`)).versions.length;
      await post<ChatResult>('/admin/chat', {
        message:
          A +
          `Update the skill "${ctx.skillName}" using skill_update: add a Pitfall ` +
          '"IAM propagation delay: wait 60s after granting roles before deploying." ' +
          'Provide the full revised SKILL.md and a reason.',
        threadId: `uat-b4-${Date.now()}`,
      });
      const d = await pollUntil(
        () => get<SkillDetail>(`/admin/skills/${ctx.skillId}`),
        (v) =>
          v.versions.length > before ||
          v.versions.some((x) => x.diffFromPrevious && /IAM propagation/.test(x.diffFromPrevious)),
      );
      const hasDiff = d.versions.some(
        (v) => v.diffFromPrevious && /IAM propagation/.test(v.diffFromPrevious),
      );
      assert(
        d.versions.length > before || hasDiff,
        `no new version/diff (versions ${before}→${d.versions.length})`,
      );
      return `versions ${before}→${d.versions.length}, diff=${hasDiff}`;
    },
    noKey,
  );

  await run(
    'B5',
    'B',
    'Real agent persists + recalls a cross-thread fact',
    async () => {
      const token = `uat-proj-${Math.floor(Math.random() * 1e6)}`;
      await post<ChatResult>('/admin/chat', {
        message:
          A +
          `Remember this for future conversations using memory_persist ` +
          `(category "credential"): our GCP project id is ${token}.`,
        threadId: `uat-b5a-${Date.now()}`,
      });
      const facts = await pollUntil(
        () => get<{ facts: Array<{ content: string }> }>('/admin/facts'),
        (v) => v.facts.some((f) => f.content.includes(token)),
        TIMEOUT,
        2000,
      );
      assert(
        facts.facts.some((f) => f.content.includes(token)),
        'fact was not persisted via memory_persist',
      );
      const recall = await post<ChatResult>('/admin/chat', {
        message:
          A + 'In a brand-new conversation: what is our GCP project id? Use memory_recall.',
        threadId: `uat-b5b-${Date.now()}`,
      });
      const recalled =
        recall.text.includes(token) || recall.toolCalls.includes('memory_recall');
      assert(recalled, `agent did not recall the fact (text/recall miss)`);
      return `persisted ${token}; recalled (${recall.toolCalls.join(', ') || 'in text'})`;
    },
    noKey,
  );

  // ── report ─────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  console.log(C.b('\n  ── Summary ──'));
  for (const r of results) {
    const m =
      r.status === 'pass' ? C.g('PASS') : r.status === 'fail' ? C.r('FAIL') : C.y('SKIP');
    console.log(`  ${m}  ${C.d(`[${r.id}/${r.tier}]`)} ${r.title}`);
  }
  console.log(
    `\n  ${C.g(`${pass} passed`)}  ${fail ? C.r(`${fail} failed`) : `${fail} failed`}  ${C.y(`${skip} skipped`)}\n`,
  );
  if (skip && !health.hasLLM) {
    console.log(
      C.y(
        '  Tier-B skipped: set ANTHROPIC_API_KEY in apps/harness/server env and\n' +
          '  restart the server to exercise the real-LLM scenarios.\n',
      ),
    );
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error(C.r(`\nUAT crashed: ${e instanceof Error ? e.stack : e}\n`));
  process.exit(3);
});
