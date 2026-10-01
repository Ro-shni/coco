import { connectorHref, type Route } from '../hooks/useRoute';
import type { ConnectorView, ServerState } from '../types';
import { CocoMark } from './CocoMark';
import { StatusDot } from './StatusDot';

const NAV = [
  { page: 'home', label: 'Home', href: '#home' },
  { page: 'connectors', label: 'Connectors', href: '#connectors' },
  { page: 'playground', label: 'Playground', href: '#playground' },
  { page: 'activity', label: 'Activity', href: '#activity' },
] as const;

export function connectorState(c: ConnectorView): ServerState {
  return c.config.enabled ? (c.status?.state ?? 'disconnected') : 'disabled';
}

export function Sidebar({ route, connectors, onAdd }: { route: Route; connectors: ConnectorView[]; onAdd?: () => void }) {
  return (
    <nav className="sidebar" aria-label="Studio">
      <div className="brand"><CocoMark /><span>Coco Studio</span></div>
      <div className="side-nav">
        {NAV.map((n) => (
          <a key={n.page} className="side-link" href={n.href} aria-current={route.page === n.page ? 'page' : undefined}>{n.label}</a>
        ))}
      </div>
      <p className="side-group">Connected tools</p>
      <div className="side-nav side-sub">
        {connectors.map((c) => (
          <a key={c.config.id} className="side-link" href={connectorHref(c.config.id)}
             aria-current={route.page === 'connector' && route.id === c.config.id ? 'page' : undefined}>
            <StatusDot state={connectorState(c)} />{c.config.name}
          </a>
        ))}
        <a className="side-link" href="#terminal" aria-current={route.page === 'terminal' ? 'page' : undefined}>
          <span className="dot dot-connected" aria-hidden="true" />Terminal
        </a>
      </div>
      {onAdd && <div className="side-foot"><button type="button" onClick={onAdd}>+ Add connector</button></div>}
    </nav>
  );
}
