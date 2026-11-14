/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  base: '/studio/',
  plugins: [react()],
  build: { outDir: '../brain/dist/studio-web', emptyOutDir: true, sourcemap: false },
  // `e2e/` holds Playwright specs (Task 14) — vitest's default glob also matches `*.spec.ts`, so it must be
  // excluded here or `npm test` tries to run them as unit tests and fails (no Playwright test runner context).
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'], exclude: [...configDefaults.exclude, 'e2e/**'] },
});
