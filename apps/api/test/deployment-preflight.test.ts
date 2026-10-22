import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Sql } from '../src/db';
import { assertNoPlaintextHealthData, DeploymentPreflightError } from '../scripts/deployment-preflight';

let database: PGlite;
let sql: Sql;
beforeAll(async () => { database = new PGlite(); }, 30_000);
beforeEach(async () => {
  await database.exec(`SET search_path TO public;
    DROP MATERIALIZED VIEW IF EXISTS public.health_daily;
    DROP TABLE IF EXISTS public.health_samples, public.rollup_source;
    DROP SCHEMA IF EXISTS deployment_target CASCADE;
    DROP SCHEMA IF EXISTS "deployment_""target" CASCADE`);
  sql = { query: async (text: string, values?: unknown[]) => database.query(text, values) } as unknown as Sql;
});
afterAll(async () => { await database?.close(); });

it('accepts an absent or empty legacy representation without creating tables', async () => {
  await expect(assertNoPlaintextHealthData(sql)).resolves.toBeUndefined();
  expect((await database.query("SELECT to_regclass('public.health_samples') AS samples")).rows[0]).toEqual({ samples: null });
  await database.exec(`CREATE TABLE public.health_samples (value DOUBLE PRECISION);
    CREATE MATERIALIZED VIEW public.health_daily AS SELECT value FROM public.health_samples`);
  await expect(assertNoPlaintextHealthData(sql)).resolves.toBeUndefined();
});

it('rejects retained plaintext samples safely without changing them', async () => {
  await database.exec("CREATE TABLE public.health_samples (value DOUBLE PRECISION, source TEXT); INSERT INTO public.health_samples VALUES (72, 'private source identity')");
  const failure = await assertNoPlaintextHealthData(sql).catch(error => error);
  expect(failure).toBeInstanceOf(DeploymentPreflightError);
  expect(failure).toMatchObject({ code: 'PLAINTEXT_HEALTH_DATA' });
  expect(String(failure)).toContain('reviewed cleanup or migration before deployment');
  expect(String(failure)).not.toContain('private source');
  expect((await database.query('SELECT value,source FROM public.health_samples')).rows).toEqual([{ value: 72, source: 'private source identity' }]);
  expect((await database.query("SELECT to_regclass('public.api_migrations') AS ledger")).rows[0]).toEqual({ ledger: null });
});

it('rejects retained materialized health data even when source samples are empty', async () => {
  await database.exec(`CREATE TABLE public.rollup_source (value DOUBLE PRECISION);
    INSERT INTO public.rollup_source VALUES (88);
    CREATE MATERIALIZED VIEW public.health_daily AS SELECT value FROM public.rollup_source;
    CREATE TABLE public.health_samples (value DOUBLE PRECISION)`);
  await expect(assertNoPlaintextHealthData(sql)).rejects.toMatchObject({ code: 'PLAINTEXT_HEALTH_DATA' });
  expect((await database.query('SELECT count(*)::text AS count FROM public.health_daily')).rows[0]).toEqual({ count: '1' });
});

it('does not fall through to another schema or alter its legacy data', async () => {
  await database.exec(`CREATE TABLE public.health_samples (value DOUBLE PRECISION);
    INSERT INTO public.health_samples VALUES (127);
    CREATE SCHEMA deployment_target;
    SET search_path TO deployment_target, public`);
  await expect(assertNoPlaintextHealthData(sql)).resolves.toBeUndefined();
  await database.exec('CREATE TABLE deployment_target.health_samples (value DOUBLE PRECISION)');
  await expect(assertNoPlaintextHealthData(sql)).resolves.toBeUndefined();
  await database.exec('INSERT INTO deployment_target.health_samples VALUES (1)');
  await expect(assertNoPlaintextHealthData(sql)).rejects.toMatchObject({ code: 'PLAINTEXT_HEALTH_DATA' });
  expect((await database.query('SELECT value FROM public.health_samples')).rows).toEqual([{ value: 127 }]);
  expect((await database.query('SELECT value FROM deployment_target.health_samples')).rows).toEqual([{ value: 1 }]);
});

it('quotes an unusual target schema identifier safely', async () => {
  await database.exec(`CREATE SCHEMA "deployment_""target";
    SET search_path TO "deployment_""target", public;
    CREATE TABLE "deployment_""target".health_samples (value DOUBLE PRECISION)`);
  await expect(assertNoPlaintextHealthData(sql)).resolves.toBeUndefined();
});

it('fails closed without exposing driver errors or private parameters', async () => {
  const unavailable = { query: async () => { throw new Error('private connection credentials and health parameters'); } } as unknown as Sql;
  const failure = await assertNoPlaintextHealthData(unavailable).catch(error => error);
  expect(failure).toMatchObject({ code: 'PREFLIGHT_UNAVAILABLE' });
  expect(String(failure)).not.toContain('private connection');
  expect(failure).not.toHaveProperty('cause');
});
