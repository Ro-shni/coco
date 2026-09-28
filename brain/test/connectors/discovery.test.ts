import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discover, readSecretsFor, toServerConfig } from '../../src/connectors/discovery.js';

const FX = join(import.meta.dirname, '..', 'fixtures');
const run = (importedKeys: Set<string> = new Set()) =>
  discover({ claudeJsonPath: join(FX, 'claude.json'), scanDirs: [FX], importedKeys });

describe('discover', () => {
  it('finds every server once, deduplicated across files', () => {
    const names = run().map((s) => s.name).sort();
    expect(names).toEqual(['atlassian', 'bifrost', 'isdb', 'kubectl-readonly', 'legacy', 'qmd']);
    const bifrost = run().find((s) => s.name === 'bifrost')!;
    expect(bifrost.foundIn).toHaveLength(2);
    expect(run().find((s) => s.name === 'qmd')!.foundIn).toHaveLength(2);
  });

  it('classifies status', () => {
    const by = Object.fromEntries(run().map((s) => [s.name, s.status]));
    expect(by).toEqual({
      bifrost: 'blocked_host',
      'kubectl-readonly': 'importable',
      atlassian: 'importable',
      qmd: 'importable',
      isdb: 'unsupported_variable',
      legacy: 'unsupported_transport',
    });
  });

  it('marks already-imported servers by key', () => {
    const qmdKey = run().find((s) => s.name === 'qmd')!.key;
    expect(run(new Set([qmdKey])).find((s) => s.name === 'qmd')!.status).toBe('already_imported');
  });

  it('exposes only secret NAMES, never values', () => {
    const json = JSON.stringify(run());
    expect(json).not.toContain('SECRET');
    expect(run().find((s) => s.name === 'kubectl-readonly')!.envNames).toEqual(['KUBECONFIG']);
    expect(run().find((s) => s.name === 'bifrost')!.headerNames).toEqual(['Authorization']);
  });

  it('detects read-only servers', () => {
    expect(run().find((s) => s.name === 'kubectl-readonly')!.readOnly).toBe(true);
    expect(run().find((s) => s.name === 'qmd')!.readOnly).toBe(false);
  });

  it('tolerates a missing or malformed claude.json and missing scan dirs', () => {
    expect(discover({ claudeJsonPath: '/nope/claude.json', scanDirs: ['/nope'], importedKeys: new Set() })).toEqual([]);
  });

  it('never modifies the source files', () => {
    const before = readFileSync(join(FX, 'claude.json'), 'utf8');
    run();
    expect(readFileSync(join(FX, 'claude.json'), 'utf8')).toBe(before);
  });
});

describe('readSecretsFor / toServerConfig', () => {
  it('re-reads secret values from the source file only when asked', () => {
    const k = run().find((s) => s.name === 'kubectl-readonly')!;
    expect(readSecretsFor(k)).toEqual({ env: { KUBECONFIG: '/Users/me/.kube/SECRETPATH' }, headers: {} });
  });

  it('builds an imported ServerConfig with secret names, unique id and readOnly', () => {
    const k = run().find((s) => s.name === 'kubectl-readonly')!;
    expect(toServerConfig(k, new Set())).toEqual({
      id: 'kubectl-readonly', name: 'kubectl-readonly', transport: 'stdio', command: '/opt/kube/.venv/bin/python',
      args: ['-m', 'kubectl_mcp_tool.mcp_server', '--read-only', '--transport', 'stdio'],
      envSecrets: ['KUBECONFIG'], headerSecrets: [], auth: 'none', enabled: true, source: 'imported', importKey: k.key, readOnly: true,
    });
  });

  it('marks http servers without auth headers as oauth candidates', () => {
    const a = run().find((s) => s.name === 'atlassian')!;
    expect(toServerConfig(a, new Set()).auth).toBe('oauth');
  });
});
