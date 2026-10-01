import { useState } from 'react';
import { api } from '../api';
import type { CatalogItem } from '../types';
import type { Pending } from './AddConnectorModal';

export function CatalogAdd({ item, onPreview }: { item: CatalogItem; onPreview: (p: Pending) => void }) {
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
    <div className="stack">
      {item.needsClientId && <input aria-label={`${item.name} Client ID`} placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />}
      {names.map((n) => <input key={n} aria-label={`${item.name} ${n}`} placeholder={n} type="password" value={values[n] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} />)}
      {item.argsHint && <input aria-label={`${item.name} folder`} placeholder={item.argsHint} value={folder} onChange={(e) => setFolder(e.target.value)} />}
      <button type="button" className="primary" disabled={item.needsClientId === true && clientId === ''} onClick={open}>
        {item.needsClientId && clientId === '' ? 'Needs Slack app' : `Add ${item.name}`}
      </button>
    </div>
  );
}
