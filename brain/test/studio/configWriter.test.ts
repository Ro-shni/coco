import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

  it('creates a fresh file when none exists', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'coco-cw-')), 'config.yaml');
    appendScanDir(p, '/a');
    expect(readFileSync(p, 'utf8')).toContain('/a');
  });

  it('preserves the existing file mode (M9)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'coco-cw-')), 'config.yaml');
    writeFileSync(p, 'debug: true\n', { mode: 0o640 });
    appendScanDir(p, '/a');
    expect(statSync(p).mode & 0o777).toBe(0o640);
  });

  it('tolerates a scalar `connectors:` value (M9)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'coco-cw-')), 'config.yaml');
    writeFileSync(p, 'debug: true   # keep me\nconnectors: legacy\n');
    expect(() => appendScanDir(p, '/a')).not.toThrow();
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('/a');
  });

  it('tolerates a null `connectors:` value (M9)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'coco-cw-')), 'config.yaml');
    writeFileSync(p, 'connectors:\n');
    expect(() => appendScanDir(p, '/a')).not.toThrow();
    expect(readFileSync(p, 'utf8')).toContain('/a');
  });
});
