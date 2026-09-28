import { useCallback, useEffect, useState } from 'react';
import { api, ignoreExpired } from '../api';
import { ImportDialog, type ImportPreview } from '../components/ImportDialog';
import { StatusDot } from '../components/StatusDot';
import { ToolRow } from '../components/ToolRow';
import type { CatalogItem, ConnectorView, Discovered } from '../types';

const REASON: Record<Discovered['status'], string> = {
  importable: '', already_imported: 'Already added', blocked_host: 'Blocked: production host',
  unsupported_variable: 'Unsupported: uses a plugin variable', unsupported_transport: 'Unsupported transport',
};

type Pending = { preview: ImportPreview; submit: () => Promise<unknown> };

export function Connectors() {
  const [mine, setMine] = useState<ConnectorView[]>([]);
  const [found, setFound] = useState<Discovered[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [authLinks, setAuthLinks] = useState<Record<string, string>>({});
  const [scanDir, setScanDir] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, d, k] = await Promise.all([
        api<ConnectorView[]>('GET', '/api/connectors'),
        api<{ servers: Discovered[] }>('GET', '/api/discovery'),
        api<CatalogItem[]>('GET', '/api/catalog'),
      ]);
      setMine(c); setFound(d.servers); setCatalog(k);
    } catch (e) {
      ignoreExpired(e);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setError(undefined);
    try { await pending.submit(); setPending(undefined); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const signIn = async (id: string) => {
    try {
      const r = await api<{ authorizationUrl?: string }>('POST', `/api/connectors/${id}/auth`);
      if (r.authorizationUrl) setAuthLinks((m) => ({ ...m, [id]: r.authorizationUrl! }));
      else await load();
    } catch (e) {
      ignoreExpired(e);
    }
  };

  return (
    <section>
      <h2>Your connectors</h2>
      {mine.length === 0 && <p className="muted">Nothing connected yet. Import one below.</p>}
      <ul className="cards">
        {mine.map((c) => (
          <li key={c.config.id} className="card" data-testid={`connector-${c.config.id}`}>
            <header>
              <StatusDot state={c.status?.state ?? 'disconnected'} />
              <strong>{c.config.name}</strong>
              {c.config.readOnly && <span className="badge">read-only</span>}
              {c.status?.error && <span className="error">{c.status.error}</span>}
              <span className="spacer" />
              {c.status?.state === 'needs_auth' && <button onClick={() => void signIn(c.config.id)}>Sign in</button>}
              {authLinks[c.config.id] && <a href={authLinks[c.config.id]} target="_blank" rel="noreferrer">Continue sign-in ↗</a>}
              <button onClick={() => void api('POST', `/api/connectors/${c.config.id}/reconnect`).then(load).catch(ignoreExpired)}>Reconnect</button>
              <button onClick={() => void api('DELETE', `/api/connectors/${c.config.id}`).then(load).catch(ignoreExpired)}>Remove</button>
            </header>
            <ul className="tools">{c.tools.map((t) => <ToolRow key={t.qualified} tool={t} onChanged={() => void load()} />)}</ul>
          </li>
        ))}
      </ul>

      <h2>Found on this Mac</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void api('POST', '/api/settings/scan-dirs', { dir: scanDir }).then(() => { setScanDir(''); return load(); }).catch((err: Error) => setError(err.message)); }}>
        <input aria-label="Folder to scan for .mcp.json" placeholder="/Users/you/code" value={scanDir} onChange={(e) => setScanDir(e.target.value)} />
        <button type="submit">Add folder to scan</button>
      </form>
      <ul className="cards">
        {found.map((d) => (
          <li key={d.key} className="card" data-testid={`discovered-${d.name}`}>
            <strong>{d.name}</strong> <span className="muted">{d.transport === 'http' ? d.url : d.command}</span>
            {d.status === 'blocked_host' && <span className="badge lock">🔒 <span>{REASON[d.status]}</span></span>}
            {d.status !== 'importable' && d.status !== 'blocked_host' && <span className="badge">{REASON[d.status]}</span>}
            {d.status === 'importable' && (
              <button onClick={() => setPending({
                preview: { title: `Import ${d.name}`, command: d.transport === 'stdio' ? [d.command, ...d.args].join(' ') : undefined, url: d.url, envNames: d.envNames, headerNames: d.headerNames, foundIn: d.foundIn },
                submit: () => api('POST', '/api/discovery/import', { key: d.key, confirm: true }),
              })}>Import</button>
            )}
          </li>
        ))}
      </ul>

      <h2>Catalog</h2>
      <ul className="cards">
        {catalog.map((k) => (
          <li key={k.id} className="card" data-testid={`catalog-${k.id}`}>
            <strong>{k.name}</strong> <span className="muted">{k.description}</span>
            <p className="muted small">{k.setupNotes} <a href={k.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a></p>
            {k.added ? <span className="badge">Added</span> : (
              <CatalogAdd item={k} onPreview={setPending} />
            )}
          </li>
        ))}
      </ul>

      {pending && <ImportDialog preview={pending.preview} busy={busy} error={error} onConfirm={() => void confirm()} onCancel={() => { setPending(undefined); setError(undefined); }} />}
    </section>
  );
}

function CatalogAdd({ item, onPreview }: { item: CatalogItem; onPreview: (p: Pending) => void }) {
  const [clientId, setClientId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState('');
  const names = [...(item.envNames ?? []), ...(item.headerNames ?? [])];
  const open = () => onPreview({
    preview: { title: `Add ${item.name}`, command: item.transport === 'stdio' ? [item.command, ...(item.args ?? []), ...(folder ? [folder] : [])].join(' ') : undefined, url: item.url, envNames: item.envNames ?? [], headerNames: item.headerNames ?? [] },
    submit: () => api('POST', `/api/catalog/${item.id}/add`, {
      confirm: true,
      ...(clientId ? { clientId } : {}),
      ...(item.envNames?.length ? { env: Object.fromEntries(item.envNames.map((n) => [n, values[n] ?? ''])) } : {}),
      ...(item.headerNames?.length ? { headers: Object.fromEntries(item.headerNames.map((n) => [n, values[n] ?? ''])) } : {}),
      ...(folder ? { args: [folder] } : {}),
    }),
  });
  return (
    <div className="row">
      {item.needsClientId && <input aria-label={`${item.name} Client ID`} placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />}
      {names.map((n) => <input key={n} aria-label={`${item.name} ${n}`} placeholder={n} type="password" value={values[n] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} />)}
      {item.argsHint && <input aria-label={`${item.name} folder`} placeholder={item.argsHint} value={folder} onChange={(e) => setFolder(e.target.value)} />}
      <button disabled={item.needsClientId === true && clientId === ''} onClick={open}>{item.needsClientId && clientId === '' ? 'Needs Slack app' : 'Add'}</button>
    </div>
  );
}
