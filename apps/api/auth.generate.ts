// Offline Better Auth schema-generator input. The runtime uses the same
// canonical user/session/account/verification/passkey names and snake-case
// columns as packages/db/src/schema/auth.ts, including passkey_verified_at.
// No environment files, production configuration, or database factory is used.
import { createAuth } from './src/auth';
import type { Sql } from './src/db';

const schemaOnlySql = {
  query: async () => { throw new Error('Offline auth schema generation must not execute database queries.'); }
} as unknown as Sql;

export const auth = createAuth(schemaOnlySql, {
  BETTER_AUTH_SECRET: 'schema-generation-only-without-production-secrets',
  BETTER_AUTH_URL: 'http://localhost:8787',
  DASHBOARD_URL: 'http://localhost:5173',
  PASSKEY_RP_ID: 'localhost',
  PASSKEY_RP_NAME: 'Burn Rate schema generation'
});
