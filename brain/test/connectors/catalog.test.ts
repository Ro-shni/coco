import { describe, expect, it } from 'vitest';
import { catalogToConfig, loadCatalog } from '../../src/connectors/catalog.js';
import { isDeniedHost } from '../../src/connectors/hosts.js';

describe('catalog', () => {
  it('loads and validates every entry; no prod hosts; npx packages are version-pinned', () => {
    const entries = loadCatalog();
    expect(entries.map((e) => e.id)).toEqual(['atlassian', 'slack', 'github', 'grafana', 'filesystem']);
    for (const e of entries) {
      if (e.url) expect(isDeniedHost(e.url)).toBe(false);
      if (e.command === 'npx') expect(e.args!.find((a) => a.startsWith('@'))).toMatch(/@\d/);
    }
  });

  it('maps an OAuth entry with a Client ID', () => {
    const slack = loadCatalog().find((e) => e.id === 'slack')!;
    expect(catalogToConfig(slack, new Set(), { clientId: '123.456' })).toMatchObject({
      id: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp', auth: 'oauth', oauthClientId: '123.456', source: 'catalog',
    });
  });

  it('requires a Client ID when the entry needs one', () => {
    const slack = loadCatalog().find((e) => e.id === 'slack')!;
    expect(() => catalogToConfig(slack, new Set(), {})).toThrow(/Client ID/);
  });

  it('appends user folders to filesystem args and records header/env names', () => {
    const fs = loadCatalog().find((e) => e.id === 'filesystem')!;
    expect(catalogToConfig(fs, new Set(), { args: ['/Users/me/notes'] }).args).toEqual(['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', '/Users/me/notes']);
    const gh = loadCatalog().find((e) => e.id === 'github')!;
    expect(catalogToConfig(gh, new Set(), { headers: { Authorization: 'Bearer x' } }).headerSecrets).toEqual(['Authorization']);
  });
});
