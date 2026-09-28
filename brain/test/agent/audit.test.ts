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
});
