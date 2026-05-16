export const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  'http://localhost:4111';

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface SkillSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  trustTier: string;
  status: string;
  successCount: number;
  failCount: number;
  tags: string[];
  lastUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: string;
  content: string;
  diffFromPrevious: string | null;
  reason: string;
  createdAt: string;
}

export interface SkillDetail {
  skill: SkillSummary & { content: string; frontmatter: Record<string, unknown> };
  versions: SkillVersion[];
  usage: {
    totalUses: number;
    successRate: number;
    avgDurationMs: number;
    avgToolCalls: number;
  };
}

export interface FactEntry {
  id: string;
  category: string;
  content: string;
  confidence: number;
  sourceThreadId: string;
  createdAt: string;
  lastReinforced: string;
}

export interface LearningEvent {
  type: string;
  at: string;
  agentId: string;
  threadId: string;
  reason: string;
  skillName?: string;
  skillId?: string;
  version?: string;
}

export interface Health {
  ok: boolean;
  hasLLM: boolean;
  agentId: string;
  dbReady: boolean;
  events: { total: number; byType: Record<string, number> };
}

export const api = {
  health: () => getJSON<Health>('/admin/health'),
  skills: () => getJSON<{ skills: SkillSummary[] }>('/admin/skills'),
  skill: (id: string) => getJSON<SkillDetail>(`/admin/skills/${id}`),
  facts: (q = '') =>
    getJSON<{ facts: FactEntry[] }>(`/admin/facts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  events: () => getJSON<{ events: LearningEvent[] }>('/admin/events?limit=200'),
  runDemo: async () => {
    const res = await fetch(`${SERVER_URL}/admin/demo`, { method: 'POST' });
    if (!res.ok) throw new Error(`demo → ${res.status}`);
    return (await res.json()) as {
      skillName: string;
      extracted: boolean;
      refined: boolean;
    };
  },
  eventStreamUrl: `${SERVER_URL}/admin/events?stream=1`,
};
