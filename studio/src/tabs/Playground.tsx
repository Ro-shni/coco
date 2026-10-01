import { useState, type FormEvent } from 'react';
import { api, SessionExpiredError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';

interface Run { tool: string; args: Record<string, unknown>; ok: boolean; text: string; ms: number; decision: string }
interface Answer { offered: string[]; runs: Run[]; pending?: { tool: string; args: Record<string, unknown>; reason: string } }

const EXAMPLES = ['How many Claude terminals are running?', 'Search Confluence for Wordle', "What's the status of DEVOPS-35236?"];

export function Playground() {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<string>();
  const [answer, setAnswer] = useState<Answer>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text) return;
    setBusy(true); setError(undefined); setAnswer(undefined); setAsked(text);
    try {
      setAnswer(await api<Answer>('POST', '/api/playground/ask', { question: text }));
    } catch (e) {
      if (e instanceof SessionExpiredError) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void ask(question); };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Playground</h1>
        <p className="muted lede">See which tools Coco would use to answer a question, and what they return.</p>
      </header>

      <form className="ask-box" onSubmit={submit}>
        <label htmlFor="ask-input" className="visually-hidden">Ask Coco</label>
        <textarea id="ask-input" rows={3} maxLength={500} placeholder="Ask what Coco would look up…" value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(question); } }} />
        <div className="row">
          <p className="muted small">Read-only tools really run; anything that asks first is only shown.</p>
          <span className="spacer" />
          <button type="submit" className="primary" disabled={busy || question.trim() === ''}>{busy ? 'Running…' : 'Run'}</button>
        </div>
      </form>

      {error && <ErrorBanner message={`Couldn't run that: ${error}`} onDismiss={() => setError(undefined)} />}

      <div aria-live="polite">
        {answer && <Timeline asked={asked ?? ''} answer={answer} />}
      </div>

      {!answer && !busy && !error && (
        <div className="empty">
          <h2>Try a question</h2>
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => { setQuestion(ex); void ask(ex); }}>{ex}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Timeline({ asked, answer }: { asked: string; answer: Answer }) {
  return (
    <ol className="timeline" aria-label={`Steps for “${asked}”`}>
      <li className="step">
        <h2 className="step-title">Tools offered</h2>
        {answer.offered.length === 0 ? <p className="muted small">No tools matched this question.</p> : (
          <ul className="chips">{answer.offered.map((t) => <li key={t} className="chip chip-static"><code>{t}</code></li>)}</ul>
        )}
      </li>
      {answer.runs.map((r, i) => <RunStep key={`${r.tool}-${i}`} run={r} />)}
      {answer.pending && (
        <li className="step step-pending">
          <h2 className="step-title">Would ask first</h2>
          <p><code>{answer.pending.tool}</code> {formatArgs(answer.pending.args)}</p>
          <p className="muted small">{answer.pending.reason}</p>
        </li>
      )}
      {answer.runs.length === 0 && !answer.pending && (
        <li className="step"><p className="muted">Coco would not call any tool for this question.</p></li>
      )}
    </ol>
  );
}

function RunStep({ run }: { run: Run }) {
  return (
    <li className="step">
      <div className="row">
        <h2 className="step-title"><code>{run.tool}</code></h2>
        <span className={run.ok ? 'pill pill-ok' : 'pill pill-error'}>{run.ok ? 'ok' : 'error'}</span>
        <span className="muted small">{run.ms} ms</span>
      </div>
      <dl className="kv">
        {Object.entries(run.args).map(([k, v]) => (<div key={k} className="kv-row"><dt>{k}</dt><dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>))}
        {Object.keys(run.args).length === 0 && <div className="kv-row"><dt>args</dt><dd className="muted">none</dd></div>}
      </dl>
      <details>
        <summary>Output</summary>
        <pre className="result">{run.text}</pre>
      </details>
    </li>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(' ');
}
