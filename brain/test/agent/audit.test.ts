import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/agent/audit.js';

const db = () => join(mkdtempSync(join(tmpdir(), 'coco-audit-')), 'coco.db');

describe('AuditLog', () => {
  it('records and lists newest first', () => {
    const a = new AuditLog(db());
    a.record({ ts: 1, serverId: 'atlassian', tool: 'getJiraIssue', decision: 'auto', ok: true, ms: 120, resultChars: 900 });
    a.record({ ts: 2, serverId: 'atlassian', tool: 'createJiraIssue', decision: 'denied', ok: null, ms: null, resultChars: null });
    expect(a.list().map((r) => r.tool)).toEqual(['createJiraIssue', 'getJiraIssue']);
    expect(a.list({ decision: 'auto' })).toHaveLength(1);
    expect(a.list({ serverId: 'nope' })).toEqual([]);
  });

  it('stores args only when storeArgs is on', () => {
    const off = new AuditLog(db());
    off.record({ ts: 1, serverId: 's', tool: 't', decision: 'auto', ok: true, ms: 1, resultChars: 1, args: { key: 'SECRET-ish' } });
    expect(off.list()[0]!.args).toBeUndefined();
    const on = new AuditLog(db(), { storeArgs: true });
    on.record({ ts: 1, serverId: 's', tool: 't', decision: 'auto', ok: true, ms: 1, resultChars: 1, args: { key: 'K-1' } });
    expect(on.list()[0]!.args).toBe('{"key":"K-1"}');
  });

  it('M4: clamps a caller-supplied limit to 1..1000, and treats a non-finite limit as the 200 default', () => {
    const a = new AuditLog(db());
    for (let i = 0; i < 5; i++) a.record({ ts: i, serverId: 's', tool: 't', decision: 'auto', ok: true, ms: 1, resultChars: 1 });
    expect(a.list({ limit: -5 })).toHaveLength(1);
    expect(a.list({ limit: 0 })).toHaveLength(1);
    expect(a.list({ limit: Number.NaN })).toHaveLength(5);
    expect(a.list({ limit: Number.POSITIVE_INFINITY })).toHaveLength(5);
    expect(a.list({ limit: 2.9 })).toHaveLength(2);
  });
});
