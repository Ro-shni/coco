import { ConnectorDetail } from './ConnectorDetail';
import { connectorHref } from '../hooks/useRoute';
import type { ConnectorsState } from '../hooks/useConnectors';
import { connectorState } from '../components/Sidebar';
import { ErrorBanner } from '../components/ErrorBanner';
import { StatusPill } from '../components/StatusDot';

/** Connectors overview, or the detail page when `id` is set. */
export function Connectors({ data, id, onAdd }: { data: ConnectorsState; id?: string; onAdd?: () => void }) {
  if (id !== undefined) {
    const c = data.connectors.find((x) => x.config.id === id);
    if (!c) {
      return (
        <div className="page">
          <h1>Connector not found</h1>
          {data.loaded && <p className="muted">There is no connector called “{id}”. <a href="#connectors">Back to connectors</a></p>}
        </div>
      );
    }
    return <ConnectorDetail connector={c} reload={data.reload} onRemoved={() => { location.hash = 'connectors'; }} />;
  }
  return (
    <div className="page">
      {data.error && <ErrorBanner message={`Couldn't load connectors: ${data.error}`} />}
      <header className="page-head">
        <h1>Connectors</h1>
        <span className="spacer" />
        {onAdd && <button type="button" className="primary" onClick={onAdd}>+ Add connector</button>}
      </header>
      {data.loaded && data.connectors.length === 0 ? (
        <div className="empty">
          <h2>No connectors yet</h2>
          <p>Connect Jira, Confluence, Slack or any MCP server so Coco can look things up for you.</p>
          {onAdd && <button type="button" className="primary" onClick={onAdd}>+ Add connector</button>}
        </div>
      ) : (
        <ul className="card-grid">
          {data.connectors.map((c) => (
            <li key={c.config.id} className="card connector-card" data-testid={`connector-card-${c.config.id}`}>
              <a className="card-link" href={connectorHref(c.config.id)}><strong>{c.config.name}</strong></a>
              <StatusPill state={connectorState(c)} />
              <p className="muted small">{c.tools.length} {c.tools.length === 1 ? 'tool' : 'tools'}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
