import { ulid } from 'ulid';
import type {
  SkillRecord,
  SkillVersionRecord,
  SkillUsageRecord,
  SkillSearchOptions,
  SkillSearchResult,
  SkillFrontmatter,
} from './types.js';
import type { TrustTier } from '../config.js';
import { parseSkillDocument, serializeSkillDocument } from './parser.js';
import { makeSafeEmbedder, toVectorLiteral, type EmbedText } from './embedding.js';

/**
 * Minimal subset of Mastra's `PostgresStore` we depend on.
 * Defined structurally so we don't take a hard import dep on `@mastra/pg` at type level
 * (the package is a peer dep; we only need access to `.db` and the skills domain).
 *
 * See packages/core/MASTRA_API_NOTES.md for full surface.
 */
export interface MastraPostgresLike {
  db: {
    any<T = unknown>(query: string, values?: unknown[]): Promise<T[]>;
    one<T = unknown>(query: string, values?: unknown[]): Promise<T>;
    oneOrNone<T = unknown>(query: string, values?: unknown[]): Promise<T | null>;
    none(query: string, values?: unknown[]): Promise<null>;
    tx<T>(callback: (t: MastraTxClient) => Promise<T>): Promise<T>;
  };
  init?(): Promise<void>;
  getStore?<K extends string>(name: K): Promise<unknown>;
}

export interface MastraTxClient {
  any<T = unknown>(query: string, values?: unknown[]): Promise<T[]>;
  one<T = unknown>(query: string, values?: unknown[]): Promise<T>;
  oneOrNone<T = unknown>(query: string, values?: unknown[]): Promise<T | null>;
  none(query: string, values?: unknown[]): Promise<null>;
  many<T = unknown>(query: string, values?: unknown[]): Promise<T[]>;
}

export interface SkillStorageExtensionOptions {
  trackUsage?: boolean;
  trackVersions?: boolean;
  trackTrust?: boolean;
  trackExtraction?: boolean;
  /**
   * Optional embedder. When set (and pgvector is available) skill embeddings
   * are computed on create/update for semantic search & dedup (v0.2.0).
   */
  embed?: EmbedText;
  /** Embedding dimensions; must match `embed`. Default 1536. */
  embeddingDimensions?: number;
}

/** Stable typed error for duplicate skill name within an agent scope. */
export class SkillNameConflictError extends Error {
  constructor(name: string, agentId?: string | null) {
    super(`Skill name conflict: "${name}" already exists${agentId ? ` for agent ${agentId}` : ' globally'}`);
    this.name = 'SkillNameConflictError';
  }
}

/**
 * Internal: row shape returned by joined skill + stats + search queries.
 */
interface SkillRowJoined {
  id: string;
  status: 'draft' | 'published' | 'archived';
  active_version_id: string | null;
  author_id: string | null;
  created_at: Date;
  updated_at: Date;
  // From mastra_skill_versions (active version)
  version_number: number | null;
  name: string;
  description: string;
  instructions: string;
  version_metadata: Record<string, unknown> | null;
  // From our stats
  success_count: number;
  fail_count: number;
  last_used: Date | null;
  // Derived
  trust_tier: TrustTier;
}

/**
 * Extended skill storage that layers learning-loop metadata on top of
 * Mastra's `SkillsStorage` domain.
 *
 * Mastra owns:
 *   - mastra_skills           (thin record: id, status, activeVersionId, authorId)
 *   - mastra_skill_versions   (versioned snapshot: name, description, instructions, metadata)
 *   - mastra_skill_blobs      (BlobStore content-addressable; not used in MVP)
 *
 * We own (created by ensureSchema()):
 *   - mastra_self_learning_skill_stats  (per-skill mutable counters)
 *   - mastra_self_learning_skill_usage  (per-invocation outcome logs)
 *   - mastra_self_learning_facts        (cross-thread fact layer)
 *   - mastra_self_learning_skill_search (denormalized FTS projection)
 */
export class SkillStorageExtension {
  private storage: MastraPostgresLike;
  private vectorAvailable: boolean | null = null;
  private semanticEnabled = false;
  private readonly embed: EmbedText | null;
  private readonly embDim: number;

  constructor(
    storage: MastraPostgresLike,
    public readonly options: SkillStorageExtensionOptions = {},
  ) {
    this.storage = storage;
    this.embed = makeSafeEmbedder(options.embed);
    this.embDim = options.embeddingDimensions ?? 1536;
  }

  /**
   * The underlying pgPromise-style db client. Exposed so sibling layers
   * (e.g. `FactLayer`) can reuse the same connection pool instead of
   * reaching into private internals.
   */
  get db(): MastraPostgresLike['db'] {
    return this.storage.db;
  }

  /** True after ensureSchema() ran and pgvector was successfully enabled. */
  get semanticSearchAvailable(): boolean {
    return this.semanticEnabled;
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async ensureSchema(): Promise<void> {
    // Run Mastra's init first so mastra_skills / mastra_skill_versions exist.
    if (typeof this.storage.init === 'function') {
      await this.storage.init();
    }

    // Try enabling pgvector — non-fatal.
    try {
      await this.storage.db.none(`CREATE EXTENSION IF NOT EXISTS vector`);
      this.vectorAvailable = true;
      this.semanticEnabled = true;
    } catch (err) {
      this.vectorAvailable = false;
      this.semanticEnabled = false;
      // eslint-disable-next-line no-console
      console.warn(
        '[mastra-self-learning] pgvector extension unavailable — semantic search will be disabled. ' +
          'Install pgvector or use a Postgres image with it bundled.',
        err instanceof Error ? err.message : err,
      );
    }

    // Auxiliary tables — single transaction so a partial failure rolls back.
    await this.storage.db.tx(async (tx) => {
      await tx.none(`
        CREATE TABLE IF NOT EXISTS mastra_self_learning_skill_stats (
          skill_id      TEXT PRIMARY KEY REFERENCES mastra_skills(id) ON DELETE CASCADE,
          success_count INT  NOT NULL DEFAULT 0,
          fail_count    INT  NOT NULL DEFAULT 0,
          last_used     TIMESTAMPTZ,
          agent_id      TEXT
        )
      `);
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_skill_stats_agent_idx ON mastra_self_learning_skill_stats (agent_id)`,
      );

      // Add embedding column only if pgvector is available.
      if (this.vectorAvailable) {
        await tx.none(
          `ALTER TABLE mastra_self_learning_skill_stats ADD COLUMN IF NOT EXISTS embedding VECTOR`,
        );
      }

      await tx.none(`
        CREATE TABLE IF NOT EXISTS mastra_self_learning_skill_usage (
          id          TEXT PRIMARY KEY,
          skill_id    TEXT NOT NULL REFERENCES mastra_skills(id) ON DELETE CASCADE,
          thread_id   TEXT NOT NULL,
          agent_id    TEXT NOT NULL,
          outcome     TEXT NOT NULL CHECK (outcome IN ('success','failure','partial','abandoned')),
          feedback    TEXT,
          duration_ms INT  NOT NULL DEFAULT 0,
          tool_calls  INT  NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_skill_usage_skill_idx ON mastra_self_learning_skill_usage (skill_id, created_at DESC)`,
      );
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_skill_usage_thread_idx ON mastra_self_learning_skill_usage (thread_id)`,
      );

      await tx.none(`
        CREATE TABLE IF NOT EXISTS mastra_self_learning_facts (
          id                TEXT PRIMARY KEY,
          agent_id          TEXT,
          category          TEXT NOT NULL CHECK (category IN (
            'preference','context','project','credential','constraint','relationship'
          )),
          content           TEXT NOT NULL,
          confidence        REAL NOT NULL DEFAULT 1.0,
          source_thread_id  TEXT NOT NULL,
          ttl_seconds       INT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_reinforced   TIMESTAMPTZ NOT NULL DEFAULT now(),
          search_vector     TSVECTOR
            GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
        )
      `);
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_facts_agent_idx ON mastra_self_learning_facts (agent_id, created_at DESC)`,
      );
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_facts_search_idx ON mastra_self_learning_facts USING GIN (search_vector)`,
      );

      await tx.none(`
        CREATE TABLE IF NOT EXISTS mastra_self_learning_skill_search (
          skill_id      TEXT PRIMARY KEY REFERENCES mastra_skills(id) ON DELETE CASCADE,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL,
          instructions  TEXT NOT NULL,
          trust_tier    TEXT NOT NULL DEFAULT 'agent-created',
          status        TEXT NOT NULL,
          agent_id      TEXT,
          tags          TEXT[] NOT NULL DEFAULT '{}',
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          search_vector TSVECTOR
            GENERATED ALWAYS AS (
              setweight(to_tsvector('english', coalesce(name, '')),         'A') ||
              setweight(to_tsvector('english', coalesce(description, '')),  'B') ||
              setweight(to_tsvector('english', coalesce(instructions, '')), 'C')
            ) STORED,
          UNIQUE (name, agent_id)
        )
      `);
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_skill_search_idx ON mastra_self_learning_skill_search USING GIN (search_vector)`,
      );
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_skill_search_agent_status_idx ON mastra_self_learning_skill_search (agent_id, status)`,
      );
      await tx.none(
        `CREATE INDEX IF NOT EXISTS msl_skill_search_tags_idx ON mastra_self_learning_skill_search USING GIN (tags)`,
      );

      // v0.2.0: typed embedding column + ANN index on the search projection.
      if (this.vectorAvailable) {
        await tx.none(
          `ALTER TABLE mastra_self_learning_skill_search
             ADD COLUMN IF NOT EXISTS embedding vector(${this.embDim})`,
        );
        await tx.none(
          `CREATE INDEX IF NOT EXISTS msl_skill_search_vec_idx
             ON mastra_self_learning_skill_search
             USING hnsw (embedding vector_cosine_ops)`,
        );
        await tx.none(
          `CREATE TABLE IF NOT EXISTS msl_meta (key TEXT PRIMARY KEY, value TEXT)`,
        );
      }
    });

    // Embedding-dimension guard (outside the DDL tx). A model/dim change
    // silently mis-ranks; detect, warn loudly, disable semantic until backfill.
    if (this.vectorAvailable) {
      try {
        const row = await this.storage.db.oneOrNone<{ value: string }>(
          `SELECT value FROM msl_meta WHERE key = 'embedding_dim'`,
        );
        if (!row) {
          await this.storage.db.none(
            `INSERT INTO msl_meta (key, value) VALUES ('embedding_dim', $1)
             ON CONFLICT (key) DO NOTHING`,
            [String(this.embDim)],
          );
        } else if (Number(row.value) !== this.embDim) {
          this.semanticEnabled = false;
          // eslint-disable-next-line no-console
          console.warn(
            `[mastra-self-learning] stored embedding dim ${row.value} != configured ${this.embDim}. ` +
              `Semantic search disabled until backfillEmbeddings() re-embeds at the new dimension.`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] embedding-dim guard check failed; continuing.',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------

  /** True only when pgvector is usable AND an embedder is configured. */
  get semanticReady(): boolean {
    return this.semanticEnabled && this.vectorAvailable === true && !!this.embed;
  }

  /**
   * Embed a skill's searchable surface (name + description + body). Returns
   * null (degrade to FTS) when no embedder, pgvector unavailable, or on error.
   */
  private async computeEmbedding(
    name: string,
    description: string,
    body: string,
  ): Promise<number[] | null> {
    if (!this.embed || !this.vectorAvailable) return null;
    try {
      const [vec] = await this.embed([`${name}\n${description}\n${body}`]);
      if (!vec || vec.length !== this.embDim) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mastra-self-learning] embedding dim ${vec?.length} != ${this.embDim}; skipping (FTS still works).`,
        );
        return null;
      }
      return vec;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[mastra-self-learning] embedding failed; row stays FTS-only.',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Embed the caller's query text (used by SkillSearch / dedup). */
  async embedQuery(text: string): Promise<number[] | null> {
    if (!this.embed || !this.vectorAvailable) return null;
    try {
      const [vec] = await this.embed([text]);
      return vec && vec.length === this.embDim ? vec : null;
    } catch {
      return null;
    }
  }

  /**
   * Re-embed skill rows missing an embedding (or all, after a model/dim
   * change). Idempotent; safe to call repeatedly. Returns count updated.
   */
  async backfillEmbeddings(opts?: { all?: boolean; limit?: number }): Promise<number> {
    if (!this.semanticReady) return 0;
    const limit = opts?.limit ?? 500;
    const rows = await this.storage.db.any<{
      skill_id: string;
      name: string;
      description: string;
      instructions: string;
    }>(
      `SELECT skill_id, name, description, instructions
         FROM mastra_self_learning_skill_search
        WHERE ${opts?.all ? 'TRUE' : 'embedding IS NULL'}
        LIMIT $1`,
      [limit],
    );
    let n = 0;
    for (const r of rows) {
      const vec = await this.computeEmbedding(r.name, r.description, r.instructions);
      if (!vec) continue;
      await this.storage.db.none(
        `UPDATE mastra_self_learning_skill_search SET embedding = $1::vector WHERE skill_id = $2`,
        [toVectorLiteral(vec), r.skill_id],
      );
      n++;
    }
    if (n > 0) {
      await this.storage.db.none(
        `INSERT INTO msl_meta (key, value) VALUES ('embedding_dim', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(this.embDim)],
      );
      // A successful backfill clears a stale-dim disable.
      if (this.vectorAvailable) this.semanticEnabled = true;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Skill CRUD
  // -------------------------------------------------------------------------

  async createSkill(
    input: Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<SkillRecord> {
    const id = ulid();
    const now = new Date();
    const versionId = ulid();
    const trustTier: TrustTier = input.trustTier ?? 'agent-created';
    const status = mapStatus(input.status);
    const tags = input.frontmatter.tags ?? [];
    const agentId = input.agentId ?? null;

    // Serialize metadata for the version snapshot. We split: persisted markdown body
    // goes to instructions, learning-loop fields go to metadata.
    const versionMetadata = buildVersionMetadata(input.frontmatter, trustTier);

    // Compute embedding BEFORE the tx (network call — don't hold the tx open).
    const body = extractBody(input.content);
    const embVec = await this.computeEmbedding(
      input.frontmatter.name,
      input.frontmatter.description,
      body,
    );

    try {
      await this.storage.db.tx(async (tx) => {
        // 1. mastra_skills row
        await tx.none(
          `INSERT INTO mastra_skills (id, status, "activeVersionId", "authorId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [id, status, versionId, agentId, now],
        );

        // 2. mastra_skill_versions row
        await tx.none(
          `INSERT INTO mastra_skill_versions (
             id, "skillId", "versionNumber", name, description, instructions, metadata, "createdAt"
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            versionId,
            id,
            1,
            input.frontmatter.name,
            input.frontmatter.description,
            extractBody(input.content),
            versionMetadata,
            now,
          ],
        );

        // 3. Our stats row
        await tx.none(
          `INSERT INTO mastra_self_learning_skill_stats (skill_id, success_count, fail_count, agent_id)
           VALUES ($1, $2, $3, $4)`,
          [id, input.successCount ?? 0, input.failCount ?? 0, agentId],
        );

        // 4. Search projection — we store OUR status semantic ('active'/'draft'/'deprecated'/'archived'),
        // not Mastra's ('published'/'draft'/'archived'), so callers can filter intuitively.
        await tx.none(
          `INSERT INTO mastra_self_learning_skill_search
             (skill_id, name, description, instructions, trust_tier, status, agent_id, tags, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            input.frontmatter.name,
            input.frontmatter.description,
            body,
            trustTier,
            input.status,
            agentId,
            tags,
            now,
          ],
        );
        if (embVec) {
          await tx.none(
            `UPDATE mastra_self_learning_skill_search
               SET embedding = $1::vector WHERE skill_id = $2`,
            [toVectorLiteral(embVec), id],
          );
        }
      });
    } catch (err) {
      throw rethrowAsTyped(err, input.frontmatter.name, agentId);
    }

    return {
      id,
      name: input.frontmatter.name,
      version: input.version ?? '1.0.0',
      content: input.content,
      frontmatter: input.frontmatter,
      embedding: input.embedding,
      agentId: agentId,
      trustTier,
      status: input.status,
      successCount: input.successCount ?? 0,
      failCount: input.failCount ?? 0,
      lastUsed: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    const row = await this.storage.db.oneOrNone<SkillRowJoined>(
      buildSkillSelectSQL('s.id = $1'),
      [id],
    );
    return row ? rowToSkillRecord(row) : null;
  }

  async getSkillByName(name: string, agentId?: string): Promise<SkillRecord | null> {
    const a = agentId ?? null;
    const row = await this.storage.db.oneOrNone<SkillRowJoined>(
      buildSkillSelectSQL(
        `v.name = $1 AND (
           ($2::text IS NULL AND s."authorId" IS NULL) OR
           ($2::text IS NOT NULL AND s."authorId" = $2)
         )`,
      ),
      [name, a],
    );
    return row ? rowToSkillRecord(row) : null;
  }

  /**
   * Update a skill. Creates a new immutable version row, flips the active
   * version to it, and refreshes the search projection — all in one
   * transaction. This is the single authoritative versioning write; callers
   * MUST NOT also call `createVersion` for the same change (that produces an
   * orphan, non-active version row).
   *
   * @param versionMeta Optional unified diff + reason persisted on the new
   *   active version row (used by refinement / manual updates so the active
   *   version carries its own audit trail).
   */
  async updateSkill(
    id: string,
    updates: Partial<SkillRecord>,
    versionMeta?: { diff?: string | null; reason?: string },
  ): Promise<SkillRecord> {
    const existing = await this.getSkill(id);
    if (!existing) throw new Error(`Skill not found: ${id}`);

    const forbidden = new Set([
      'id',
      'createdAt',
      'successCount',
      'failCount',
      'lastUsed',
    ]);
    for (const key of Object.keys(updates)) {
      if (forbidden.has(key)) {
        throw new Error(
          `updateSkill: field "${key}" cannot be updated via this method. Use the dedicated method (recordUsage / etc.).`,
        );
      }
    }

    const merged: SkillRecord = {
      ...existing,
      ...updates,
      // Re-derive trust_tier if frontmatter changed
      frontmatter: updates.frontmatter ?? existing.frontmatter,
    };
    const now = new Date();
    const newVersionId = ulid();
    const trustTier: TrustTier = updates.trustTier ?? existing.trustTier;
    const newStatus = mapStatus(updates.status ?? existing.status);
    // Explicit `updates.version` wins over frontmatter-derived semver so the
    // ACTIVE version row reflects what the caller asked for (refiner passes
    // the bumped version here).
    const effectiveSemver =
      updates.version ?? merged.frontmatter.version ?? existing.version;
    const newVersionMetadata = buildVersionMetadata(merged.frontmatter, trustTier, {
      semver: effectiveSemver,
      diff: versionMeta?.diff,
      reason: versionMeta?.reason,
    });
    const newBody = extractBody(updates.content ?? existing.content);

    // Recompute the embedding only when the embedded surface actually changed.
    const oldBody = extractBody(existing.content);
    const contentChanged =
      merged.frontmatter.name !== existing.frontmatter.name ||
      merged.frontmatter.description !== existing.frontmatter.description ||
      newBody !== oldBody;
    const newEmbVec = contentChanged
      ? await this.computeEmbedding(
          merged.frontmatter.name,
          merged.frontmatter.description,
          newBody,
        )
      : null;

    try {
      await this.storage.db.tx(async (tx) => {
        // Determine new versionNumber.
        const latest = await tx.one<{ max: number | null }>(
          `SELECT COALESCE(MAX("versionNumber"), 0) AS max FROM mastra_skill_versions WHERE "skillId" = $1`,
          [id],
        );
        const versionNumber = (latest.max ?? 0) + 1;

        await tx.none(
          `INSERT INTO mastra_skill_versions (
             id, "skillId", "versionNumber", name, description, instructions, metadata, "changeMessage", "createdAt"
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            newVersionId,
            id,
            versionNumber,
            merged.frontmatter.name,
            merged.frontmatter.description,
            newBody,
            newVersionMetadata,
            versionMeta?.reason ?? null,
            now,
          ],
        );
        await tx.none(
          `UPDATE mastra_skills SET "activeVersionId" = $1, status = $2, "updatedAt" = $3 WHERE id = $4`,
          [newVersionId, newStatus, now, id],
        );
        await tx.none(
          `UPDATE mastra_self_learning_skill_search
             SET name = $1, description = $2, instructions = $3, trust_tier = $4,
                 status = $5, tags = $6, updated_at = $7
             WHERE skill_id = $8`,
          [
            merged.frontmatter.name,
            merged.frontmatter.description,
            newBody,
            trustTier,
            merged.status, // OUR status semantic — see createSkill comment
            merged.frontmatter.tags ?? [],
            now,
            id,
          ],
        );
        if (newEmbVec) {
          await tx.none(
            `UPDATE mastra_self_learning_skill_search
               SET embedding = $1::vector WHERE skill_id = $2`,
            [toVectorLiteral(newEmbVec), id],
          );
        }
      });
    } catch (err) {
      throw rethrowAsTyped(err, merged.frontmatter.name, merged.agentId ?? null);
    }

    const next = await this.getSkill(id);
    if (!next) throw new Error(`Skill vanished mid-update: ${id}`);
    // Preserve our semver if not overridden — Mastra's versionNumber is separate.
    next.version = updates.version ?? bumpSemver(existing.version, 'patch');
    return next;
  }

  async listSkills(options?: {
    agentId?: string | null;
    trustTiers?: TrustTier[];
    status?: SkillRecord['status'];
    limit?: number;
    offset?: number;
  }): Promise<SkillRecord[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const agentId = options?.agentId === null ? null : options?.agentId;
    const status = options?.status ?? 'active';
    const trustTiers = options?.trustTiers ?? null;

    const where: string[] = [];
    const params: unknown[] = [];

    where.push(`stats_status.status = $${params.length + 1}`);
    params.push(mapStatus(status));

    if (agentId !== undefined) {
      params.push(agentId);
      where.push(
        `(($${params.length}::text IS NULL AND s."authorId" IS NULL) OR s."authorId" = $${params.length})`,
      );
    }

    if (trustTiers && trustTiers.length > 0) {
      params.push(trustTiers);
      where.push(`search.trust_tier = ANY($${params.length}::text[])`);
    }

    params.push(limit);
    params.push(offset);

    const sql = `
      SELECT
        s.id, s.status, s."activeVersionId" AS active_version_id, s."authorId" AS author_id,
        s."createdAt" AS created_at, s."updatedAt" AS updated_at,
        v."versionNumber" AS version_number, v.name, v.description, v.instructions,
        v.metadata AS version_metadata,
        COALESCE(stats.success_count, 0) AS success_count,
        COALESCE(stats.fail_count, 0)    AS fail_count,
        stats.last_used,
        COALESCE(search.trust_tier, 'agent-created') AS trust_tier
      FROM mastra_skills s
      INNER JOIN mastra_skill_versions v ON v.id = s."activeVersionId"
      LEFT JOIN mastra_self_learning_skill_stats stats ON stats.skill_id = s.id
      LEFT JOIN mastra_self_learning_skill_search search ON search.skill_id = s.id
      INNER JOIN mastra_skills stats_status ON stats_status.id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY stats.last_used DESC NULLS LAST, s."createdAt" DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const rows = await this.storage.db.any<SkillRowJoined>(sql, params);
    return rows.map(rowToSkillRecord);
  }

  // -------------------------------------------------------------------------
  // Version history
  // -------------------------------------------------------------------------

  async createVersion(
    input: Omit<SkillVersionRecord, 'id' | 'createdAt'>,
  ): Promise<SkillVersionRecord> {
    const id = ulid();
    const now = new Date();
    const existing = await this.getSkill(input.skillId);
    if (!existing) throw new Error(`createVersion: parent skill not found: ${input.skillId}`);

    await this.storage.db.tx(async (tx) => {
      const latest = await tx.one<{ max: number | null }>(
        `SELECT COALESCE(MAX("versionNumber"), 0) AS max FROM mastra_skill_versions WHERE "skillId" = $1`,
        [input.skillId],
      );
      const versionNumber = (latest.max ?? 0) + 1;
      const metadata = buildVersionMetadata(
        existing.frontmatter,
        existing.trustTier,
        {
          semver: input.version,
          diff: input.diffFromPrevious ?? null,
          reason: input.reason,
        },
      );
      await tx.none(
        `INSERT INTO mastra_skill_versions (
           id, "skillId", "versionNumber", name, description, instructions, metadata, "changeMessage", "createdAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          input.skillId,
          versionNumber,
          existing.frontmatter.name,
          existing.frontmatter.description,
          extractBody(input.content),
          metadata,
          input.reason,
          now,
        ],
      );
    });

    return {
      id,
      skillId: input.skillId,
      version: input.version,
      content: input.content,
      diffFromPrevious: input.diffFromPrevious ?? null,
      reason: input.reason,
      createdAt: now.toISOString(),
    };
  }

  async listVersions(skillId: string): Promise<SkillVersionRecord[]> {
    const rows = await this.storage.db.any<{
      id: string;
      skillId: string;
      version_number: number;
      instructions: string;
      version_metadata: Record<string, unknown> | null;
      change_message: string | null;
      created_at: Date;
    }>(
      `SELECT
         id, "skillId" AS "skillId", "versionNumber" AS version_number,
         instructions, metadata AS version_metadata,
         "changeMessage" AS change_message, "createdAt" AS created_at
       FROM mastra_skill_versions
       WHERE "skillId" = $1
       ORDER BY "versionNumber" DESC`,
      [skillId],
    );
    return rows.map((r) => ({
      id: r.id,
      skillId: r.skillId,
      version:
        (r.version_metadata?.['semver'] as string | undefined) ??
        `0.0.${r.version_number}`,
      content: r.instructions,
      diffFromPrevious: (r.version_metadata?.['diff'] as string | null | undefined) ?? null,
      reason:
        (r.version_metadata?.['reason'] as string | undefined) ??
        r.change_message ??
        '',
      createdAt: r.created_at.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // Usage tracking
  // -------------------------------------------------------------------------

  async recordUsage(
    input: Omit<SkillUsageRecord, 'id' | 'createdAt'>,
  ): Promise<SkillUsageRecord> {
    const id = ulid();
    const now = new Date();

    try {
      await this.storage.db.tx(async (tx) => {
        await tx.none(
          `INSERT INTO mastra_self_learning_skill_usage
             (id, skill_id, thread_id, agent_id, outcome, feedback, duration_ms, tool_calls, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            input.skillId,
            input.threadId,
            input.agentId,
            input.outcome,
            input.feedback ?? null,
            input.durationMs ?? 0,
            input.toolCalls ?? 0,
            now,
          ],
        );

        // Increment counters atomically.
        await tx.none(
          `UPDATE mastra_self_learning_skill_stats SET
             success_count = success_count + CASE WHEN $1 = 'success' THEN 1 ELSE 0 END,
             fail_count    = fail_count    + CASE WHEN $1 = 'failure' THEN 1 ELSE 0 END,
             last_used     = $2
           WHERE skill_id = $3`,
          [input.outcome, now, input.skillId],
        );
      });
    } catch (err) {
      // If the parent skill was deleted mid-task, swallow the FK error.
      // This is a bookkeeping operation and must never crash the agent loop.
      const msg = err instanceof Error ? err.message : String(err);
      if (/foreign key|violates foreign key constraint/i.test(msg)) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] recordUsage: parent skill was deleted; dropping usage row.',
          { skillId: input.skillId },
        );
        return {
          id,
          skillId: input.skillId,
          threadId: input.threadId,
          agentId: input.agentId,
          outcome: input.outcome,
          feedback: input.feedback ?? null,
          durationMs: input.durationMs ?? 0,
          toolCalls: input.toolCalls ?? 0,
          createdAt: now.toISOString(),
        };
      }
      throw err;
    }

    return {
      id,
      skillId: input.skillId,
      threadId: input.threadId,
      agentId: input.agentId,
      outcome: input.outcome,
      feedback: input.feedback ?? null,
      durationMs: input.durationMs ?? 0,
      toolCalls: input.toolCalls ?? 0,
      createdAt: now.toISOString(),
    };
  }

  async getUsageStats(skillId: string): Promise<{
    totalUses: number;
    successRate: number;
    avgDurationMs: number;
    avgToolCalls: number;
  }> {
    const row = await this.storage.db.one<{
      total_uses: number | string;
      success_rate: number | string | null;
      avg_duration_ms: number | string | null;
      avg_tool_calls: number | string | null;
    }>(
      `SELECT
         COUNT(*)::INT AS total_uses,
         AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END)::FLOAT AS success_rate,
         COALESCE(AVG(duration_ms), 0)::FLOAT AS avg_duration_ms,
         COALESCE(AVG(tool_calls), 0)::FLOAT  AS avg_tool_calls
       FROM mastra_self_learning_skill_usage
       WHERE skill_id = $1`,
      [skillId],
    );
    return {
      totalUses: Number(row.total_uses ?? 0),
      successRate: Number(row.success_rate ?? 0),
      avgDurationMs: Number(row.avg_duration_ms ?? 0),
      avgToolCalls: Number(row.avg_tool_calls ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Search (FTS only in MVP)
  // -------------------------------------------------------------------------

  async search(options: SkillSearchOptions): Promise<SkillSearchResult[]> {
    let mode = options.mode ?? 'fts';
    const query = options.query?.trim() ?? '';
    const qvec = options.queryEmbedding;

    // Degrade gracefully: semantic/hybrid without a query vector (no embedder,
    // or pgvector unavailable) fall back to FTS rather than throwing.
    if ((mode === 'semantic' || mode === 'hybrid') && (!qvec || !this.vectorAvailable)) {
      mode = 'fts';
    }
    if (mode === 'fts' && !query) return [];

    // Build params per-mode so no parameter is left unreferenced (Postgres
    // errors with "could not determine data type" on an unused $n).
    const params: unknown[] = [];
    const where: string[] = [`search.status = 'active'`];

    let txtIdx = 0;
    if (mode === 'fts' || mode === 'hybrid') {
      params.push(query);
      txtIdx = params.length; // $txtIdx = query text
    }
    let vecIdx = 0;
    if (qvec && (mode === 'semantic' || mode === 'hybrid')) {
      params.push(toVectorLiteral(qvec));
      vecIdx = params.length; // $vecIdx = query vector literal
    }

    if (options.agentId !== undefined) {
      params.push(options.agentId);
      where.push(
        `(($${params.length}::text IS NULL AND search.agent_id IS NULL) OR search.agent_id = $${params.length})`,
      );
    }
    if (options.trustTiers && options.trustTiers.length > 0) {
      params.push(options.trustTiers);
      where.push(`search.trust_tier = ANY($${params.length}::text[])`);
    }
    if (options.tags && options.tags.length > 0) {
      params.push(options.tags);
      where.push(`search.tags && $${params.length}::text[]`);
    }

    const w = Math.min(1, Math.max(0, options.semanticWeight ?? 0.7));
    let scoreExpr: string;
    let candidate: string;
    let orderBy: string;

    if (mode === 'semantic') {
      // cosine similarity 0..1, nearest first
      scoreExpr = `(1 - (search.embedding <=> $${vecIdx}::vector))`;
      candidate = `search.embedding IS NOT NULL`;
      orderBy = `search.embedding <=> $${vecIdx}::vector ASC, search.skill_id ASC`;
    } else if (mode === 'hybrid') {
      const sem = `COALESCE(1 - (search.embedding <=> $${vecIdx}::vector), 0)`;
      const fts = `COALESCE(ts_rank_cd(search.search_vector, plainto_tsquery('english', $${txtIdx})), 0)`;
      scoreExpr = `(${w} * ${sem} + ${1 - w} * (${fts} / (1 + ${fts})))`;
      candidate = `(search.embedding IS NOT NULL OR search.search_vector @@ plainto_tsquery('english', $${txtIdx}))`;
      orderBy = `score DESC, search.skill_id ASC`;
    } else {
      scoreExpr = `ts_rank_cd(search.search_vector, plainto_tsquery('english', $${txtIdx}))`;
      candidate = `search.search_vector @@ plainto_tsquery('english', $${txtIdx})`;
      orderBy = `score DESC, search.skill_id ASC`;
    }
    where.push(candidate);
    params.push(options.limit ?? 10);

    const sql = `
      SELECT
        s.id, s.status, s."activeVersionId" AS active_version_id, s."authorId" AS author_id,
        s."createdAt" AS created_at, s."updatedAt" AS updated_at,
        v."versionNumber" AS version_number, v.name, v.description, v.instructions,
        v.metadata AS version_metadata,
        COALESCE(stats.success_count, 0) AS success_count,
        COALESCE(stats.fail_count, 0)    AS fail_count,
        stats.last_used,
        search.trust_tier,
        ${scoreExpr} AS score
      FROM mastra_self_learning_skill_search search
      INNER JOIN mastra_skills s ON s.id = search.skill_id
      INNER JOIN mastra_skill_versions v ON v.id = s."activeVersionId"
      LEFT JOIN mastra_self_learning_skill_stats stats ON stats.skill_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length}
    `;

    const rows = await this.storage.db.any<SkillRowJoined & { score: number | string }>(
      sql,
      params,
    );
    const matchType = mode as 'fts' | 'semantic' | 'hybrid';
    return rows.map((row) => ({
      skill: rowToSkillRecord(row),
      score: Number(row.score ?? 0),
      matchType,
    }));
  }
}

// =============================================================================
// Helpers
// =============================================================================

function mapStatus(
  status: SkillRecord['status'] | undefined,
): 'draft' | 'published' | 'archived' {
  // Map our 4-state model onto Mastra's 3-state.
  switch (status) {
    case 'active':
      return 'published';
    case 'draft':
      return 'draft';
    case 'deprecated':
    case 'archived':
      return 'archived';
    default:
      return 'published';
  }
}

function unmapStatus(
  status: 'draft' | 'published' | 'archived',
): SkillRecord['status'] {
  switch (status) {
    case 'published':
      return 'active';
    case 'draft':
      return 'draft';
    case 'archived':
      return 'archived';
  }
}

function extractBody(content: string): string {
  // If the content is a full SKILL.md with frontmatter, strip the frontmatter and
  // return just the body. Otherwise return as-is.
  try {
    const { body } = parseSkillDocument(content);
    return body;
  } catch {
    return content;
  }
}

function rebuildContentFromRow(row: SkillRowJoined): string {
  const metadata = (row.version_metadata ?? {}) as Record<string, unknown>;
  const frontmatter: SkillFrontmatter = {
    name: row.name,
    description: row.description,
    version: typeof metadata['semver'] === 'string' ? (metadata['semver'] as string) : undefined,
    trust: (typeof metadata['trust'] === 'string'
      ? (metadata['trust'] as string)
      : row.trust_tier) as TrustTier,
    tags: Array.isArray(metadata['tags']) ? (metadata['tags'] as string[]) : undefined,
    platforms: Array.isArray(metadata['platforms']) ? (metadata['platforms'] as string[]) : undefined,
    complexity:
      typeof metadata['complexity'] === 'number'
        ? (metadata['complexity'] as number)
        : undefined,
    author: typeof metadata['author'] === 'string' ? (metadata['author'] as string) : undefined,
    metadata:
      metadata['mastra'] || metadata['custom']
        ? {
            mastra: (metadata['mastra'] as Record<string, unknown> | undefined) ?? undefined,
            ...((metadata['custom'] as Record<string, unknown> | undefined) ?? {}),
          }
        : undefined,
    created: row.created_at.toISOString(),
    updated: row.updated_at.toISOString(),
  };
  return serializeSkillDocument(frontmatter, row.instructions);
}

function rowToSkillRecord(row: SkillRowJoined): SkillRecord {
  const metadata = (row.version_metadata ?? {}) as Record<string, unknown>;
  const frontmatter: SkillFrontmatter = {
    name: row.name,
    description: row.description,
    version: typeof metadata['semver'] === 'string' ? (metadata['semver'] as string) : undefined,
    trust: row.trust_tier,
    tags: Array.isArray(metadata['tags']) ? (metadata['tags'] as string[]) : undefined,
    platforms: Array.isArray(metadata['platforms']) ? (metadata['platforms'] as string[]) : undefined,
    complexity:
      typeof metadata['complexity'] === 'number'
        ? (metadata['complexity'] as number)
        : undefined,
    author: typeof metadata['author'] === 'string' ? (metadata['author'] as string) : undefined,
    metadata: metadata['mastra']
      ? { mastra: metadata['mastra'] as Record<string, unknown> }
      : undefined,
    created: row.created_at.toISOString(),
    updated: row.updated_at.toISOString(),
  };

  return {
    id: row.id,
    name: row.name,
    version: typeof metadata['semver'] === 'string' ? (metadata['semver'] as string) : '1.0.0',
    content: rebuildContentFromRow(row),
    frontmatter,
    agentId: row.author_id,
    trustTier: row.trust_tier,
    status: unmapStatus(row.status),
    successCount: row.success_count,
    failCount: row.fail_count,
    lastUsed: row.last_used ? row.last_used.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function buildSkillSelectSQL(whereExtra: string): string {
  return `
    SELECT
      s.id, s.status, s."activeVersionId" AS active_version_id, s."authorId" AS author_id,
      s."createdAt" AS created_at, s."updatedAt" AS updated_at,
      v."versionNumber" AS version_number, v.name, v.description, v.instructions,
      v.metadata AS version_metadata,
      COALESCE(stats.success_count, 0) AS success_count,
      COALESCE(stats.fail_count, 0)    AS fail_count,
      stats.last_used,
      COALESCE(search.trust_tier, 'agent-created') AS trust_tier
    FROM mastra_skills s
    INNER JOIN mastra_skill_versions v ON v.id = s."activeVersionId"
    LEFT JOIN mastra_self_learning_skill_stats stats ON stats.skill_id = s.id
    LEFT JOIN mastra_self_learning_skill_search search ON search.skill_id = s.id
    WHERE ${whereExtra}
    LIMIT 1
  `;
}

function buildVersionMetadata(
  frontmatter: SkillFrontmatter,
  trustTier: TrustTier,
  extras?: { semver?: string; diff?: string | null; reason?: string },
): Record<string, unknown> {
  return {
    semver: extras?.semver ?? frontmatter.version ?? '1.0.0',
    trust: trustTier,
    tags: frontmatter.tags ?? [],
    platforms: frontmatter.platforms ?? [],
    complexity: frontmatter.complexity,
    author: frontmatter.author,
    mastra: frontmatter.metadata?.mastra,
    ...(extras?.diff !== undefined ? { diff: extras.diff } : {}),
    ...(extras?.reason ? { reason: extras.reason } : {}),
  };
}

function bumpSemver(version: string, bump: 'patch' | 'minor' | 'major'): string {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  while (parts.length < 3) parts.push(0);
  let [maj, min, pat] = parts as [number, number, number];
  if (Number.isNaN(maj)) maj = 1;
  if (Number.isNaN(min)) min = 0;
  if (Number.isNaN(pat)) pat = 0;
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function rethrowAsTyped(err: unknown, name: string, agentId: string | null): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /duplicate key|unique constraint|UNIQUE constraint|23505/i.test(msg) &&
    /name|skill_search/i.test(msg)
  ) {
    return new SkillNameConflictError(name, agentId);
  }
  return err instanceof Error ? err : new Error(msg);
}
