import { describe, expect, it } from 'vitest';
import {
  observeChunk,
  readState,
  detectPositiveOutcome,
  buildTrajectory,
} from './chunk-observer.js';

const mkToolCall = (toolName: string, args: Record<string, unknown>, toolCallId = 'tc-1') => ({
  type: 'tool-call',
  payload: { toolName, args, toolCallId },
});

describe('observeChunk', () => {
  it('initializes state on first call', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('search', { q: 'x' }), state);
    const sl = readState(state);
    expect(sl.toolCalls).toHaveLength(1);
    expect(sl.toolCalls[0].name).toBe('search');
    expect(sl.toolCalls[0].callId).toBe('tc-1');
  });

  it('records tool-result and matches by callId', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('search', { q: 'x' }, 'tc-A'), state);
    observeChunk(
      { type: 'tool-result', payload: { toolCallId: 'tc-A', result: { hits: 3 } } },
      state,
    );
    const sl = readState(state);
    expect(sl.toolCalls[0].output).toEqual({ hits: 3 });
  });

  it('sets skillUsed when skill_view fires', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('skill_view', { name: 'gcp-deploy', section: 'Pitfalls' }), state);
    expect(readState(state).skillUsed).toEqual({ name: 'gcp-deploy', section: 'Pitfalls' });
  });

  it('records task_write / task_check signals', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('task_write', { task: 'deploy' }), state);
    observeChunk(mkToolCall('task_check', { task: 'deploy', status: 'complete' }, 'tc-2'), state);
    const sl = readState(state);
    expect(sl.taskTrackingSignals).toHaveLength(2);
    expect(sl.taskTrackingSignals[1].tool).toBe('task_check');
  });

  it('records skill_feedback calls and outcome', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('skill_feedback', { name: 'x', outcome: 'success' }), state);
    expect(readState(state).skillFeedbackCalls).toEqual([
      { name: 'x', outcome: 'success', feedback: undefined },
    ]);
  });

  it('ignores skill_feedback with invalid outcome value', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('skill_feedback', { name: 'x', outcome: 'garbage' }), state);
    expect(readState(state).skillFeedbackCalls).toHaveLength(0);
  });

  it('increments turnCount on step-finish / finish chunks', () => {
    const state: Record<string, unknown> = {};
    observeChunk({ type: 'step-finish', payload: {} }, state);
    observeChunk({ type: 'step-finish', payload: {} }, state);
    observeChunk({ type: 'finish', payload: {} }, state);
    expect(readState(state).turnCount).toBe(3);
  });

  it('records is-task-complete signal', () => {
    const state: Record<string, unknown> = {};
    observeChunk({ type: 'is-task-complete', payload: {} }, state);
    expect(readState(state).taskCompleteObserved).toBe(true);
  });

  it('ignores unknown chunk types silently', () => {
    const state: Record<string, unknown> = {};
    observeChunk({ type: 'text-delta', payload: { delta: 'hi' } }, state);
    observeChunk({ type: 'reasoning-start', payload: {} }, state);
    expect(readState(state).toolCalls).toHaveLength(0);
  });

  it('tolerates malformed chunks (null, non-object, missing type) without recording entries', () => {
    const state: Record<string, unknown> = {};
    observeChunk(null, state);
    observeChunk(undefined, state);
    observeChunk({ payload: { x: 1 } }, state);
    observeChunk({ type: 42, payload: {} }, state);
    // State may be lazily initialized but no records should land in any bucket.
    const sl = readState(state);
    expect(sl.toolCalls).toHaveLength(0);
    expect(sl.taskTrackingSignals).toHaveLength(0);
    expect(sl.skillFeedbackCalls).toHaveLength(0);
    expect(sl.turnCount).toBe(0);
  });
});

describe('detectPositiveOutcome', () => {
  it('returns true when all task_write tasks have task_check status=complete', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('task_write', { task: 't1' }, 'a'), state);
    observeChunk(mkToolCall('task_write', { task: 't2' }, 'b'), state);
    observeChunk(mkToolCall('task_check', { task: 't1', status: 'complete' }, 'c'), state);
    observeChunk(mkToolCall('task_check', { task: 't2', status: 'complete' }, 'd'), state);
    expect(detectPositiveOutcome(readState(state))).toBe(true);
  });

  it('returns false when some tasks are not complete', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('task_write', { task: 't1' }, 'a'), state);
    observeChunk(mkToolCall('task_check', { task: 't1', status: 'pending' }, 'b'), state);
    expect(detectPositiveOutcome(readState(state))).toBe(false);
  });

  it('returns true on is-task-complete signal', () => {
    const state: Record<string, unknown> = {};
    observeChunk({ type: 'is-task-complete', payload: {} }, state);
    expect(detectPositiveOutcome(readState(state))).toBe(true);
  });

  it('returns true on user affirmation regex', () => {
    const state: Record<string, unknown> = {};
    expect(detectPositiveOutcome(readState(state), 'thanks, that worked')).toBe(true);
    expect(detectPositiveOutcome(readState(state), 'Perfect!')).toBe(true);
  });

  it('returns false when assistant message admits failure', () => {
    const state: Record<string, unknown> = {};
    expect(
      detectPositiveOutcome(readState(state), undefined, 'Sorry, I couldn\'t complete that'),
    ).toBe(false);
  });

  it('defaults to false when no signals are present', () => {
    const state: Record<string, unknown> = {};
    expect(detectPositiveOutcome(readState(state))).toBe(false);
  });
});

describe('buildTrajectory', () => {
  it('produces a TaskTrajectory with all required fields', () => {
    const state: Record<string, unknown> = {};
    observeChunk(mkToolCall('tool_a', { x: 1 }, 't-1'), state);
    observeChunk({ type: 'tool-result', payload: { toolCallId: 't-1', result: 'ok' } }, state);
    observeChunk({ type: 'finish', payload: {} }, state);

    const traj = buildTrajectory({
      state: readState(state),
      threadId: 'thread-x',
      agentId: 'agent-x',
      finalUserMessage: 'thanks',
    });

    expect(traj.toolCalls).toHaveLength(1);
    expect(traj.toolCalls[0].output).toBe('ok');
    expect(traj.turnCount).toBe(1);
    expect(traj.positiveOutcome).toBe(true);
    expect(traj.threadId).toBe('thread-x');
    expect(traj.agentId).toBe('agent-x');
  });
});
