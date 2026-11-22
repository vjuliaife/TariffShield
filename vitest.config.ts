import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['apps/web/components/**/*.test.{ts,tsx}'],
    setupFiles: ['./apps/web/test/setup.ts'],
  },
});
