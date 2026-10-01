import { useEffect, useMemo, useState } from 'react';
import { api, reportApiError } from '../api';
import { ActionMenu } from '../components/ActionMenu';
import { ErrorBanner } from '../components/ErrorBanner';
import { Modal } from '../components/Modal';
import { connectorState } from '../components/Sidebar';
import { StatusPill } from '../components/StatusDot';
import { ToolRow } from '../components/ToolRow';
import type { ConnectorView } from '../types';

const FILTER_THRESHOLD = 8;

export function ConnectorDetail({ connector: c, reload, onRemoved }: { connector: ConnectorView; reload: () => Promise<void>; onRemoved: () => void }) {
  const [failure, setFailure] = useState<string>();
  const [authUrl, setAuthUrl] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [filter, setFilter] = useState('');
  const state = connectorState(c);
  const id = c.config.id;
  const report = reportApiError(setFailure);

  // The brain connects in the background; keep refreshing while it says "connecting".
  useEffect(() => {
    if (state !== 'connecting') return;
    const t = setTimeout(() => void reload(), 1500);
    return () => clearTimeout(t);
  }, [state, reload, c.status?.since]);

  const run = (fn: () => Promise<unknown>) => {
    setFailure(undefined);
    void fn().then(reload).catch(report);
  };
  const reconnect = () => run(() => api('POST', `/api/connectors/${id}/reconnect`));
  const setEnabled = (enabled: boolean) => run(() => api('POST', `/api/connectors/${id}/enabled`, { enabled }));
  const signIn = async () => {
    setFailure(undefined);
    try {
      const r = await api<{ authorizationUrl?: string }>('POST', `/api/connectors/${id}/auth`);
      if (r.authorizationUrl) setAuthUrl(r.authorizationUrl); else await reload();
    } catch (e) { report(e); }
  };
  const remove = () => {
    setConfirmRemove(false);
    setFailure(undefined);
    void api('DELETE', `/api/connectors/${id}`).then(async () => { await reload(); onRemoved(); }).catch(report);
  };

  const tools = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? c.tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : c.tools;
  }, [c.tools, filter]);

  return (
    <div className="page" data-testid={`connector-${id}`}>
      {failure && <ErrorBanner message={failure} onDismiss={() => setFailure(undefined)} />}
      <header className="page-head">
        <h1>{c.config.name}</h1>
        <StatusPill state={state} />
        {c.config.readOnly && <span className="pill">Read-only</span>}
        <span className="spacer" />
        {state === 'disabled' && <button type="button" className="primary" onClick={() => setEnabled(true)}>Enable</button>}
        {state === 'needs_auth' && <button type="button" className="primary" onClick={() => void signIn()}>Sign in</button>}
        {state === 'error' && <button type="button" className="primary" onClick={reconnect}>Reconnect</button>}
        {state === 'disconnected' && <button type="button" className="primary" onClick={reconnect}>Connect</button>}
        {state === 'connecting' && <button type="button" className="primary" disabled>Connecting…</button>}
        <ActionMenu label={`More actions for ${c.config.name}`} items={[
          { label: 'Reconnect', onSelect: reconnect },
          c.config.enabled ? { label: 'Disable', onSelect: () => setEnabled(false) } : { label: 'Enable', onSelect: () => setEnabled(true) },
          { label: 'Remove', danger: true, onSelect: () => setConfirmRemove(true) },
        ]} />
        {state === 'error' && <p className="error lede">{`Coco couldn't connect to ${c.config.name}. ${sentence(c.status?.error)}`}</p>}
        {authUrl && (
          <p className="lede" aria-live="polite">
            <a className="btn primary" href={authUrl} target="_blank" rel="noreferrer">Continue sign-in in your browser ↗</a>
          </p>
        )}
      </header>

      <section className="stack" aria-labelledby="tools-h">
        <div className="row">
          <h2 id="tools-h">Tools</h2>
          <span className="muted small">{c.tools.length}</span>
          <span className="spacer" />
          {c.tools.length > FILTER_THRESHOLD && (
            <input type="search" aria-label="Filter tools" placeholder="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
        </div>
        {c.tools.length === 0 ? (
          <p className="muted">{state === 'connected' ? 'This connector has not offered any tools.' : 'Tools appear here once the connector is connected.'}</p>
        ) : tools.length === 0 ? (
          <p className="muted">No tools match that filter.</p>
        ) : (
          <ul className="tools">{tools.map((t) => <ToolRow key={t.qualified} tool={t} onChanged={() => void reload()} />)}</ul>
        )}
      </section>

      {confirmRemove && (
        <Modal title={`Remove ${c.config.name}?`} titleId="remove-title" onClose={() => setConfirmRemove(false)}>
          <p>Coco will forget this connector and delete the credentials it stored for it.</p>
          <div className="actions">
            <button type="button" onClick={() => setConfirmRemove(false)}>Cancel</button>
            <button type="button" className="primary" onClick={remove}>Remove connector</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function sentence(text: string | undefined): string {
  const t = (text ?? 'Try reconnecting.').trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
