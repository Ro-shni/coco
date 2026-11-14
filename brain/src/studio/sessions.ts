import { randomToken } from './auth.js';

const NONCE_BYTES = 32;
const SESSION_BYTES = 32;
export const NONCE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionStore {
  /** One-time, 60 s-TTL launch nonce. Only the holder of the primary Studio token may create one. */
  createNonce(): string;
  /** Single-use: valid or not, the nonce is gone after this call. Returns a fresh 12 h session token on success. */
  consumeNonce(nonce: string): string | undefined;
  /** True while the session token is live (not expired, not otherwise removed). Multiple sessions may be live at once. */
  isValidSession(token: string): boolean;
}

/** In-memory only — sessions and nonces never touch disk, and do not survive a brain restart. */
export class MemorySessionStore implements SessionStore {
  private readonly nonces = new Map<string, number>(); // nonce -> expiresAt
  private readonly sessions = new Map<string, number>(); // token -> expiresAt

  constructor(private readonly clock: () => number = Date.now) {}

  createNonce(): string {
    this.prune();
    const nonce = randomToken(NONCE_BYTES);
    this.nonces.set(nonce, this.clock() + NONCE_TTL_MS);
    return nonce;
  }

  consumeNonce(nonce: string): string | undefined {
    const expiresAt = this.nonces.get(nonce);
    this.nonces.delete(nonce); // single-use: gone whether it was valid or not
    if (expiresAt === undefined || expiresAt < this.clock()) return undefined;
    const token = randomToken(SESSION_BYTES);
    this.sessions.set(token, this.clock() + SESSION_TTL_MS);
    return token;
  }

  isValidSession(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt < this.clock()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private prune(): void {
    const now = this.clock();
    for (const [k, v] of this.nonces) if (v < now) this.nonces.delete(k);
    for (const [k, v] of this.sessions) if (v < now) this.sessions.delete(k);
  }
}
