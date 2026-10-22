import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/server/src/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'tools/*/src/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        // Barrel files that only re-export.
        'packages/{doc-model,renderer,room,sync-client}/src/index.ts',
        // Canvas drawing needs a browser; the E2E and /bench runs cover it.
        'packages/renderer/src/draw.ts',
      ],
      thresholds: { lines: 85, functions: 85 },
    },
  },
});
