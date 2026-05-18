import { PostgresStore } from '@mastra/pg';
import {
  SkillStorageExtension,
  FactLayer,
  FactLayerConfigSchema,
  openAIEmbedder,
  hashEmbedder,
  type EmbedText,
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

// OpenAI embedder when a key is set; otherwise a deterministic local
// embedder so semantic search / dedup work keyless in the harness + UAT.
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
export const usingRealEmbedder = OPENAI_KEY.length > 0;
export const embedder: EmbedText = usingRealEmbedder
  ? openAIEmbedder({ apiKey: OPENAI_KEY, model: 'text-embedding-3-small', dimensions: 1536 })
  : hashEmbedder(1536);

export const skillStorage = new SkillStorageExtension(
  store as unknown as MastraPostgresLike,
  { embed: embedder, embeddingDimensions: 1536 },
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
