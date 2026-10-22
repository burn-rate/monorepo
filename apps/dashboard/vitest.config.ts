import { defineConfig } from 'vitest/config';

// Pure browser-client helpers do not need the Svelte/Cloudflare dev server.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'threads' } });
