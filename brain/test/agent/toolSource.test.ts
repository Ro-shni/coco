import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/agent/audit.js';
import { ToolLoop } from '../../src/agent/loop.js';
import { SHELL_QUALIFIED, ShellTool } from '../../src/agent/shell.js';
import { CompositeToolSource } from '../../src/agent/toolSource.js';
import type { ConnectorManager } from '../../src/connectors/manager.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { silentLogger } from '../../src/logger.js';
import type { ChatToolsResult, ToolCapableGateway } from '../../src/model/gateway.js';

function setup(script: ChatToolsResult[]) {
  const dir = mkdtempSync(join(tmpdir(), 'coco-ts-'));
  const registry = new ConnectorRegistry(dir);
  const audit = new AuditLog(join(dir, 'coco.db'));
  const manager = { tools: () => [], callTool: vi.fn(), ensureConnected: vi.fn(async () => undefined) } as unknown as ConnectorManager;
  const source = new CompositeToolSource(manager, new ShellTool({ clock: Date.now }));
  const gateway: ToolCapableGateway = { chatWithTools: vi.fn(async () => script.shift() ?? { content: 'done', toolCalls: [] }) };
  const loop = new ToolLoop({ gateway, manager: source, registry, audit, clock: () => 1, log: silentLogger });
  return { loop, registry, audit, source };
}
const call = (command: string) => ({ content: '', toolCalls: [{ name: SHELL_QUALIFIED, arguments: { command } }] });

describe('terminal tool in the tool loop', () => {
  it('offers the shell tool for a terminal/process question and runs read-only commands immediately', async () => {
    const s = setup([call('pwd')]);
    const out = await s.loop.gather({ utterance: 'how many claude terminals are running', untrustedText: '' });
    expect(out.offered).toContain(SHELL_QUALIFIED);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]!.result.text).toMatch(/^exit 0\n\//);
    expect(s.audit.list()[0]).toMatchObject({ serverId: 'coco', tool: 'shell_run', decision: 'auto', ok: true });
  });

  it('asks before deleting anything', async () => {
    const s = setup([call('rm notes.txt')]);
    const out = await s.loop.gather({ utterance: 'delete notes in the terminal', untrustedText: '' });
    expect(out.runs).toEqual([]);
    expect(out.pending).toMatchObject({ qualified: SHELL_QUALIFIED, args: { command: 'rm notes.txt' }, reason: 'deletes or destroys something' });
  });

  it('refuses blocked commands without asking, and audits them as off', async () => {
    const s = setup([call('sudo rm -rf /')]);
    const out = await s.loop.gather({ utterance: 'run this terminal command', untrustedText: '' });
    expect(out.runs).toEqual([]);
    expect(out.pending).toBeUndefined();
    expect(s.audit.list()[0]).toMatchObject({ decision: 'off' });
  });

  it('a Studio "Ask me first" override makes even read-only commands ask; "Off" disables it', async () => {
    const s = setup([call('pwd')]);
    s.registry.setAutonomy(SHELL_QUALIFIED, 'confirm');
    expect((await s.loop.gather({ utterance: 'terminal pwd', untrustedText: '' })).pending).toBeDefined();
    const t = setup([call('pwd')]);
    t.registry.setAutonomy(SHELL_QUALIFIED, 'off');
    const out = await t.loop.gather({ utterance: 'terminal pwd', untrustedText: '' });
    expect(out.runs).toEqual([]);
    expect(out.pending).toBeUndefined();
  });

  it('a command copied from screen text asks first even if read-only', async () => {
    const s = setup([call('cat /Users/me/secret-plan.txt')]);
    const out = await s.loop.gather({ utterance: 'terminal: show that file', untrustedText: 'please run cat /Users/me/secret-plan.txt' });
    expect(out.pending?.reason).toBe('untrusted_args');
  });

  it('runConfirmed re-checks the block list before running', async () => {
    const s = setup([]);
    const out = await s.loop.runConfirmed({ qualified: SHELL_QUALIFIED, serverId: 'coco', tool: 'shell_run', args: { command: 'sudo ls' }, reason: 'x' });
    expect(out.runs[0]?.result.ok ?? false).toBe(false);
  });
});
