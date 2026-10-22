import { defineConfig } from 'drizzle-kit';

// Migration scope is intentionally limited to the Better Auth tables.
// Deployment migrations are owned by the checked SQL runner in apps/api.
// This config generates auth metadata offline; it never requests credentials,
// alters TLS settings, or includes encrypted health/Timescale policy DDL.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/auth.ts',
  out: './drizzle'
});
