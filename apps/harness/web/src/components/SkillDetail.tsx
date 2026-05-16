import { useEffect, useState } from 'react';
import { api, type SkillDetail as Detail } from '../api';

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+')
          ? 'add'
          : line.startsWith('-')
            ? 'del'
            : line.startsWith('@@')
              ? 'ctx'
              : '';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export function SkillDetail({ id, refreshKey }: { id: string; refreshKey: number }) {
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api
      .skill(id)
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [id, refreshKey]);

  if (err) return <div className="empty">{err}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const { skill, versions, usage } = data;

  return (
    <div className="detail">
      <h3>{skill.name}</h3>
      <div className="sub">
        v{skill.version} · {skill.trustTier} · {skill.status} · origin thread{' '}
        {String(
          (skill.frontmatter?.metadata as Record<string, unknown> | undefined)
            ?.mastra && 'mastra' in (skill.frontmatter.metadata as object)
            ? ''
            : '',
        )}
      </div>

      <div className="statgrid">
        <div className="stat">
          <div className="v">{usage.totalUses}</div>
          <div className="l">uses</div>
        </div>
        <div className="stat">
          <div className="v">{(usage.successRate * 100).toFixed(0)}%</div>
          <div className="l">success</div>
        </div>
        <div className="stat">
          <div className="v">{skill.successCount}</div>
          <div className="l">✓ count</div>
        </div>
        <div className="stat">
          <div className="v">{skill.failCount}</div>
          <div className="l">✗ count</div>
        </div>
      </div>

      <h4>Current SKILL.md</h4>
      <pre>{skill.content}</pre>

      <h4>Version history ({versions.length})</h4>
      {versions.map((v) => (
        <div key={v.id} className="version">
          <div className="vh">
            <span>
              <strong>v{v.version}</strong> — {v.reason}
            </span>
            <span>{new Date(v.createdAt).toLocaleString()}</span>
          </div>
          {v.diffFromPrevious ? (
            <Diff text={v.diffFromPrevious} />
          ) : (
            <div className="diff ctx">initial version (no diff)</div>
          )}
        </div>
      ))}
    </div>
  );
}
