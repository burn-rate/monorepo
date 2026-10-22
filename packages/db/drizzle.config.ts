import { defineConfig } from 'drizzle-kit';

// Migration scope is intentionally limited to the Better Auth tables.
// The health hypertable and its Timescale policies are managed by raw SQL
// (apps/api/timescale/001_init.sql) and must not be diffed by drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/auth.ts',
  out: './drizzle',
  dbCredentials: {
    // pg 8 treats sslmode=require as verify-full and Tiger Cloud's chain is
    // not in local trust stores (the Worker avoids this via the Hyperdrive
    // proxy). uselibpqcompat restores psql `sslmode=require` semantics:
    // encrypt, don't verify.
    url: (() => {
      const url = new URL(process.env.DATABASE_URL ?? '');
      url.searchParams.set('uselibpqcompat', 'true');
      return url.toString();
    })()
  }
});
