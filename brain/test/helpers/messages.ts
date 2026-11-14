import type { ContextMsg } from '../../src/protocol.js';

export const T0 = Date.UTC(2026, 8, 24, 4, 30, 0); // fixed epoch for deterministic tests

export function ctx(overrides: Partial<ContextMsg> = {}): ContextMsg {
  return {
    v: 1,
    type: 'context',
    app: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    windowTitle: 'supply-prd latency - Grafana',
    url: 'https://grafana.example.com/d/abc',
    ocrText: 'p99 latency 900ms 10:40',
    private: false,
    ts: T0,
    ...overrides,
  };
}
