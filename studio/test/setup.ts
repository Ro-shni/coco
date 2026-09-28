import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// AUTH deviation from the brief: there are no cookies. Every /api call needs a bearer session token read
// from sessionStorage['coco_studio_session']. Stub a valid token before each test so the existing
// fetch-mock-based tests (which never touch sessionStorage themselves) keep working unmodified; tests that
// care about the missing-token / expired-session paths override this explicitly.
beforeEach(() => { sessionStorage.setItem('coco_studio_session', 'test-session-token'); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
