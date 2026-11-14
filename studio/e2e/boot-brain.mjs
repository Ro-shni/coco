import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deviation from the brief (see task-14 dispatch): the brain now also starts an OAuth callback listener on
// connectors.oauthCallbackPort (default 47823), which may already be bound by the user's own running Coco.
// Pick a free port here (bind to port 0, read it back, close it) and write it into a config.yaml in the temp
// COCO_CONFIG_DIR so this test brain never collides with a real instance.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'coco-e2e-'));
const fixture = join(root, 'brain/test/fixtures/mcp-server.mjs');
writeFileSync(join(tmp, '.claude.json'), JSON.stringify({ mcpServers: { fixture: { type: 'stdio', command: process.execPath, args: [fixture] } } }));

const oauthCallbackPort = await freePort();
writeFileSync(join(tmp, 'config.yaml'), `connectors:\n  scanDirs: []\n  oauthCallbackPort: ${oauthCallbackPort}\n`);

const studioToken = randomBytes(24).toString('hex');
const child = spawn(process.execPath, [join(root, 'brain/dist/main.js')], {
  env: { ...process.env, HOME: tmp, COCO_TOKEN: randomBytes(24).toString('hex'), COCO_STUDIO_TOKEN: studioToken,
         COCO_CONFIG_DIR: tmp, COCO_DATA_DIR: tmp, COCO_LOGS_DIR: tmp },
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.stdout.on('data', (d) => {
  const m = /COCO_READY (\{.*\})/.exec(d.toString());
  if (m) process.stdout.write(`${JSON.stringify({ port: JSON.parse(m[1]).port, studioToken })}\n`);
});
process.stdin.on('end', () => child.kill());
process.stdin.resume();
