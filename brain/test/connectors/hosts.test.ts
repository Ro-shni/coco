import { describe, expect, it } from 'vitest';
import { isDeniedHost } from '../../src/connectors/hosts.js';

describe('isDeniedHost', () => {
  it.each([
    ['http://ai-gateway.prd.meesho.int/mcp', true],
    ['http://devops-mcp-mvp.int.meesho.int/mcp', true],
    ['https://prd.meesho.int', true],
    ['http://x.int.mrouter.int:8080/a', true],
    ['https://mcp.atlassian.com/v1/mcp', false],
    ['http://127.0.0.1:7733/mcp', false],
    ['https://notprd.meesho.int.evil.com', false],
    ['https://myprd.meesho.int', false], // suffix match needs a dot boundary
    ['not a url', false],
    ['http://prd.meesho.int./x', true], // trailing dot should not bypass
    ['https://a.prd.meesho.int.:8443/', true], // trailing dot with subdomain should not bypass
  ])('%s → %s', (url, denied) => {
    expect(isDeniedHost(url)).toBe(denied);
  });
});
