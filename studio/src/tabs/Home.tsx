import { useEffect, useState } from 'react';
import { api, SessionExpiredError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import type { Health } from '../types';

export function Home() {
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
