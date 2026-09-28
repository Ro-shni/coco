/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/studio/',
  plugins: [react()],
  build: { outDir: '../brain/dist/studio', emptyOutDir: true, sourcemap: false },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'] },
});
