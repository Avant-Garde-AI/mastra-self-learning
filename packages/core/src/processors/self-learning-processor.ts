import { ExtractionPolicySchema, type ExtractionPolicy } from '../config.js';
import {
  SkillExtractor,
  type TaskTrajectory,
} from '../skills/extractor.js';
import {
  SkillStorageExtension,
  type MastraPostgresLike,
} from '../skills/storage-extension.js';
import { SkillSearch } from '../skills/search.js';
import { SkillRefiner, signalsActive } from '../skills/refiner.js';
import {
  type AuxiliaryGenerate,
} from '../skills/auxiliary-llm.js';
import {
  observeChunk,
  readState,
  buildTrajectory,
  buildRefinementSignals,
  type SelfLearningState,
} from './chunk-observer.js';

/**
 * Options for the self-learning output processor.
 *
 * Implementation note: this factory accepts either an `agentId` (best-effort
 * default) or pulls it from `processOutputResult.args.requestContext` at call
 * time when available. The factory-time value is the fallback.
 */
export interface SelfLearningProcessorOptions {
  /** Mastra storage instance (a `PostgresStore`) or an already-constructed extension. */
  storage: MastraPostgresLike | SkillStorageExtension;
  /**
   * Required when `extraction.useGeneralizabilityCheck` is true (the default)
   * or when extraction would otherwise fire. The function is called for the
   * generalizability gate, synthesis, and Phase-5 refinement.
   *
   * See {@link AuxiliaryGenerate} JSDoc for adapter examples.
   */
  generate?: AuxiliaryGenerate;
  /** Extraction policy overrides. Defaults applied by `ExtractionPolicySchema.parse`. */
  extraction?: Partial<ExtractionPolicy>;
  /**
   * Minimum gap (ms) between refinements of the *same* skill. Prevents
   * version-history churn when a skill fails repeatedly in quick succession.
   * Defaults to 60 000 ms. Set to 0 to disable (useful in tests).
   */
  refinementCooldownMs?: number;
  /** Owning agent ID. Used as the storage scope for extracted skills. */
  agentId?: string | null;
  /**
   * Test-only: maximum time (ms) to wait for pending extractions during
   * `_waitForPendingExtractions()`. Default 30 s.
   */
  pendingTimeoutMs?: number;
}

/**
 * The Processor instance we return. Conforms to Mastra's `Processor<id>`
 * shape but also carries a `_waitForPendingExtractions` helper for tests.
 */
export interface SelfLearningProcessor {
  readonly id: 'self-learning';
  readonly name: 'self-learning';
  readonly description: string;
  processOutputStream(args: ProcessOutputStreamArgsLike): unknown;
  processOutputResult(args: ProcessOutputResultArgsLike): Promise<unknown>;
  /**
   * Test-only helper: resolves when all fire-and-forget extraction *and
   * refinement* promises triggered by recent `processOutputResult` calls have
   * settled.
   */
  _waitForPendingExtractions(): Promise<void>;
  /** Direct access for tests / advanced (backfill) callers. */
  readonly extractor: SkillExtractor;
  readonly refiner: SkillRefiner;
}

/**
 * Structural subset of Mastra's `ProcessOutputStreamArgs` we depend on.
 * Defined structurally to avoid a hard import-time dep on a specific Mastra
 * processor type that may evolve. See `MASTRA_API_NOTES.md`.
 */
export interface ProcessOutputStreamArgsLike {
  part: unknown;
  state: Record<string, unknown>;
}

export interface ProcessOutputResultArgsLike {
  /** Per-processor state (same `state` bag as `processOutputStream`). */
  state: Record<string, unknown>;
  /** `OutputResult` from Mastra: `text`, `usage`, `finishReason`, `steps[]`. */
  result?: {
    text?: string;
    finishReason?: string;
    steps?: Array<{
      text?: string;
      toolCalls?: Array<{ toolName?: string; toolCallId?: string; args?: unknown; input?: unknown }>;
      toolResults?: Array<{ toolCallId?: string; result?: unknown; output?: unknown }>;
    }>;
  };
  /** Final list of messages produced this request. */
  messages?: Array<{ role?: string; content?: unknown }>;
  /** `RequestContext` if Mastra wired one through; we treat it as a Map. */
  requestContext?: { get?: (key: string) => unknown };
  /** Tracing context (unused in MVP; future OTel work). */
  tracingContext?: unknown;
}

/**
 * Create a Mastra output processor that implements the closed learning loop.
 *
 * After a turn finishes:
 *   1. Build a `TaskTrajectory` from `result.steps[]` (preferred) or the
 *      streaming `state` accumulated by `processOutputStream`.
 *   2. Fire-and-forget extraction via `SkillExtractor.evaluate(trajectory)`.
 *   3. Never throw or delay the user-visible response.
 *
 * @example
 * ```ts
 * const processor = createSelfLearningProcessor({
 *   storage,
 *   generate: myAuxLLM,
 *   extraction: { minToolCalls: 5 },
 * });
 *
 * const agent = new Agent({
 *   model: '...',
 *   outputProcessors: [processor],
 * });
 * ```
 *
 * @see docs/mvp/03-phase-learning-loop.md
 */
export function createSelfLearningProcessor(
  options: SelfLearningProcessorOptions,
): SelfLearningProcessor {
  const storage =
    options.storage instanceof SkillStorageExtension
      ? options.storage
      : new SkillStorageExtension(options.storage);
  const search = new SkillSearch(storage);
  const policy = ExtractionPolicySchema.parse(options.extraction ?? {});
  const extractor = new SkillExtractor(storage, search, policy, options.generate);
  const refiner = new SkillRefiner(
    storage,
    options.generate,
    options.refinementCooldownMs,
  );
  const pending = new Set<Promise<unknown>>();
  const pendingTimeoutMs = options.pendingTimeoutMs ?? 30_000;

  function trackPending<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  }

  return {
    id: 'self-learning' as const,
    name: 'self-learning' as const,
    description:
      'Observes the agent loop, accumulates a task trajectory, and asynchronously extracts reusable skills when the trajectory meets the extraction policy thresholds.',

    extractor,
    refiner,

    processOutputStream(args) {
      try {
        observeChunk(args.part, args.state);
      } catch (err) {
        // Observer must never break the stream.
        // eslint-disable-next-line no-console
        console.warn(
          '[mastra-self-learning] chunk observer threw; dropping observation.',
          err instanceof Error ? err.message : err,
        );
      }
      // Pass the chunk through unmodified.
      return args.part;
    },

    async processOutputResult(args) {
      try {
        const trajectory = buildTrajectoryFromArgs(args, options.agentId ?? null);

        // Fire-and-forget. Never propagate errors to the user-visible response.
        const work = runExtraction(extractor, trajectory).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[mastra-self-learning] extraction error:', err);
        });
        trackPending(work);

        // Refinement arm: if the agent used a skill and the trajectory shows a
        // failure or user-correction signal, refine that skill. Independent
        // fire-and-forget from extraction.
        const slState = readState(args.state);
        if (slState.skillUsed?.name) {
          const finalUser = extractFinalUserMessage(args);
          const signals = buildRefinementSignals(slState, finalUser);
          if (signalsActive(signals)) {
            const refineWork = runRefinement(
              refiner,
              storage,
              slState.skillUsed.name,
              trajectory,
              signals,
              finalUser,
            ).catch((err) => {
              // eslint-disable-next-line no-console
              console.error('[mastra-self-learning] refinement error:', err);
            });
            trackPending(refineWork);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          '[mastra-self-learning] processOutputResult threw before extraction; ignoring.',
          err,
        );
      }
      return args.messages ?? [];
    },

    async _waitForPendingExtractions() {
      if (pending.size === 0) return;
      const snapshot = Array.from(pending);
      await Promise.race([
        Promise.allSettled(snapshot),
        new Promise<void>((resolve) => setTimeout(resolve, pendingTimeoutMs)),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runExtraction(
  extractor: SkillExtractor,
  trajectory: TaskTrajectory,
): Promise<void> {
  const result = await extractor.evaluate(trajectory);
  if (result.triggered) {
    // eslint-disable-next-line no-console
    console.info(
      `[mastra-self-learning] extracted skill "${result.skill?.name ?? '(unknown)'}" — ${result.reason}`,
    );
  } else {
    // Quieter at info, since negative results are normal.
    // eslint-disable-next-line no-console
    console.debug?.(`[mastra-self-learning] extraction skipped — ${result.reason}`);
  }
}

async function runRefinement(
  refiner: SkillRefiner,
  storage: SkillStorageExtension,
  skillName: string,
  trajectory: TaskTrajectory,
  signals: import('../skills/types.js').RefinementSignals,
  finalUserMessage?: string,
): Promise<void> {
  const skill = await storage.getSkillByName(
    skillName,
    trajectory.agentId === 'unknown' ? undefined : trajectory.agentId,
  );
  if (!skill) {
    // Skill was deleted between use and processor result — no-op.
    return;
  }
  const decision = await refiner.evaluate(skill, trajectory, signals);
  if (!decision.shouldRefine) {
    // eslint-disable-next-line no-console
    console.debug?.(
      `[mastra-self-learning] refinement skipped for "${skillName}" — ${decision.reason}`,
    );
    return;
  }
  const updated = await refiner.refine(skill, trajectory, signals, finalUserMessage);
  // eslint-disable-next-line no-console
  console.info(
    `[mastra-self-learning] refined skill "${updated.name}" → v${updated.version} (${decision.reason})`,
  );
}

function extractFinalUserMessage(
  args: ProcessOutputResultArgsLike,
): string | undefined {
  const m = args.messages
    ?.slice()
    .reverse()
    .find((x) => x.role === 'user')?.content;
  return typeof m === 'string' ? m : undefined;
}

function buildTrajectoryFromArgs(
  args: ProcessOutputResultArgsLike,
  fallbackAgentId: string | null,
): TaskTrajectory {
  const slState = readState(args.state);

  // Prefer pre-aggregated steps from the result object — much cleaner than
  // chunk-level accumulation. Fall back to streaming state if no result.steps.
  const steps = args.result?.steps ?? [];
  let toolCalls = slState.toolCalls;
  if (steps.length > 0) {
    toolCalls = [];
    for (const step of steps) {
      const calls = step.toolCalls ?? [];
      const results = new Map<string, unknown>();
      for (const r of step.toolResults ?? []) {
        if (r.toolCallId) results.set(r.toolCallId, r.result ?? r.output);
      }
      for (const c of calls) {
        const name = c.toolName ?? '(unknown)';
        const input = (c.args ?? c.input ?? {}) as Record<string, unknown>;
        const callId = c.toolCallId;
        toolCalls.push({
          name,
          input,
          output: callId ? results.get(callId) : undefined,
          callId,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  const finalUser =
    args.messages?.slice().reverse().find((m) => m.role === 'user')?.content;
  const finalAssistant =
    args.result?.text ??
    args.messages?.slice().reverse().find((m) => m.role === 'assistant')?.content;

  const threadId = readContextString(args.requestContext, 'threadId') ?? 'unknown';
  const agentId =
    readContextString(args.requestContext, 'agentId') ?? fallbackAgentId ?? 'unknown';

  return buildTrajectory({
    state: {
      ...slState,
      // Prefer the unified `toolCalls` we just computed.
      toolCalls,
      // If `finish` chunks didn't fire, derive turnCount from step count.
      turnCount: slState.turnCount > 0 ? slState.turnCount : steps.length,
    },
    threadId,
    agentId,
    finalUserMessage: typeof finalUser === 'string' ? finalUser : undefined,
    finalAssistantMessage: typeof finalAssistant === 'string' ? finalAssistant : undefined,
  });
}

function readContextString(
  ctx: ProcessOutputResultArgsLike['requestContext'],
  key: string,
): string | undefined {
  if (!ctx?.get) return undefined;
  const val = ctx.get(key);
  return typeof val === 'string' ? val : undefined;
}
