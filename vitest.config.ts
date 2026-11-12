import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    env: { LOG_LEVEL: 'error' },
    setupFiles: ['src/__tests__/setup.ts'],
  },
});
