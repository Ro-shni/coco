import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

let brain: ChildProcess;
let base = '';
let studioToken = '';

test.beforeAll(async () => {
  brain = spawn(process.execPath, [fileURLToPath(new URL('./boot-brain.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
  const line = await new Promise<string>((resolve) => brain.stdout!.once('data', (d: Buffer) => resolve(d.toString().split('\n')[0]!)));
  const info = JSON.parse(line) as { port: number; studioToken: string };
  base = `http://127.0.0.1:${info.port}`;
  studioToken = info.studioToken;
});
test.afterAll(() => { brain.stdin!.end(); brain.kill(); });

// AUTH deviation from the brief (task-14 dispatch): no cookies, no `?t=` launch link. Mint a one-time launch
// nonce with the permanent Studio token, then load /studio/launch?n=<nonce> — its inline script exchanges the
// nonce for a session token (stored in sessionStorage) and redirects to /studio/.
async function launch(request: APIRequestContext, page: Page): Promise<void> {
  const res = await request.post(`${base}/api/launch-nonce`, { headers: { authorization: `Bearer ${studioToken}` } });
  expect(res.ok()).toBeTruthy();
  const { nonce } = (await res.json()) as { nonce: string };
  await page.goto(`${base}/studio/launch?n=${nonce}`);
  await expect(page.getByText('Coco Studio').first()).toBeVisible();
}

test('launch → import the discovered fixture server → it connects and a tool test works', async ({ page, request }) => {
  await launch(request, page);
  await page.getByRole('button', { name: 'Connectors' }).click();
  await page.getByTestId('discovered-fixture').getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('dialog')).toContainText('mcp-server.mjs');
  await page.getByRole('button', { name: 'Run this server' }).click();
  const card = page.getByTestId('connector-fixture');
  // The manager connects in the background; reload until the tools appear.
  await expect(async () => {
    await page.reload();
    await expect(card.getByText('echo', { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const echo = card.locator('li.tool', { hasText: 'Echo text back' });
  await echo.getByRole('button', { name: 'Test' }).click();
  await echo.getByLabel('Arguments for echo').fill('{"text":"hi"}');
  await echo.getByRole('button', { name: 'Run test' }).click();
  await expect(echo.locator('pre.result')).toContainText('echo:hi');
});

test('Activity lists the audited test run', async ({ page, request }) => {
  await launch(request, page);
  await page.getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'echo' })).toHaveCount(1);
});

test('the API refuses a request without a token', async ({ request }) => {
  const res = await request.get(`${base}/api/health`);
  expect(res.status()).toBe(401);
});
