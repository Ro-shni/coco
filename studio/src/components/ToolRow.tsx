import { useState } from 'react';
import { api, SessionExpiredError } from '../api';
import type { Mode, ToolView } from '../types';

const LABEL: Record<Mode, string> = { auto: 'Run freely', confirm: 'Ask me first', off: 'Off' };

export function ToolRow({ tool, onChanged }: { tool: ToolView; onChanged: () => void }) {
  const [mode, setMode] = useState<Mode>(tool.mode);
  const [modeError, setModeError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<string>();

  const change = async (m: Mode) => {
    const previous = mode;
    setMode(m);
    setModeError(undefined);
    try {
      await api('PUT', `/api/tools/${encodeURIComponent(tool.qualified)}/mode`, { mode: m });
      onChanged();
    } catch (e) {
      if (e instanceof SessionExpiredError) return; // full-page message already shown
      setMode(previous); // revert the optimistic update
      setModeError(e instanceof Error ? e.message : String(e));
    }
  };
  const run = async () => {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const r = await api<{ ok: boolean; text: string; ms: number }>('POST', `/api/tools/${encodeURIComponent(tool.qualified)}/test`, { args: parsed });
      setResult(`${r.ok ? 'ok' : 'error'} · ${r.ms} ms\n${r.text}`);
    } catch (e) {
      setResult(`error: ${(e as Error).message}`);
    }
  };

  return (
    <li className="tool">
      <div className="tool-head">
        <strong>{tool.name}</strong>
        <span className="muted">{tool.description}</span>
        <select aria-label={`Permission for ${tool.name}`} value={mode} onChange={(e) => void change(e.target.value as Mode)}>
          {(Object.keys(LABEL) as Mode[]).map((m) => <option key={m} value={m}>{LABEL[m]}</option>)}
        </select>
        <button onClick={() => setTesting((t) => !t)}>Test</button>
      </div>
      {modeError && <p role="alert" className="error small">{`Couldn't change permission: ${modeError}`}</p>}
      {testing && (
        <div className="tool-test">
          <textarea aria-label={`Arguments for ${tool.name}`} value={args} onChange={(e) => setArgs(e.target.value)} rows={3} />
          <button onClick={() => void run()}>Run test</button>
          {result && <pre className="result">{result}</pre>}
        </div>
      )}
    </li>
  );
}
