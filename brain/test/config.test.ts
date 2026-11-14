import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, FALLBACK_PERSONA, PersonaFile, loadConfig } from '../src/config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'coco-config-'));

describe('loadConfig', () => {
  it('returns defaults when config.yaml is missing', () => {
    expect(loadConfig(tmp())).toEqual(DEFAULT_CONFIG);
  });

  it('deep-merges user values over defaults without mutating DEFAULT_CONFIG', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yaml'), 'nudge:\n  minGapSec: 240\nuser:\n  name: Roshni\n');
    const cfg = loadConfig(dir);
    expect(cfg.nudge.minGapSec).toBe(240);
    expect(cfg.nudge.tickMinSec).toBe(DEFAULT_CONFIG.nudge.tickMinSec);
    expect(cfg.user.name).toBe('Roshni');
    expect(DEFAULT_CONFIG.nudge.minGapSec).toBe(180);
  });

  it('treats an empty file as defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yaml'), '');
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it('throws a readable error for invalid values', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yaml'), 'nudge:\n  minGapSec: 5\n');
    expect(() => loadConfig(dir)).toThrow(/Invalid config\.yaml.*minGapSec/s);
  });

  it('rejects tickMaxSec smaller than tickMinSec', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yaml'), 'nudge:\n  tickMinSec: 30\n  tickMaxSec: 20\n');
    expect(() => loadConfig(dir)).toThrow(/tickMaxSec/);
  });

  it('defaults voice to enabled, speakNudges on, speakTypedReplies off', () => {
    expect(loadConfig(tmp()).voice).toEqual({ enabled: true, speakNudges: true, speakTypedReplies: false });
  });

  it('deep-merges a partial voice override from config.yaml', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yaml'), 'voice:\n  enabled: false\n  speakTypedReplies: true\n');
    const cfg = loadConfig(dir);
    expect(cfg.voice).toEqual({ enabled: false, speakNudges: true, speakTypedReplies: true });
    expect(DEFAULT_CONFIG.voice).toEqual({ enabled: true, speakNudges: true, speakTypedReplies: false });
  });

  it('defaults connectors.scanDirs to an empty list', () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), 'coco-cfg-'))).connectors.scanDirs).toEqual([]);
  });
});

describe('PersonaFile', () => {
  it('returns the fallback persona when the file is missing', () => {
    expect(new PersonaFile(join(tmp(), 'persona.md')).get()).toBe(FALLBACK_PERSONA);
  });

  it('reloads when the file changes on disk', () => {
    const path = join(tmp(), 'persona.md');
    writeFileSync(path, 'v1');
    const persona = new PersonaFile(path);
    expect(persona.get()).toBe('v1');
    writeFileSync(path, 'v2');
    const future = new Date(Date.now() + 5000);
    utimesSync(path, future, future);
    expect(persona.get()).toBe('v2');
  });
});
