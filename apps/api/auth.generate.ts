// Loaded ONLY by the Better Auth CLI to generate the drizzle schema:
//   pnpm dlx auth@latest generate --adapter drizzle --dialect postgresql \
//     --config apps/api/auth.generate.ts --output packages/db/src/schema/auth.ts
//
// The runtime auth instance is created per request in src/auth.ts (Workers
// don't benefit from a module singleton, and the db pool is request-scoped).
// The connection string here is never dialed — pg.Pool connects lazily and
// schema generation reads no data.
import { createDb } from '@burn-rate/db';
import { createAuth } from './src/auth';

const { db } = createDb('postgresql://schema-generation@localhost:5432/generate', { max: 1 });

export const auth = createAuth(db, { BETTER_AUTH_SECRET: 'schema-generation-only' });
