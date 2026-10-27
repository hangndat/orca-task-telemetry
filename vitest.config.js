import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // Integration CLI fixtures regularly exceed the 5s default under parallel load.
    testTimeout: 30_000,
  },
});
