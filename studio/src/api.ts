// AUTH deviation from the brief: there are no cookies. After the launch page runs (brain/src/studio/http.ts),
// the session token lives in sessionStorage['coco_studio_session']. Every /api call sends it as
// `Authorization: Bearer <token>` — never `credentials: 'same-origin'` cookies, which this app never uses.
export class ApiError extends Error {}
export class SessionExpiredError extends Error {}

const SESSION_KEY = 'coco_studio_session';
const listeners = new Set<() => void>();

/** Registers a callback fired whenever a call finds no session token, or the brain answers 401. Returns an
 * unsubscribe function. The App shell uses this to swap the whole UI for the "session ended" message. */
export function onSessionExpired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function hasSession(): boolean {
  return readToken() !== null;
}

function expireSession(message: string): never {
  for (const listener of listeners) listener();
  throw new SessionExpiredError(message);
}

/** Swallows a SessionExpiredError (the App shell already reacted to it via onSessionExpired) while letting
 * any other error keep propagating. Use as `.catch(ignoreExpired)` on fire-and-forget calls. */
export function ignoreExpired(e: unknown): void {
  if (!(e instanceof SessionExpiredError)) throw e;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = readToken();
  if (!token) return expireSession('no session token');
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401) return expireSession('session expired');
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(json.error ?? `HTTP ${res.status}`);
  return json;
}
