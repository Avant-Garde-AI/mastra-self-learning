import { ulid } from 'ulid';
import type { FactLayerConfig } from '../config.js';
import type {
  SkillStorageExtension,
  MastraPostgresLike,
} from '../skills/storage-extension.js';

export interface FactEntry {
  id: string;
  category: 'preference' | 'context' | 'project' | 'credential' | 'constraint' | 'relationship';
  content: string;
  /** Confidence score (0-1), decays over time if not reinforced */
  confidence: number;
  sourceThreadId: string;
  agentId?: string | null;
  createdAt: string;
  lastReinforced: string;
  /** Optional TTL in seconds */
  ttl?: number | null;
}

/** The minimum DB surface FactLayer needs. Reuses the storage extension's db. */
interface FactLayerDb {
  any<T = unknown>(q: string, v?: unknown[]): Promise<T[]>;
  one<T = unknown>(q: string, v?: unknown[]): Promise<T>;
  oneOrNone<T = unknown>(q: string, v?: unknown[]): Promise<T | null>;
  none(q: string, v?: unknown[]): Promise<null>;
}

interface FactRow {
  id: string;
  agent_id: string | null;
  category: FactEntry['category'];
  content: string;
  confidence: number | string;
  source_thread_id: string;
  ttl_seconds: number | null;
  created_at: Date;
  last_reinforced: Date;
}

/** Facts below this confidence are excluded from retrieval and archived by decay. */
const CONFIDENCE_FLOOR = 0.1;
/** Seconds in a week — decay period unit. */
const WEEK_SECONDS = 604_800;

/**
 * Cross-thread fact persistence layer.
 *
 * Composes alongside Observational Memory rather than replacing it:
 *   - OM handles conversation compression (within a thread)
 *   - FactLayer handles persistent facts (across threads)
 *
 * Backed by the `mastra_self_learning_facts` table created in Phase 1's
 * `SkillStorageExtension.ensureSchema()`. We accept either the extension
 * itself or a raw `MastraPostgresLike` and reach the `db` client from there.
 *
 * @see docs/mvp/04-phase-context-injection.md
 */
export class FactLayer {
  private db: FactLayerDb;

  constructor(
    storage: SkillStorageExtension | MastraPostgresLike,
    private config: FactLayerConfig,
    private agentId: string | null = null,
  ) {
    // Both SkillStorageExtension and MastraPostgresLike expose a `.db` getter.
    const maybeDb = (storage as unknown as { db?: FactLayerDb }).db;
    if (!maybeDb) {
      throw new Error(
        'FactLayer: could not resolve a db client from the provided storage. ' +
          'Pass a PostgresStore or a SkillStorageExtension constructed from one.',
      );
    }
    this.db = maybeDb;
  }

  async persistFact(
    fact: Omit<FactEntry, 'id' | 'createdAt' | 'lastReinforced'>,
  ): Promise<FactEntry> {
    // Soft dedup: identical content + same agent → reinforce instead of insert.
    const existing = await this.db.oneOrNone<FactRow>(
      `SELECT * FROM mastra_self_learning_facts
       WHERE content = $1
         AND ((agent_id IS NULL AND $2::text IS NULL) OR agent_id = $2)
       LIMIT 1`,
      [fact.content, fact.agentId ?? this.agentId],
    );
    if (existing) {
      await this.reinforceFact(existing.id);
      const refreshed = await this.db.one<FactRow>(
        `SELECT * FROM mastra_self_learning_facts WHERE id = $1`,
        [existing.id],
      );
      return rowToFact(refreshed);
    }

    const id = ulid();
    const row = await this.db.one<FactRow>(
      `INSERT INTO mastra_self_learning_facts
         (id, agent_id, category, content, confidence, source_thread_id, ttl_seconds, created_at, last_reinforced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       RETURNING *`,
      [
        id,
        fact.agentId ?? this.agentId,
        fact.category,
        fact.content,
        clampConfidence(fact.confidence ?? 1.0),
        fact.sourceThreadId,
        fact.ttl ?? null,
      ],
    );
    return rowToFact(row);
  }

  async getRelevantFacts(context: string, limit = 10): Promise<FactEntry[]> {
    const query = context?.trim();
    const agentId = this.agentId;

    if (query) {
      const rows = await this.db.any<FactRow & { rank: number }>(
        `SELECT *,
                ts_rank_cd(search_vector, plainto_tsquery('english', $1)) AS rank
         FROM mastra_self_learning_facts
         WHERE search_vector @@ plainto_tsquery('english', $1)
           AND ((agent_id IS NULL AND $2::text IS NULL) OR agent_id = $2 OR agent_id IS NULL)
           AND confidence >= $3
           AND (ttl_seconds IS NULL OR created_at + (ttl_seconds || ' seconds')::interval > now())
         ORDER BY rank DESC, confidence DESC
         LIMIT $4`,
        [query, agentId, CONFIDENCE_FLOOR, limit],
      );
      if (rows.length > 0) return rows.map(rowToFact);
      // Fall through to confidence-ordered listing if FTS found nothing.
    }

    const rows = await this.db.any<FactRow>(
      `SELECT * FROM mastra_self_learning_facts
       WHERE ((agent_id IS NULL AND $1::text IS NULL) OR agent_id = $1 OR agent_id IS NULL)
         AND confidence >= $2
         AND (ttl_seconds IS NULL OR created_at + (ttl_seconds || ' seconds')::interval > now())
       ORDER BY confidence DESC, last_reinforced DESC
       LIMIT $3`,
      [agentId, CONFIDENCE_FLOOR, limit],
    );
    return rows.map(rowToFact);
  }

  async reinforceFact(id: string): Promise<void> {
    await this.db.none(
      `UPDATE mastra_self_learning_facts
       SET confidence = 1.0, last_reinforced = now()
       WHERE id = $1`,
      [id],
    );
  }

  /**
   * Apply exponential confidence decay based on weeks since last reinforcement.
   * Returns the number of fact rows whose confidence was updated.
   *
   * Implemented but **not scheduled** in the MVP — call manually or from a
   * future gardening workflow.
   */
  async applyDecay(): Promise<number> {
    const rows = await this.db.any<{ id: string }>(
      `UPDATE mastra_self_learning_facts
       SET confidence = GREATEST(0,
             confidence * power(1 - $1::float,
               EXTRACT(epoch FROM (now() - last_reinforced)) / $2::float))
       WHERE confidence > $3
       RETURNING id`,
      [this.config.decayRate, WEEK_SECONDS, CONFIDENCE_FLOOR],
    );
    return rows.length;
  }

  /**
   * Build the Facts block for system-prompt injection. Returns an empty string
   * when there are no qualifying facts so the caller can omit the section
   * (and its separator) cleanly.
   */
  async buildFactsBlock(): Promise<string> {
    const facts = await this.getRelevantFacts('', 20);
    if (facts.length === 0) return '';
    const lines = facts.map(
      (f) => `- (${f.category}) ${f.content} [confidence: ${f.confidence.toFixed(2)}]`,
    );
    return `## Facts\n\n${lines.join('\n')}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToFact(row: FactRow): FactEntry {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    confidence: Number(row.confidence),
    sourceThreadId: row.source_thread_id,
    agentId: row.agent_id,
    createdAt: toIso(row.created_at),
    lastReinforced: toIso(row.last_reinforced),
    ttl: row.ttl_seconds,
  };
}

/**
 * Coerce a DB timestamp into an ISO string. node-postgres returns
 * `TIMESTAMPTZ` as a `Date`, but be defensive at this boundary: a string
 * (some pool adapters / driver configs) or a missing value must not throw.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function clampConfidence(c: number): number {
  if (Number.isNaN(c)) return 1.0;
  return Math.min(1, Math.max(0, c));
}
