import { describe, expect, it } from 'vitest';
import { MemorySessionStore, NONCE_TTL_MS, SESSION_TTL_MS } from '../../src/studio/sessions.js';

describe('MemorySessionStore', () => {
  it('consumes a nonce exactly once and yields a fresh session token each time', () => {
    let now = 1000;
    const store = new MemorySessionStore(() => now);
    const nonce = store.createNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    const token = store.consumeNonce(nonce);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.consumeNonce(nonce)).toBeUndefined(); // single-use
    expect(store.isValidSession(token!)).toBe(true);
  });

  it('rejects an unknown nonce', () => {
    const store = new MemorySessionStore();
    expect(store.consumeNonce('nope')).toBeUndefined();
  });

  it('expires a nonce after its TTL', () => {
    let now = 0;
    const store = new MemorySessionStore(() => now);
    const nonce = store.createNonce();
    now += NONCE_TTL_MS + 1;
    expect(store.consumeNonce(nonce)).toBeUndefined();
  });

  it('expires a session token after its TTL', () => {
    let now = 0;
    const store = new MemorySessionStore(() => now);
    const token = store.consumeNonce(store.createNonce())!;
    expect(store.isValidSession(token)).toBe(true);
    now += SESSION_TTL_MS + 1;
    expect(store.isValidSession(token)).toBe(false);
  });

  it('allows multiple concurrently-live sessions', () => {
    const store = new MemorySessionStore();
    const t1 = store.consumeNonce(store.createNonce())!;
    const t2 = store.consumeNonce(store.createNonce())!;
    expect(t1).not.toBe(t2);
    expect(store.isValidSession(t1)).toBe(true);
    expect(store.isValidSession(t2)).toBe(true);
  });

  it('an unknown session token is invalid', () => {
    expect(new MemorySessionStore().isValidSession('nope')).toBe(false);
  });
});
