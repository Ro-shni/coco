import { DatabaseSync } from 'node:sqlite';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export type NudgeOutcome = 'engaged' | 'ignored' | 'muted';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS nudges (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, outcome TEXT);
  CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL);
`;

export class Memory {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  addTurn(role: Turn['role'], text: string, ts: number): void {
    this.db.prepare('INSERT INTO turns (role, text, ts) VALUES (?, ?, ?)').run(role, text, ts);
  }

  recentTurns(n: number): Turn[] {
    const rows = this.db.prepare('SELECT role, text, ts FROM turns ORDER BY id DESC LIMIT ?').all(n) as unknown as Turn[];
    return rows.map((r) => ({ role: r.role, text: r.text, ts: Number(r.ts) })).reverse();
  }

  clearTurns(): void {
    this.db.exec('DELETE FROM turns');
  }

  getState<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as unknown as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setState(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  logNudge(n: { id: string; ts: number; kind: string; text: string }): void {
    this.db.prepare('INSERT INTO nudges (id, ts, kind, text) VALUES (?, ?, ?, ?)').run(n.id, n.ts, n.kind, n.text);
  }

  setNudgeOutcome(id: string, outcome: NudgeOutcome): void {
    this.db.prepare('UPDATE nudges SET outcome = ? WHERE id = ?').run(outcome, id);
  }

  nudgeOutcome(id: string): NudgeOutcome | null | undefined {
    const row = this.db.prepare('SELECT outcome FROM nudges WHERE id = ?').get(id) as unknown as { outcome: NudgeOutcome | null } | undefined;
    return row === undefined ? undefined : row.outcome;
  }

  addFact(text: string, ts: number): void {
    this.db.prepare('INSERT INTO facts (text, ts) VALUES (?, ?) ON CONFLICT(text) DO UPDATE SET ts = excluded.ts').run(text, ts);
  }

  facts(limit = 20): string[] {
    const rows = this.db.prepare('SELECT text FROM facts ORDER BY ts DESC LIMIT ?').all(limit) as unknown as { text: string }[];
    return rows.map((r) => r.text);
  }

  close(): void {
    this.db.close();
  }
}
