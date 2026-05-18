import {
  SkillRouterConfigSchema,
  FactLayerConfigSchema,
  IdentityLayerConfigSchema,
  IdentitySchema,
  type SkillRouterConfig,
  type FactLayerConfig,
  type Identity,
} from '../config.js';
import {
  SkillStorageExtension,
  type MastraPostgresLike,
} from '../skills/storage-extension.js';
import { SkillRouter } from '../skills/router.js';
import type { EmbedText } from '../skills/embedding.js';
import { FactLayer } from '../memory/fact-layer.js';
import { IdentityLayer } from '../memory/identity.js';

/**
 * Options for the skill-context input processor.
 */
export interface SkillContextProcessorOptions {
  /** Mastra storage instance or an already-constructed extension. */
  storage: MastraPostgresLike | SkillStorageExtension;
  /** Identity definition (personality, expertise, formatting, guardrails). */
  identity?: Identity;
  /** Fact layer config + enable flag. */
  factLayer?: Partial<FactLayerConfig>;
  /** Skill router config (token budgets, overflow strategy). */
  skillRouter?: Partial<SkillRouterConfig>;
  /** Owning agent ID — scopes skills + facts. */
  agentId?: string | null;
  /**
   * Optional embedder. Enables the `relevant` overflow strategy to rank the
   * L0 index by similarity to the current conversation (v0.2.0). Ignored when
   * `storage` is an already-constructed extension (carries its own).
   */
  embed?: EmbedText;
}

/**
 * Structural subset of Mastra's `ProcessInputArgs` we depend on. Defined
 * structurally to avoid a hard import-time dependency on a Mastra type that
 * may evolve. See `MASTRA_API_NOTES.md`.
 */
export interface ProcessInputArgsLike {
  messages: unknown[];
  /** All system messages (agent instructions, user-provided, memory). */
  systemMessages?: Array<{ role: string; content: string }>;
  /** Per-processor state bag, persisted across method calls this request. */
  state?: Record<string, unknown>;
  requestContext?: { get?: (key: string) => unknown };
}

export interface SkillContextProcessor {
  readonly id: 'skill-context';
  readonly name: 'skill-context';
  readonly description: string;
  processInput(
    args: ProcessInputArgsLike,
  ): Promise<{ messages: unknown[]; systemMessages: Array<{ role: string; content: string }> }>;
}

/**
 * Create a Mastra input processor that injects self-learning context into the
 * system prompt before the LLM sees the messages.
 *
 * Assembly order (most-stable → least-stable, for prompt-cache efficiency):
 *   1. Identity (rarely changes)
 *   2. Facts (changes occasionally)
 *   3. Skill Index L0 (changes on skill CRUD)
 *
 * The block is appended to `systemMessages` as a single new system message.
 * Mastra keeps developer instructions first, so the cacheable prefix
 * (instructions) is preserved and our block follows.
 *
 * A nudge message is appended every `nudgeInterval` turns to remind the agent
 * to persist newly-learned facts via `memory_persist`.
 *
 * @see docs/mvp/04-phase-context-injection.md
 */
export function createSkillContextProcessor(
  options: SkillContextProcessorOptions,
): SkillContextProcessor {
  const storage =
    options.storage instanceof SkillStorageExtension
      ? options.storage
      : new SkillStorageExtension(options.storage, { embed: options.embed });

  const routerConfig = SkillRouterConfigSchema.parse(options.skillRouter ?? {});
  const factConfig = FactLayerConfigSchema.parse(options.factLayer ?? {});
  const identityConfig = IdentityLayerConfigSchema.parse({});

  const router = new SkillRouter(
    storage,
    routerConfig,
    options.agentId,
    undefined,
    undefined,
    options.embed,
  );
  const factLayer = new FactLayer(storage, factConfig, options.agentId ?? null);
  const identityLayer = new IdentityLayer(
    storage,
    identityConfig,
    options.identity ?? IdentitySchema.parse({ personality: '' }),
  );

  const factsEnabled = options.factLayer?.enabled !== false;
  const nudgeInterval = factConfig.nudgeInterval;

  return {
    id: 'skill-context' as const,
    name: 'skill-context' as const,
    description:
      'Injects layered self-learning context (identity, persistent facts, L0 skill index) into the system prompt and periodically nudges the agent to persist new facts.',

    async processInput(args) {
      const messages = args.messages ?? [];
      const existingSystem = args.systemMessages ?? [];

      // --- Per-instance turn counter for the nudge mechanism ---
      const state = (args.state ?? {}) as Record<string, unknown>;
      const slKey = '__sl_ctx';
      const ctxState =
        (state[slKey] as { turnCount?: number } | undefined) ?? { turnCount: 0 };
      ctxState.turnCount = (ctxState.turnCount ?? 0) + 1;
      state[slKey] = ctxState;

      // --- Build the three blocks ---
      const identityBlock = options.identity
        ? identityLayer.buildIdentityBlock(options.identity)
        : '';

      let factsBlock = '';
      if (factsEnabled) {
        try {
          factsBlock = await factLayer.buildFactsBlock();
        } catch (err) {
          // Never break the request because facts couldn't be read.
          // eslint-disable-next-line no-console
          console.warn(
            '[mastra-self-learning] buildFactsBlock failed; omitting facts.',
            err instanceof Error ? err.message : err,
          );
          factsBlock = '';
        }
      }

      // Recent conversation text drives the `relevant` overflow strategy.
      const contextText = extractRecentUserText(messages);

      let skillIndex = '';
      try {
        skillIndex = await router.buildIndex(contextText);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] buildIndex failed; omitting skill index.',
          err instanceof Error ? err.message : err,
        );
        skillIndex = '';
      }

      const blocks = [identityBlock, factsBlock, skillIndex].filter(
        (b) => b && b.trim().length > 0,
      );

      const nextSystem = [...existingSystem];

      if (blocks.length > 0) {
        nextSystem.push({
          role: 'system',
          content: blocks.join('\n\n---\n\n'),
        });
      }

      // --- Nudge ---
      if (
        factsEnabled &&
        nudgeInterval > 0 &&
        ctxState.turnCount % nudgeInterval === 0
      ) {
        nextSystem.push({
          role: 'system',
          content:
            '[Self-Learning Note: If the user has shared any new facts about their ' +
            'environment, preferences, or projects, consider persisting them via the ' +
            'memory_persist tool.]',
        });
      }

      return { messages, systemMessages: nextSystem };
    },
  };
}

/** Pull the most recent user message text for the `relevant` overflow ranker. */
function extractRecentUserText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const text = c
        .map((p) =>
          p && typeof p === 'object' && 'text' in p
            ? String((p as { text?: unknown }).text ?? '')
            : '',
        )
        .join(' ')
        .trim();
      if (text) return text;
    }
  }
  return undefined;
}
