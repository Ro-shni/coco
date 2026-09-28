import { DatabaseSync } from 'node:sqlite';

export type AuditDecision = 'auto' | 'confirmed' | 'denied' | 'off' | 'expired';
export interface AuditRow {
  id: number; ts: number; serverId: string; tool: string; decision: AuditDecision;
  ok: boolean | null; ms: number | null; resultChars: number | null; args?: string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS tool_audit (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, server_id TEXT NOT NULL, tool TEXT NOT NULL, decision TEXT NOT NULL,
  ok INTEGER, ms INTEGER, result_chars INTEGER, args TEXT);
CREATE INDEX IF NOT EXISTS tool_audit_ts ON tool_audit(ts);`;

/** M4: a caller-supplied limit (e.g. from a Studio query string) is untrusted input. SQLite treats a negative
 * LIMIT as unlimited, and a NaN bind value is a hard error, so clamp to [1, 1000] and fall back to the 200
 * default for anything non-finite. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 200;
  return Math.max(1, Math.min(Math.trunc(limit), 1000));
}

export class AuditLog {
  private readonly db: DatabaseSync;
  constructor(dbPath: string, private readonly opts: { storeArgs?: boolean } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  record(r: Omit<AuditRow, 'id' | 'args'> & { args?: Record<string, unknown> }): number {
    const args = this.opts.storeArgs && r.args ? JSON.stringify(r.args) : null;
    const res = this.db
      .prepare('INSERT INTO tool_audit (ts, server_id, tool, decision, ok, ms, result_chars, args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.ts, r.serverId, r.tool, r.decision, r.ok === null ? null : r.ok ? 1 : 0, r.ms, r.resultChars, args);
    return Number(res.lastInsertRowid);
  }

  list(opts: { limit?: number; serverId?: string; decision?: AuditDecision } = {}): AuditRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.serverId) { where.push('server_id = ?'); params.push(opts.serverId); }
    if (opts.decision) { where.push('decision = ?'); params.push(opts.decision); }
    const sql = `SELECT * FROM tool_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, clampLimit(opts.limit)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), ts: Number(r.ts), serverId: String(r.server_id), tool: String(r.tool), decision: r.decision as AuditDecision,
      ok: r.ok === null ? null : Number(r.ok) === 1, ms: r.ms === null ? null : Number(r.ms),
      resultChars: r.result_chars === null ? null : Number(r.result_chars),
      ...(r.args !== null ? { args: String(r.args) } : {}),
    }));
  }

  close(): void { this.db.close(); }
}
