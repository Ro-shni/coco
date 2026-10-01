import { useId, useState, type FormEvent } from 'react';
import { api, SessionExpiredError } from '../api';
import { buildArgs, fieldsFor, initialValues, type Field, type FieldValues } from '../schema';
import type { ToolView } from '../types';

interface Outcome { ok: boolean; text: string; ms: number }

export function TryIt({ tool }: { tool: ToolView }) {
  const fields = fieldsFor(tool.inputSchema);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FieldValues>(() => initialValues(fields));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [outcome, setOutcome] = useState<Outcome>();
  const panel = useId();

  const set = (name: string, v: string | boolean) => setValues((cur) => ({ ...cur, [name]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(undefined);
    let args: Record<string, unknown>;
    try { args = buildArgs(fields, values); } catch (err) { setProblem((err as Error).message); return; }
    setBusy(true);
    try {
      setOutcome(await api<Outcome>('POST', `/api/tools/${encodeURIComponent(tool.qualified)}/test`, { args }));
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      setOutcome({ ok: false, text: err instanceof Error ? err.message : String(err), ms: 0 });
    } finally { setBusy(false); }
  };

  return (
    <div className="tool-try">
      <button type="button" className="ghost" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Try it'}<span className="visually-hidden">{` ${tool.name}`}</span>
      </button>
      {open && (
        <form id={panel} noValidate className="try-form" onSubmit={(e) => void submit(e)} aria-label={`Try ${tool.name}`}>
          {fields.length === 0 && <p className="muted small">This tool takes no inputs.</p>}
          {fields.map((f) => <FieldControl key={f.name} tool={tool.name} field={f} value={values[f.name] ?? ''} onChange={(v) => set(f.name, v)} />)}
          {problem && <p role="alert" className="error small">{problem}</p>}
          <div className="row"><button type="submit" className="primary" disabled={busy}>{busy ? 'Running…' : 'Run'}</button></div>
          <div aria-live="polite">{outcome && <ResultPanel outcome={outcome} />}</div>
        </form>
      )}
    </div>
  );
}

function FieldControl({ tool, field: f, value, onChange }: { tool: string; field: Field; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const id = useId();
  const label = (
    <label htmlFor={id} className="field-label">
      {f.name}{f.required && <span className="req" title="Required"> *</span>}
      {f.required && <span className="visually-hidden"> (required)</span>}
    </label>
  );
  const hint = f.description ? <p className="muted small field-hint">{f.description.split('\n')[0]}</p> : null;
  const common = { id, 'aria-label': undefined, required: f.required } as const;
  let control;
  if (f.kind === 'boolean') {
    return (
      <div className="field field-toggle">
        <input id={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}{hint}
      </div>
    );
  }
  if (f.kind === 'enum') {
    control = (
      <select {...common} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {!f.required && <option value="">—</option>}
        {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (f.kind === 'textarea' || f.kind === 'json') {
    control = <textarea {...common} rows={f.kind === 'json' ? 3 : 4} placeholder={f.kind === 'json' ? '{ }' : ''} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  } else if (f.kind === 'number' || f.kind === 'integer') {
    control = <input {...common} type="number" step={f.kind === 'integer' ? 1 : 'any'} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = <input {...common} type="text" placeholder={f.kind === 'list' ? 'a, b, c' : ''} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  }
  void tool;
  return <div className="field">{label}{control}{hint}</div>;
}

function ResultPanel({ outcome }: { outcome: Outcome }) {
  const pretty = prettyJson(outcome.text);
  return (
    <div className="result-panel">
      <div className="row">
        <span className={outcome.ok ? 'pill pill-ok' : 'pill pill-error'}>{outcome.ok ? 'ok' : 'error'}</span>
        <span className="muted small">{outcome.ms} ms</span>
      </div>
      {pretty ? (
        <details open>
          <summary>JSON result</summary>
          <pre className="result">{pretty}</pre>
        </details>
      ) : <pre className="result">{outcome.text}</pre>}
    </div>
  );
}

function prettyJson(text: string): string | undefined {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return undefined; }
}
