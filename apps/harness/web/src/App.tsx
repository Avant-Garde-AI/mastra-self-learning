import { useCallback, useEffect, useState } from 'react';
import { api, type Health } from './api';
import { SkillBrowser } from './components/SkillBrowser';
import { SkillDetail } from './components/SkillDetail';
import { Timeline } from './components/Timeline';
import { FactsPanel } from './components/FactsPanel';
import { Chat } from './components/Chat';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [centerTab, setCenterTab] = useState<'chat' | 'skill'>('chat');
  const [rightTab, setRightTab] = useState<'timeline' | 'facts'>('timeline');
  const [refreshKey, setRefreshKey] = useState(0);
  const [demoBusy, setDemoBusy] = useState(false);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    const tick = () =>
      api
        .health()
        .then(setHealth)
        .catch(() => setHealth(null));
    tick();
    const iv = setInterval(tick, 5000);
    return () => clearInterval(iv);
  }, []);

  const runDemo = async () => {
    setDemoBusy(true);
    try {
      await api.runDemo();
      setTimeout(refresh, 300);
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <h1>🧠 Self-Learning Harness</h1>
        {health ? (
          <>
            <span className={`badge ${health.dbReady ? 'ok' : 'off'}`}>
              DB {health.dbReady ? 'ready' : 'down'}
            </span>
            <span className={`badge ${health.hasLLM ? 'ok' : 'off'}`}>
              {health.hasLLM ? 'LLM configured' : 'no LLM key (chat disabled)'}
            </span>
            <span className="badge">{health.events.total} events</span>
          </>
        ) : (
          <span className="badge off">server unreachable</span>
        )}
        <div style={{ flex: 1 }} />
        <button className="primary" onClick={runDemo} disabled={demoBusy}>
          {demoBusy ? 'Running demo…' : '▶ Run learning demo'}
        </button>
      </div>

      <div className="layout">
        <div className="col">
          <h2>Learned Skills</h2>
          <SkillBrowser
            selectedId={selectedId}
            refreshKey={refreshKey}
            onSelect={(id) => {
              setSelectedId(id);
              setCenterTab('skill');
            }}
          />
        </div>

        <div className="col chatpane">
          <div className="tabs">
            <button
              className={centerTab === 'chat' ? 'active' : ''}
              onClick={() => setCenterTab('chat')}
            >
              Chat
            </button>
            <button
              className={centerTab === 'skill' ? 'active' : ''}
              onClick={() => setCenterTab('skill')}
              disabled={!selectedId}
            >
              Skill detail
            </button>
          </div>
          {centerTab === 'chat' ? (
            health?.hasLLM ? (
              <Chat agentId={health.agentId} />
            ) : (
              <div className="empty">
                Chat needs an <code>ANTHROPIC_API_KEY</code> on the server.
                Without it you can still click <strong>Run learning demo</strong>{' '}
                to watch the loop extract and refine a skill end-to-end.
              </div>
            )
          ) : selectedId ? (
            <SkillDetail id={selectedId} refreshKey={refreshKey} />
          ) : (
            <div className="empty">Select a skill on the left.</div>
          )}
        </div>

        <div className="col">
          <div className="tabs">
            <button
              className={rightTab === 'timeline' ? 'active' : ''}
              onClick={() => setRightTab('timeline')}
            >
              Learning timeline
            </button>
            <button
              className={rightTab === 'facts' ? 'active' : ''}
              onClick={() => setRightTab('facts')}
            >
              Facts
            </button>
          </div>
          {rightTab === 'timeline' ? (
            <Timeline onChange={refresh} />
          ) : (
            <FactsPanel refreshKey={refreshKey} />
          )}
        </div>
      </div>
    </div>
  );
}
