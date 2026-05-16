import { useEffect, useRef, useState } from 'react';
import { api, type LearningEvent } from '../api';

const LABELS: Record<string, string> = {
  'extraction.evaluated': 'Extraction evaluated',
  'extraction.completed': 'Skill extracted',
  'extraction.skipped': 'Extraction skipped',
  'refinement.evaluated': 'Refinement evaluated',
  'refinement.completed': 'Skill refined',
  'refinement.skipped': 'Refinement skipped',
  error: 'Error',
};

export function Timeline({ onChange }: { onChange?: () => void }) {
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;

    api
      .events()
      .then((r) => {
        if (!stopped) {
          for (const e of r.events) seen.current.add(key(e));
          setEvents(r.events.slice().reverse());
        }
      })
      .catch(() => undefined);

    es = new EventSource(api.eventStreamUrl);
    const handler = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as LearningEvent;
        if (!e.type || e.type === 'ping') return;
        const k = key(e);
        if (seen.current.has(k)) return;
        seen.current.add(k);
        setEvents((prev) => [e, ...prev].slice(0, 300));
        if (e.type.endsWith('.completed')) onChange?.();
      } catch {
        /* ignore malformed frames */
      }
    };
    // AG-UI emits typed events; listen broadly via onmessage + named types.
    es.onmessage = handler;
    for (const t of Object.keys(LABELS)) es.addEventListener(t, handler as EventListener);

    return () => {
      stopped = true;
      es?.close();
    };
  }, [onChange]);

  if (events.length === 0) {
    return <div className="empty">No learning events yet. Chat with the agent or click “Run demo”.</div>;
  }

  return (
    <div className="timeline">
      {events.map((e, i) => (
        <div key={i} className={`evt ${e.type.replace(/\./g, '\\.')}`}>
          <div className="t">
            <span className="type">{LABELS[e.type] ?? e.type}</span>
            <span className="ts">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          <div className="reason">
            {e.skillName ? <strong>{e.skillName}</strong> : null}
            {e.version ? ` v${e.version}` : ''} {e.skillName ? '— ' : ''}
            {e.reason}
          </div>
        </div>
      ))}
    </div>
  );
}

function key(e: LearningEvent): string {
  return `${e.at}|${e.type}|${e.skillName ?? ''}|${e.reason}`;
}
