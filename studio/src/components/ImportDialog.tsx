export interface ImportPreview { title: string; command?: string; url?: string; envNames: string[]; headerNames: string[]; foundIn?: string[] }

export function ImportDialog({ preview, onConfirm, onCancel, busy, error }: {
  preview: ImportPreview; onConfirm: () => void; onCancel: () => void; busy: boolean; error?: string;
}) {
  const runs = preview.command !== undefined;
  return (
    <div className="backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby="import-title" className="dialog">
        <h3 id="import-title">{preview.title}</h3>
        {runs ? (
          <>
            <p className="warn">This starts a program on your Mac:</p>
            <code className="cmd">{preview.command}</code>
          </>
        ) : (
          <p>Connects to <code>{preview.url}</code></p>
        )}
        {preview.envNames.length + preview.headerNames.length > 0 && (
          <>
            <p>Credentials copied into your Keychain (values are never shown or sent to the model):</p>
            <ul>{[...preview.envNames, ...preview.headerNames].map((n) => <li key={n}><code>{n}</code></li>)}</ul>
          </>
        )}
        {preview.foundIn && preview.foundIn.length > 0 && (
          <>
            <p>Found in:</p>
            <ul>{preview.foundIn.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          </>
        )}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={busy}>{runs ? 'Run this server' : 'Connect'}</button>
        </div>
      </div>
    </div>
  );
}
