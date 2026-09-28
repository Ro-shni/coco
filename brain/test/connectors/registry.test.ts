import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectorRegistry, DeniedHostError, uniqueId } from '../../src/connectors/registry.js';
import type { ServerConfig } from '../../src/connectors/types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'coco-reg-'));
const kubectl: ServerConfig = {
  id: 'kubectl-readonly', name: 'kubectl-readonly', transport: 'stdio', command: '/usr/bin/python3',
  args: ['-m', 'kubectl_mcp_tool.mcp_server', '--read-only'], envSecrets: ['KUBECONFIG'], headerSecrets: [],
  auth: 'none', enabled: true, source: 'imported', readOnly: true,
};

describe('ConnectorRegistry', () => {
  it('starts empty when no files exist', () => {
    expect(new ConnectorRegistry(dir()).list()).toEqual([]);
  });

  it('upserts, persists atomically and reloads', () => {
    const d = dir();
    const r = new ConnectorRegistry(d);
    r.upsert(kubectl);
    expect(existsSync(join(d, 'connectors.yaml'))).toBe(true);
    expect(existsSync(join(d, 'connectors.yaml.tmp'))).toBe(false);
    expect(new ConnectorRegistry(d).get('kubectl-readonly')).toEqual(kubectl);
  });

  it('never writes secret values — only names', () => {
    const d = dir();
    new ConnectorRegistry(d).upsert(kubectl);
    const text = readFileSync(join(d, 'connectors.yaml'), 'utf8');
    expect(text).toContain('KUBECONFIG');
    expect(text).not.toMatch(/kubeconfig\s*[:=]\s*\//i);
  });

  it('refuses a denied host', () => {
    const r = new ConnectorRegistry(dir());
    expect(() =>
      r.upsert({ ...kubectl, id: 'bifrost', transport: 'http', command: undefined, url: 'http://ai-gateway.prd.meesho.int/mcp' }),
    ).toThrow(DeniedHostError);
  });

  it('rejects an invalid config', () => {
    const r = new ConnectorRegistry(dir());
    expect(() => r.upsert({ ...kubectl, command: undefined })).toThrow();
  });

  it('removes a server and its autonomy overrides', () => {
    const d = dir();
    const r = new ConnectorRegistry(d);
    r.upsert(kubectl);
    r.setAutonomy('kubectl-readonly__get_pods', 'confirm');
    r.remove('kubectl-readonly');
    expect(r.list()).toEqual([]);
    expect(r.autonomy('kubectl-readonly__get_pods')).toBeUndefined();
  });

  it('stores per-tool autonomy overrides in autonomy.yaml', () => {
    const d = dir();
    new ConnectorRegistry(d).setAutonomy('atlassian__createJiraIssue', 'off');
    expect(new ConnectorRegistry(d).autonomy('atlassian__createJiraIssue')).toBe('off');
  });

  it('skips (does not crash on) a corrupt entry in connectors.yaml', () => {
    const d = dir();
    writeFileSync(join(d, 'connectors.yaml'), 'servers:\n  - id: "BAD ID"\n    name: x\n');
    expect(new ConnectorRegistry(d).list()).toEqual([]);
  });

  it('uniqueId slugifies and de-duplicates', () => {
    expect(uniqueId('Kubectl ReadOnly!', new Set())).toBe('kubectl-readonly');
    expect(uniqueId('qmd', new Set(['qmd']))).toBe('qmd-2');
    expect(uniqueId('qmd', new Set(['qmd', 'qmd-2']))).toBe('qmd-3');
  });

  it('degrades gracefully when connectors.yaml has invalid YAML syntax', () => {
    const d = dir();
    writeFileSync(join(d, 'connectors.yaml'), 'servers:\n  - [invalid: {yaml: syntax');
    expect(new ConnectorRegistry(d).list()).toEqual([]);
  });

  it('degrades gracefully when autonomy.yaml has invalid YAML syntax', () => {
    const d = dir();
    writeFileSync(join(d, 'autonomy.yaml'), 'tools:\n  - [invalid: {yaml: syntax');
    expect(new ConnectorRegistry(d).autonomy('foo__bar')).toBeUndefined();
  });

  it('reports imported discovery keys', () => {
    const r = new ConnectorRegistry(dir());
    r.upsert({ ...kubectl, importKey: 'abc123' });
    expect(r.importedKeys()).toEqual(new Set(['abc123']));
  });
});
