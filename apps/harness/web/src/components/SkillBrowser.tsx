import { useEffect, useState } from 'react';
import { api, type SkillSummary } from '../api';

export function SkillBrowser({
  selectedId,
  onSelect,
  refreshKey,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  refreshKey: number;
}) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .skills()
      .then((r) => {
        setSkills(r.skills);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  }, [refreshKey]);

  if (err) return <div className="empty">Cannot reach server: {err}</div>;
  if (skills.length === 0)
    return <div className="empty">No skills learned yet.</div>;

  return (
    <div>
      {skills.map((s) => (
        <div
          key={s.id}
          className={`skill-item ${selectedId === s.id ? 'active' : ''}`}
          onClick={() => onSelect(s.id)}
        >
          <div className="name">
            {s.name} <span className="tag">v{s.version}</span>
          </div>
          <div className="desc">{s.description}</div>
          <div className="meta">
            <span>{s.status}</span>
            <span style={{ color: 'var(--green)' }}>✓ {s.successCount}</span>
            <span style={{ color: 'var(--red)' }}>✗ {s.failCount}</span>
            {s.tags.slice(0, 3).map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
