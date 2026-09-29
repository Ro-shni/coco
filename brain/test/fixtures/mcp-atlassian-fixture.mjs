#!/usr/bin/env node
// A fake Atlassian-style MCP server: tools need a cloudId that getAccessibleAtlassianResources returns.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'atlassian-fixture', version: '1.0.0' });
server.registerTool('getAccessibleAtlassianResources', { description: 'List Atlassian sites you can access' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify([{ id: 'cloud-123', url: 'https://meesho.atlassian.net', name: 'meesho' }]) }],
}));
server.registerTool('searchConfluenceUsingCql', { description: 'Search Confluence pages with CQL', inputSchema: { cloudId: z.string(), cql: z.string() } },
  async ({ cloudId, cql }) => ({ content: [{ type: 'text', text: `searched ${cloudId} for ${cql}` }] }));
await server.connect(new StdioServerTransport());
