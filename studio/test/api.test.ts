import { describe, expect, it, vi } from 'vitest';
import { api, hasSession, SessionExpiredError } from '../src/api';

// AUTH deviation from the brief: there are no cookies. `api()` reads the session token from
// sessionStorage['coco_studio_session'] and sends it as `Authorization: Bearer <token>` on every call.
describe('api', () => {
  it('sends Authorization: Bearer <token> from sessionStorage on every call', async () => {
    sessionStorage.setItem('coco_studio_session', 'tok-123');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ brain: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api('GET', '/api/health');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/health');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-123');
    expect(init?.credentials).toBeUndefined(); // never cookie-based
  });

  it('throws SessionExpiredError and never calls fetch when no token is present', async () => {
    sessionStorage.clear();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('GET', '/api/health')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hasSession()).toBe(false);
  });

  it('throws SessionExpiredError on a 401 response', async () => {
    sessionStorage.setItem('coco_studio_session', 'stale-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_token' }), { status: 401 })));

    await expect(api('GET', '/api/health')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('notifies onSessionExpired subscribers on a 401 response', async () => {
    sessionStorage.setItem('coco_studio_session', 'stale-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_token' }), { status: 401 })));
    const { onSessionExpired } = await import('../src/api');
    const cb = vi.fn();
    const unsubscribe = onSessionExpired(cb);
    try {
      await expect(api('GET', '/api/health')).rejects.toBeInstanceOf(SessionExpiredError);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
