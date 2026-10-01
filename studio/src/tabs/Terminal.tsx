import { useEffect, useState } from 'react';
import { api, SessionExpiredError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { PermissionControl } from '../components/PermissionControl';
import type { Mode } from '../types';

interface BuiltinTool { qualified: string; name: string; description: string; mode: Mode }
const SHELL = 'coco__shell_run';
const SHELL_LABELS: Record<Mode, string> = { auto: 'Run read-only freely', confirm: 'Always ask', off: 'Off' };

export function Terminal() {
  const [tools, setTools] = useState<BuiltinTool[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api<{ tools: BuiltinTool[] }>('GET', '/api/builtin')
      .then((r) => setTools(r.tools))
      .catch((e: unknown) => { if (!(e instanceof SessionExpiredError)) setError(e instanceof Error ? e.message : String(e)); });
  }, []);

  const shell = tools?.find((t) => t.qualified === SHELL);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Terminal</h1>
        <span className="pill pill-connected">Built in</span>
        <p className="muted lede">Lets Coco run commands on this Mac.</p>
      </header>
      {error && <ErrorBanner message={`Couldn't load the Terminal: ${error}`} />}
      <section className="card stack" aria-labelledby="how-h">
        <h2 id="how-h">How it behaves</h2>
        <p>Read-only commands (ps, ls, git status…) run immediately. Anything else asks with the exact command. sudo, disk wipes and production hosts are always blocked.</p>
        {shell && (
          <div className="row">
            <span id="perm-label" className="small">Permission</span>
            <PermissionControl qualified={shell.qualified} name={shell.name} mode={shell.mode} labels={SHELL_LABELS} onChanged={() => undefined} />
          </div>
        )}
        <p className="muted small">To see it in action, ask Coco something in the <a href="#playground">Playground</a>.</p>
      </section>
      {tools && tools.length > 0 && (
        <section className="stack" aria-labelledby="bt-h">
          <h2 id="bt-h">Tools</h2>
          <ul className="tools">
            {tools.map((t) => (
              <li key={t.qualified} className="tool">
                <div className="tool-main"><h3 className="tool-name">{t.name}</h3><p className="muted small tool-desc">{t.description.split('\n')[0]}</p></div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
