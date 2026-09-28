import { useEffect, useState } from 'react';
import { api, SessionExpiredError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import type { AuditRow } from '../types';

export function Activity() {
  const [rows, setRows] = useState<AuditRow[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api<AuditRow[]>('GET', '/api/audit?limit=200')
      .then(setRows)
      .catch((e: unknown) => {
        if (e instanceof SessionExpiredError) return; // full-page message already shown
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  if (error) {
    return (
      <section>
        <h2>Activity</h2>
        <ErrorBanner message={`Couldn't load Activity: ${error}`} />
      </section>
    );
  }

  return (
    <section>
      <h2>Activity</h2>
      <table>
        <thead><tr><th>When</th><th>Connector</th><th>Tool</th><th>Decision</th><th>Result</th></tr></thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{r.serverId}</td>
              <td>{r.tool}</td>
              <td><span className={`badge d-${r.decision}`}>{r.decision}</span></td>
              <td>{r.ok === null ? '—' : `${r.ok ? 'ok' : 'error'}${r.ms !== null ? ` · ${r.ms} ms` : ''}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
