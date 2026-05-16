import type { TaskTrajectory } from '../skills/extractor.js';

/**
 * Per-request state shape we maintain on the Mastra `state` bag during
 * `processOutputStream`. This is the union of every signal the learning loop
 * needs to evaluate.
 *
 * The shape is exported so refinement work (Phase 5) and tests can build it
 * directly without going through the streaming path.
 */
export interface SelfLearningState {
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    output?: unknown;
    callId?: string;
    timestamp: string;
  }>;
  turnCount: number;
  /** The most recent skill the agent loaded via `skill_view`, if any. */
  skillUsed: { name: string; section?: string } | null;
  /** `task_write` / `task_check` tool calls (Harness-style task tracking). */
  taskTrackingSignals: Array<{ tool: 'task_write' | 'task_check'; data: unknown }>;
  /** `skill_feedback` tool calls observed during this request. */
  skillFeedbackCalls: Array<{
    name: string;
    outcome: 'success' | 'failure' | 'partial' | 'abandoned';
    feedback?: string;
  }>;
  /** Whether an explicit task-completion chunk was observed. */
  taskCompleteObserved: boolean;
  startedAt: number;
}

/**
 * Mutate the per-request `state` bag based on the incoming chunk.
 *
 * Tolerant of partial chunks: every field is initialized on demand so the
 * first chunk seen (whatever its type) creates the full shape. We never
 * await — this is on the hot path for the user-visible stream.
 */
export function observeChunk(part: unknown, stateBag: Record<string, unknown>): void {
  const state = ensureState(stateBag);
  if (!part || typeof part !== 'object') return;
  const p = part as { type?: unknown; payload?: unknown };
  if (typeof p.type !== 'string') return;

  // Mastra wraps every chunk's data under `payload`.
  const payload = (p.payload as Record<string, unknown> | undefined) ?? {};

  switch (p.type) {
    case 'tool-call': {
      const toolName = stringField(payload.toolName);
      if (!toolName) return;
      const input = (payload.args as Record<string, unknown> | undefined) ?? {};
      const callId = stringField(payload.toolCallId);
      state.toolCalls.push({
        name: toolName,
        input,
        callId,
        timestamp: new Date().toISOString(),
      });
      // Side signals
      if (toolName === 'skill_view') {
        state.skillUsed = {
          name: stringField((input as Record<string, unknown>).name) ?? '',
          section: stringField((input as Record<string, unknown>).section),
        };
      } else if (toolName === 'task_write' || toolName === 'task_check') {
        state.taskTrackingSignals.push({ tool: toolName, data: input });
      } else if (toolName === 'skill_feedback') {
        const outcome = stringField((input as Record<string, unknown>).outcome);
        if (
          outcome === 'success' ||
          outcome === 'failure' ||
          outcome === 'partial' ||
          outcome === 'abandoned'
        ) {
          state.skillFeedbackCalls.push({
            name: stringField((input as Record<string, unknown>).name) ?? '',
            outcome,
            feedback: stringField((input as Record<string, unknown>).feedback),
          });
        }
      }
      return;
    }

    case 'tool-result': {
      const callId = stringField(payload.toolCallId);
      if (!callId) return;
      const call = state.toolCalls.find((c) => c.callId === callId);
      if (call) call.output = payload.result ?? (payload as { output?: unknown }).output;
      return;
    }

    case 'step-finish':
    case 'finish': {
      state.turnCount += 1;
      return;
    }

    case 'is-task-complete': {
      state.taskCompleteObserved = true;
      return;
    }

    default:
      return;
  }
}

/** Initialize the state bag in place if it hasn't been initialized yet. */
function ensureState(stateBag: Record<string, unknown>): SelfLearningState {
  if (!stateBag.__sl) {
    const initial: SelfLearningState = {
      toolCalls: [],
      turnCount: 0,
      skillUsed: null,
      taskTrackingSignals: [],
      skillFeedbackCalls: [],
      taskCompleteObserved: false,
      startedAt: Date.now(),
    };
    stateBag.__sl = initial;
  }
  return stateBag.__sl as SelfLearningState;
}

/** Read-only accessor. Returns a fresh default state if none has been written. */
export function readState(stateBag: Record<string, unknown>): SelfLearningState {
  return (stateBag.__sl as SelfLearningState | undefined) ?? {
    toolCalls: [],
    turnCount: 0,
    skillUsed: null,
    taskTrackingSignals: [],
    skillFeedbackCalls: [],
    taskCompleteObserved: false,
    startedAt: Date.now(),
  };
}

/**
 * Heuristic positive-outcome detector. Uses three signals, any of which can
 * fire (OR semantics):
 *   1. Task-tracking: every `task_write` has a matching `task_check` with
 *      `status: 'complete'`.
 *   2. Mastra emitted an `is-task-complete` chunk.
 *   3. The final user message uses affirmation language.
 *
 * Errors fall back to `false` (over-block; safer than over-extract).
 */
export function detectPositiveOutcome(
  state: SelfLearningState,
  finalUserMessage?: string,
  finalAssistantMessage?: string,
): boolean {
  // 1. Task tracking
  const writes = state.taskTrackingSignals.filter((s) => s.tool === 'task_write');
  const checks = state.taskTrackingSignals.filter((s) => s.tool === 'task_check');
  if (writes.length > 0 && checks.length > 0) {
    const completeCount = checks.filter((c) => {
      const d = c.data as { status?: unknown } | undefined;
      return d?.status === 'complete';
    }).length;
    if (completeCount === writes.length) return true;
  }

  // 2. Explicit Mastra signal
  if (state.taskCompleteObserved) return true;

  // 3. User affirmation regex
  if (
    finalUserMessage &&
    /^\s*(thanks|thank you|perfect|great|awesome|nice|works|that worked|excellent|amazing|exactly|got it)\b/i.test(
      finalUserMessage,
    )
  ) {
    return true;
  }

  // 4. Absence of error language in the last assistant message
  if (
    finalAssistantMessage &&
    /\b(failed|error|couldn'?t|wasn'?t able|unable to|sorry,? I couldn'?t)\b/i.test(
      finalAssistantMessage,
    )
  ) {
    return false;
  }

  return false;
}

/**
 * Build a TaskTrajectory from observer state + identifying metadata. Used by
 * both the live processor and any test that wants to drive the extractor
 * without going through the streaming layer.
 */
export function buildTrajectory(args: {
  state: SelfLearningState;
  threadId: string;
  agentId: string;
  finalUserMessage?: string;
  finalAssistantMessage?: string;
  conversationSummary?: string;
}): TaskTrajectory {
  return {
    toolCalls: args.state.toolCalls.map((c) => ({
      name: c.name,
      input: c.input,
      output: c.output,
      timestamp: c.timestamp,
    })),
    turnCount: args.state.turnCount,
    positiveOutcome: detectPositiveOutcome(
      args.state,
      args.finalUserMessage,
      args.finalAssistantMessage,
    ),
    threadId: args.threadId,
    agentId: args.agentId,
    conversationSummary: args.conversationSummary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
