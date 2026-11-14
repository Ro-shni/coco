import { describe, expect, it } from 'vitest';
import { narrowTools } from '../../src/agent/narrow.js';
import type { ToolInfo } from '../../src/connectors/types.js';

const t = (serverId: string, name: string, description: string): ToolInfo => ({
  serverId, name, qualified: `${serverId}__${name}`, description, inputSchema: { type: 'object' },
});
const TOOLS = [
  t('atlassian', 'getJiraIssue', 'Get a Jira issue by key'),
  t('atlassian', 'searchConfluenceUsingCql', 'Search Confluence pages with CQL'),
  t('atlassian', 'createJiraIssue', 'Create a new Jira issue'),
  t('kubectl-readonly', 'get_pods', 'List pods in a namespace'),
  t('kubectl-readonly', 'get_logs', 'Get logs for a pod'),
  t('qmd', 'search', 'Search local markdown notes'),
];

describe('narrowTools', () => {
  it('ranks the Jira getter first for an issue-status question', () => {
    const out = narrowTools("what's the status of jira issue DEVOPS-35236", TOOLS);
    expect(out[0]!.qualified).toBe('atlassian__getJiraIssue');
  });

  it('finds kubectl tools for pods/logs questions', () => {
    const names = narrowTools('show me logs for the crashing pod', TOOLS).map((x) => x.qualified);
    expect(names.slice(0, 2).sort()).toEqual(['kubectl-readonly__get_logs', 'kubectl-readonly__get_pods']);
  });

  it('returns nothing for chit-chat', () => {
    expect(narrowTools('haha you are funny', TOOLS)).toEqual([]);
  });

  it('caps the result', () => {
    const many = Array.from({ length: 20 }, (_, i) => t('s', `search${i}`, 'search things'));
    expect(narrowTools('search things', many)).toHaveLength(6);
  });
});
