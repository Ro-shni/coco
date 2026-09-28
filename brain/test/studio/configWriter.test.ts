import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendScanDir } from '../../src/studio/configWriter.js';

describe('appendScanDir', () => {
  it('preserves comments and de-duplicates', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'coco-cw-')), 'config.yaml');
    writeFileSync(p, 'debug:\n  trace: true   # keep me\n');
    appendScanDir(p, '/a');
    appendScanDir(p, '/a');
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('# keep me');
    expect(text.match(/\/a/g)).toHaveLength(1);
  });
});
