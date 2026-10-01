import { useEffect, useState } from 'react';
import { api, SessionExpiredError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import type { Health } from '../types';

export type AddTab = 'catalog' | 'found' | 'custom';

export function Home({ onAdd }: { onAdd?: (tab: AddTab) => void }) {
  const [h, setH] = useState<Health>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api<Health>('GET', '/api/health')
      .then(setH)
      .catch((e: unknown) => {
        if (e instanceof SessionExpiredError) return; // full-page message already shown
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  if (error) return <ErrorBanner message={`Couldn't load Home: ${error}`} />;
  if (!h) return <p className="muted" role="status">Loading…</p>;
  const c = h.connectors;
  return (
    <div className="page">
      <header className="page-head"><h1>Home</h1></header>
      <ul className="card-grid status-cards">
        <StatusCard label="Brain" ok={h.brain === 'ok'} value={h.brain === 'ok' ? 'Running' : h.brain} />
        <StatusCard label="Model" ok value={h.models.main} />
        <StatusCard label="Ollama" ok={h.ollama} value={h.ollama ? 'Running' : 'Ollama is not reachable — start it with `ollama serve`.'} />
        <StatusCard label="Connectors" ok={c.error === 0 && (c.total === 0 || c.connected > 0)} value={`${c.connected} of ${c.total} connected${c.error ? ` · ${c.error} need attention` : ''}`} />
      </ul>
      {c.total === 0 && (
        <section className="card stack" aria-labelledby="start-h">
          <h2 id="start-h">Getting started</h2>
          <ul className="checklist">
            <li><button type="button" onClick={() => onAdd?.('found')}>Import from this Mac</button><span className="muted small">Reuse MCP servers you already set up for Claude.</span></li>
            <li><button type="button" onClick={() => onAdd?.('catalog')}>Sign in to Atlassian</button><span className="muted small">Jira and Confluence, from the catalog.</span></li>
            <li><a className="btn" href="#playground">Try the Playground</a><span className="muted small">See what Coco would look up for a question.</span></li>
          </ul>
        </section>
      )}
    </div>
  );
}

function StatusCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <li className="card status-card">
      <p className="muted small">{label}</p>
      <p className="status-value"><span className={ok ? 'dot dot-connected' : 'dot dot-needs_auth'} aria-hidden="true" /> {value}</p>
    </li>
  );
}
