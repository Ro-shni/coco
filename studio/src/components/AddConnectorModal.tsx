import { useCallback, useEffect, useState } from 'react';
import { api, reportApiError, SessionExpiredError } from '../api';
import type { CatalogItem, Discovered } from '../types';
import { CatalogAdd } from './CatalogAdd';
import { CustomConnectorForm } from './CustomConnectorForm';
import { ErrorBanner } from './ErrorBanner';
import { ImportDialog, type ImportPreview } from './ImportDialog';
import { Modal } from './Modal';

export type Pending = { preview: ImportPreview; submit: () => Promise<unknown> };
type TabId = 'catalog' | 'found' | 'custom';
const TABS: { id: TabId; label: string }[] = [{ id: 'catalog', label: 'Catalog' }, { id: 'found', label: 'Found on this Mac' }, { id: 'custom', label: 'Custom' }];

const REASON: Record<Discovered['status'], string> = {
  importable: '', already_imported: 'Already added', blocked_host: 'Blocked: production host',
  unsupported_variable: 'Unsupported: uses a plugin variable', unsupported_transport: 'Unsupported transport',
};

/** Every add path hands its exact command/URL to the ImportDialog; only that dialog's confirm button posts. */
export function AddConnectorModal({ initialTab = 'catalog', onClose, onAdded }: { initialTab?: TabId; onClose: () => void; onAdded: (id?: string) => void }) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [found, setFound] = useState<Discovered[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [error, setError] = useState<string>();
  const [scanDir, setScanDir] = useState('');

  const load = useCallback(async () => {
    try {
      const [d, k] = await Promise.all([api<{ servers: Discovered[] }>('GET', '/api/discovery'), api<CatalogItem[]>('GET', '/api/catalog')]);
      setFound(d.servers); setCatalog(k);
    } catch (e) {
      if (e instanceof SessionExpiredError) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setDialogError(undefined);
    try {
      const r = (await pending.submit()) as { id?: string } | undefined;
      setPending(undefined);
      onAdded(r?.id);
    } catch (e) { setDialogError((e as Error).message); }
    finally { setBusy(false); }
  };

  const addScanDir = (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    void api('POST', '/api/settings/scan-dirs', { dir: scanDir }).then(() => { setScanDir(''); return load(); }).catch(reportApiError(setError));
  };

  return (
    <>
      <Modal title="Add connector" titleId="add-title" wide onClose={onClose}>
        <div role="tablist" aria-label="Where to add from" className="tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`}
                    className={tab === t.id ? 'tab tab-on' : 'tab'} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        {error && <ErrorBanner message={error} onDismiss={() => setError(undefined)} />}
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
          {tab === 'catalog' && (
            catalog.length === 0 ? <p className="muted">The catalog is empty.</p> : (
              <ul className="card-grid">
                {catalog.map((k) => (
                  <li key={k.id} className="card stack" data-testid={`catalog-${k.id}`}>
                    <h3>{k.name}</h3>
                    <p className="muted small">{k.description}</p>
                    <p className="muted small">{k.setupNotes} <a href={k.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a></p>
                    {k.added ? <span className="pill pill-ok">Added</span> : <CatalogAdd item={k} onPreview={setPending} />}
                  </li>
                ))}
              </ul>
            )
          )}
          {tab === 'found' && (
            <div className="stack">
              <form className="row" onSubmit={addScanDir}>
                <input aria-label="Folder to scan for .mcp.json" placeholder="/Users/you/code" value={scanDir} onChange={(e) => setScanDir(e.target.value)} />
                <button type="submit" disabled={scanDir.trim() === ''}>Add folder to scan</button>
              </form>
              {found.length === 0 ? <p className="muted">Nothing found. Add a folder that contains a .mcp.json to look there too.</p> : (
                <ul className="found-list">
                  {found.map((d) => {
                    const blocked = d.status !== 'importable';
                    return (
                      <li key={d.key} className={blocked ? 'found found-blocked' : 'found'} data-testid={`discovered-${d.name}`}>
                        <div className="found-main">
                          <strong>{d.name}</strong>
                          <code className="muted small">{d.transport === 'http' ? d.url : d.command}</code>
                        </div>
                        {d.status === 'blocked_host' && <span className="pill pill-blocked"><span aria-hidden="true">🔒</span> {REASON[d.status]}</span>}
                        {blocked && d.status !== 'blocked_host' && <span className="pill">{REASON[d.status]}</span>}
                        {!blocked && (
                          <button type="button" onClick={() => setPending({
                            preview: { title: `Import ${d.name}`, command: d.transport === 'stdio' ? [d.command, ...d.args].join(' ') : undefined, url: d.url, envNames: d.envNames, headerNames: d.headerNames, foundIn: d.foundIn },
                            submit: () => api('POST', '/api/discovery/import', { key: d.key, confirm: true }),
                          })}>Import</button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          {tab === 'custom' && <CustomConnectorForm onPreview={setPending} />}
        </div>
      </Modal>
      {pending && <ImportDialog preview={pending.preview} busy={busy} error={dialogError} onConfirm={() => void confirm()} onCancel={() => { setPending(undefined); setDialogError(undefined); }} />}
    </>
  );
}
