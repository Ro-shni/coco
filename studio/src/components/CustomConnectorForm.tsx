import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { ImportPreview } from './ImportDialog';

type Transport = 'stdio' | 'http';
interface CredentialRow { id: string; name: string; value: string }
export interface CustomConnectorSubmission { preview: ImportPreview; submit: () => Promise<unknown> }

let credentialSeq = 0;
function nextCredentialId(): string {
  credentialSeq += 1;
  return `custom-cred-${credentialSeq}`;
}

/** "Add custom connector" form on the Connectors tab. Submitting never calls the API directly — it hands
 * the exact command/URL and credential NAMES (never values) to the caller's `onPreview`, which opens the
 * shared `ImportDialog`; only that dialog's "Run this server"/"Connect" button posts `POST /api/connectors`. */
export function CustomConnectorForm({ onPreview }: { onPreview: (p: CustomConnectorSubmission) => void }) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [url, setUrl] = useState('');
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);

  const credentialLabel = transport === 'stdio' ? 'env var' : 'header';
  const args = argsText.split('\n').map((a) => a.trim()).filter((a) => a !== '');
  const canSubmit = name.trim() !== '' && (transport === 'stdio' ? command.trim() !== '' : url.trim() !== '');

  const addCredential = () => setCredentials((rows) => [...rows, { id: nextCredentialId(), name: '', value: '' }]);
  const updateCredential = (id: string, patch: Partial<Pick<CredentialRow, 'name' | 'value'>>) =>
    setCredentials((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const removeCredential = (id: string) => setCredentials((rows) => rows.filter((row) => row.id !== id));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const named = credentials.filter((c) => c.name.trim() !== '');
    const names = named.map((c) => c.name.trim());
    const values = Object.fromEntries(named.map((c) => [c.name.trim(), c.value]));
    onPreview({
      preview: {
        title: `Add ${name.trim()}`,
        command: transport === 'stdio' ? [command.trim(), ...args].join(' ') : undefined,
        url: transport === 'http' ? url.trim() : undefined,
        envNames: transport === 'stdio' ? names : [],
        headerNames: transport === 'http' ? names : [],
      },
      submit: () => api('POST', '/api/connectors', {
        name: name.trim(),
        transport,
        confirm: true,
        ...(transport === 'stdio' ? { command: command.trim(), args } : { url: url.trim() }),
        ...(transport === 'stdio' && names.length > 0 ? { env: values } : {}),
        ...(transport === 'http' && names.length > 0 ? { headers: values } : {}),
      }),
    });
  };

  return (
    <form className="custom-connector" onSubmit={submit}>
      <div className="row">
        <input aria-label="Connector name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label="Connector transport" value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
          <option value="stdio">Command (stdio)</option>
          <option value="http">URL (http)</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <div className="row">
          <input aria-label="Command" placeholder="/path/to/binary" value={command} onChange={(e) => setCommand(e.target.value)} />
          <textarea aria-label="Arguments, one per line" placeholder={'--flag\nvalue'} value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={3} />
        </div>
      ) : (
        <div className="row">
          <input aria-label="Connector URL" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      )}
      <div className="credentials">
        {credentials.map((c, i) => (
          <div className="row" key={c.id}>
            <input aria-label={`${credentialLabel} name ${i + 1}`} placeholder="NAME" value={c.name} onChange={(e) => updateCredential(c.id, { name: e.target.value })} />
            <input aria-label={`${credentialLabel} value ${i + 1}`} placeholder="value" type="password" value={c.value} onChange={(e) => updateCredential(c.id, { value: e.target.value })} />
            <button type="button" onClick={() => removeCredential(c.id)}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={addCredential}>{`Add ${credentialLabel}`}</button>
      </div>
      <button type="submit" className="primary" disabled={!canSubmit}>Add custom connector</button>
    </form>
  );
}
