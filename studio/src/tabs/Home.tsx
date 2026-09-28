import { useEffect, useState } from 'react';
import { api, ignoreExpired } from '../api';
import type { Health } from '../types';

export function Home() {
  const [h, setH] = useState<Health>();
  useEffect(() => { void api<Health>('GET', '/api/health').then(setH).catch(ignoreExpired); }, []);
  if (!h) return <p className="muted">Loading…</p>;
  const c = h.connectors;
  return (
    <section>
      <h2>Home</h2>
      <dl className="kv">
        <dt>Model</dt><dd>{h.models.main}</dd>
        <dt>Ollama</dt><dd>{h.ollama ? 'Running' : 'Ollama is not reachable — start it with `ollama serve`.'}</dd>
        <dt>Connectors</dt><dd>{`${c.connected} of ${c.total} connected${c.error ? ` · ${c.error} need attention` : ''}`}</dd>
      </dl>
    </section>
  );
}
