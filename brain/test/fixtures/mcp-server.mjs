#!/usr/bin/env node
// A tiny real MCP server over stdio for connector tests. Tools: echo, hang (never returns), crash (exits).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo:${text}:${process.env.FIXTURE_SECRET ?? 'nosecret'}` }],
}));
server.registerTool('hang', { description: 'Never returns' }, () => new Promise(() => {}));
server.registerTool('crash', { description: 'Exits the process' }, () => process.exit(3));
await server.connect(new StdioServerTransport());
