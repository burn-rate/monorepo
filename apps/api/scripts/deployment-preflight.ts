import type { Sql } from '../src/db';

export class DeploymentPreflightError extends Error {
  constructor(readonly code: 'PLAINTEXT_HEALTH_DATA' | 'PREFLIGHT_UNAVAILABLE') {
    super(code === 'PLAINTEXT_HEALTH_DATA'
      ? 'Existing plaintext health rows require reviewed cleanup or migration before deployment.'
      : 'Could not verify the absence of retained plaintext health data; deployment has stopped.');
  }
}

function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

/** CI fresh-deployment gate only. Never assigns, deletes, or migrates legacy data. */
export async function assertNoPlaintextHealthData(sql: Sql): Promise<void> {
  try {
    const { rows: schemas } = await sql.query<{ schema: string | null }>('SELECT current_schema() AS schema');
    const schema = schemas[0]?.schema;
    if (!schema) throw new DeploymentPreflightError('PREFLIGHT_UNAVAILABLE');
    // Resolve only the intended namespace, never search_path fallback to public.
    const { rows } = await sql.query<{ relation: string }>(`SELECT c.relname AS relation
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`, [schema, ['health_samples', 'health_daily']]);
    for (const { relation } of rows) {
      if (relation !== 'health_samples' && relation !== 'health_daily') throw new DeploymentPreflightError('PREFLIGHT_UNAVAILABLE');
      const result = await sql.query<{ retained: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${identifier(schema)}.${identifier(relation)} LIMIT 1) AS retained`);
      if (result.rows[0]?.retained === true) throw new DeploymentPreflightError('PLAINTEXT_HEALTH_DATA');
      if (result.rows[0]?.retained !== false) throw new DeploymentPreflightError('PREFLIGHT_UNAVAILABLE');
    }
  } catch (error) {
    if (error instanceof DeploymentPreflightError) throw error;
    // Do not retain driver errors/SQL parameters as a cause or public message.
    throw new DeploymentPreflightError('PREFLIGHT_UNAVAILABLE');
  }
}
