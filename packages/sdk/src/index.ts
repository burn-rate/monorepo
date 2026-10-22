// Generated transport functions and DTOs are the only contract authority here.
// Exporter upload deliberately remains outside the dashboard package surface.
export {
  getHealth, getTimeseriesHealth, getCurrentUser, listMetrics, listHealthSamples, getScore, createLoan, listLoans,
  createIngestionToken, listIngestionTokens, revokeIngestionToken
} from './generated/sdk.gen';
export type * from './generated/types.gen';
export { createClient, createConfig } from './generated/client';
export type { Client, Config } from './generated/client';
