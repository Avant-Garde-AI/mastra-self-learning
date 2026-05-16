import { PostgresStore } from '@mastra/pg';
import {
  SkillStorageExtension,
  FactLayer,
  FactLayerConfigSchema,
  type MastraPostgresLike,
} from '@avant-garde/mastra-self-learning';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5544/mastra_harness';

export const AGENT_ID = process.env.HARNESS_AGENT_ID ?? 'harness-agent';

export const store = new PostgresStore({
  id: 'harness-store',
  connectionString: DATABASE_URL,
});

export const skillStorage = new SkillStorageExtension(
  store as unknown as MastraPostgresLike,
);

export const factLayer = new FactLayer(
  skillStorage,
  FactLayerConfigSchema.parse({}),
  AGENT_ID,
);

let ready: Promise<void> | null = null;

/** Idempotent, memoized schema bootstrap. Safe to call from every route. */
export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = skillStorage.ensureSchema().catch((err) => {
      // Reset so a later call can retry (e.g. Postgres not up yet).
      ready = null;
      throw err;
    });
  }
  return ready;
}
