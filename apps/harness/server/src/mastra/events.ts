import type { SelfLearningEvent } from '@avant-garde/mastra-self-learning';

/**
 * In-memory event bus for the harness.
 *
 * Holds a bounded ring buffer of recent self-learning events (so a freshly
 * opened UI can backfill the timeline) and fans new events out to live SSE
 * subscribers. Single-process, dev-only — no durability.
 */
const MAX_BUFFER = 500;

const buffer: SelfLearningEvent[] = [];
const subscribers = new Set<(e: SelfLearningEvent) => void>();

export function recordEvent(event: SelfLearningEvent): void {
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      /* a broken subscriber must not break the bus */
    }
  }
}

export function recentEvents(limit = 200): SelfLearningEvent[] {
  return buffer.slice(-limit);
}

export function subscribe(fn: (e: SelfLearningEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function eventStats() {
  const byType: Record<string, number> = {};
  for (const e of buffer) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return { total: buffer.length, byType };
}
