import { useEffect, useMemo, useState } from 'react';
import { api, SessionExpiredError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import type { AuditRow } from '../types';

export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

export function Activity() {
  const [rows, setRows] = useState<AuditRow[]>();
  const [error, setError] = useState<string>();
  const [connector, setConnector] = useState('');
  const [decision, setDecision] = useState('');

  useEffect(() => {
    void api<AuditRow[]>('GET', '/api/audit?limit=200')
      .then(setRows)
      .catch((e: unknown) => {
        if (e instanceof SessionExpiredError) return; // full-page message already shown
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const connectors = useMemo(() => [...new Set((rows ?? []).map((r) => r.serverId))].sort(), [rows]);
  const decisions = useMemo(() => [...new Set((rows ?? []).map((r) => r.decision))].sort(), [rows]);
  const shown = (rows ?? []).filter((r) => (connector === '' || r.serverId === connector) && (decision === '' || r.decision === decision));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Activity</h1>
        <span className="spacer" />
        {rows && rows.length > 0 && (
          <>
            <select aria-label="Filter by connector" value={connector} onChange={(e) => setConnector(e.target.value)}>
              <option value="">All connectors</option>
              {connectors.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select aria-label="Filter by decision" value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="">All decisions</option>
              {decisions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </>
        )}
      </header>
      {error && <ErrorBanner message={`Couldn't load Activity: ${error}`} />}
      {rows && rows.length === 0 && (
        <div className="empty">
          <h2>Nothing has run yet</h2>
          <p>Every tool Coco runs, asks about or blocks is listed here.</p>
          <a className="btn" href="#playground">Try the Playground</a>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="card table-card">
          <table>
            <thead><tr><th scope="col">When</th><th scope="col">Connector</th><th scope="col">Tool</th><th scope="col">Decision</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td title={new Date(r.ts).toLocaleString()}>{relativeTime(r.ts)}</td>
                  <td>{r.serverId}</td>
                  <td><code>{r.tool}</code></td>
                  <td><span className={`pill pill-${r.decision}`}>{r.decision}</span></td>
                  <td>{r.ok === null ? '—' : <><span className={r.ok ? 'pill pill-ok' : 'pill pill-error'}>{r.ok ? 'ok' : 'error'}</span>{r.ms !== null ? <span className="muted"> {r.ms} ms</span> : null}</>}</td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={5} className="muted">No activity matches these filters.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
