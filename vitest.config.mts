import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mirrors tsconfig's "@/*" so tests can import modules that use it.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
