/**
 * Observability seam for the self-learning loop.
 *
 * A minimal, typed event stream emitted by `SelfLearningProcessor` at the
 * extraction and refinement decision points. This is the foundation the
 * Phase-6 OpenTelemetry work will build on; today it powers external
 * dashboards (e.g. the dev harness learning timeline).
 *
 * The callback is invoked best-effort: it is wrapped so a throwing handler
 * never breaks the (already fire-and-forget) learning work.
 */

export type SelfLearningEventType =
  | 'extraction.evaluated'
  | 'extraction.completed'
  | 'extraction.skipped'
  | 'refinement.evaluated'
  | 'refinement.completed'
  | 'refinement.skipped'
  | 'error';

export interface SelfLearningEvent {
  type: SelfLearningEventType;
  /** ISO timestamp set by the emitter. */
  at: string;
  /** Owning agent (best-effort; 'unknown' if not resolvable). */
  agentId: string;
  /** Thread the trajectory came from (best-effort). */
  threadId: string;
  /** Human-readable reason / detail string. */
  reason: string;
  /** Skill name when the event concerns a specific skill. */
  skillName?: string;
  /** Skill id when known. */
  skillId?: string;
  /** Resulting version when a skill was created/refined. */
  version?: string;
}

export type SelfLearningEventHandler = (event: SelfLearningEvent) => void;

/** Wrap a user handler so a throw never propagates into learning work. */
export function makeSafeEmitter(
  handler: SelfLearningEventHandler | undefined,
): (e: Omit<SelfLearningEvent, 'at'>) => void {
  if (!handler) return () => {};
  return (e) => {
    try {
      handler({ ...e, at: new Date().toISOString() });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[mastra-self-learning] onEvent handler threw; ignoring.',
        err instanceof Error ? err.message : err,
      );
    }
  };
}
