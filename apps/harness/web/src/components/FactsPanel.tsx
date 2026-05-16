import { useEffect, useState } from 'react';
import { api, type FactEntry } from '../api';

export function FactsPanel({ refreshKey }: { refreshKey: number }) {
  const [facts, setFacts] = useState<FactEntry[]>([]);

  useEffect(() => {
    api
      .facts()
      .then((r) => setFacts(r.facts))
      .catch(() => setFacts([]));
  }, [refreshKey]);

  if (facts.length === 0)
    return <div className="empty">No persistent facts yet.</div>;

  return (
    <div className="facts">
      {facts.map((f) => (
        <div key={f.id} className="fact">
          <div className="cat">
            {f.category} · conf {f.confidence.toFixed(2)}
          </div>
          <div>{f.content}</div>
        </div>
      ))}
    </div>
  );
}
