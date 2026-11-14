import { describe, expect, it } from 'vitest';
import { createLogger, silentLogger } from '../src/logger.js';

describe('createLogger', () => {
  it('writes one JSON line per event with level, event and fields', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.warn('nudge_rejected', { attempt: 1 });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: 'warn', event: 'nudge_rejected', attempt: 1 });
    expect(typeof parsed.ts).toBe('string');
  });

  it('silentLogger does nothing', () => {
    expect(() => silentLogger.error('x')).not.toThrow();
  });
});
