import { readFile } from 'node:fs/promises';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSql } from '../src/db';
import { loadOperatorEnvironment, operatorConnectionString } from './environment';
import { retainedKeyInventory, rewrapUserKeys, rotateDataKey, type CryptoConfig } from '../src/crypto';
import { backfillLegacyDumps, backfillLegacySamples, inspectLegacyCoverage, retainedDumpKeyInventory, verifyLegacyCutover, type BackfillBucket, type LegacyOwnerMappings } from '../src/legacy-backfill';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Required operator configuration missing');
  return value;
}
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function run(): Promise<void> {
  loadOperatorEnvironment();
  const action = process.argv[2];
  if (!['inventory', 'backfill', 'verify-cutover', 'rotate-dek', 'rewrap-kek', 'key-inventory'].includes(action ?? '')) {
    console.info('Usage: legacy-data.ts inventory|backfill|verify-cutover --mappings <file> [--verified-by <operator> --backup-inventory <reference>]');
    console.info('       legacy-data.ts rotate-dek|rewrap-kek --owner <account-id>');
    console.info('       legacy-data.ts key-inventory');
    process.exitCode = 1;
    return;
  }
  const config: CryptoConfig = { ENCRYPTION_ENVIRONMENT: required('ENCRYPTION_ENVIRONMENT'), HEALTH_KEK_ID: required('HEALTH_KEK_ID'), HEALTH_KEKS: required('HEALTH_KEKS') };
  const sql = await getSql({ TIMESERIES_DB: { connectionString: operatorConnectionString() } });
  let s3: S3Client | undefined;
  try {
    await sql.query('SET statement_timeout = 0');
    // Serialize operator jobs and migration execution on the same database.
    await sql.query("SELECT pg_advisory_lock(hashtextextended('burn-rate-migrations', 0))");
    if (action === 'rotate-dek' || action === 'rewrap-kek') {
      const ownerId = option('--owner');
      if (!ownerId || ownerId === 'default') throw new Error('Explicit account required');
      const account = await sql.query('SELECT id FROM "user" WHERE id = $1', [ownerId]);
      if (!account.rows.length) throw new Error('Account not found');
      if (action === 'rotate-dek') {
        await rotateDataKey(sql, config, ownerId);
        console.info(JSON.stringify({ status: 'data-key-rotated', retainedPriorVersions: true }));
      } else {
        const count = await rewrapUserKeys(sql, config, ownerId);
        console.info(JSON.stringify({ status: 'keys-rewrapped', count }));
      }
      return;
    }
    const path = option('--mappings');
    const owners: LegacyOwnerMappings = path ? JSON.parse(await readFile(path, 'utf8')) : { sampleOwners: {}, dumps: {} };
    if (!owners || typeof owners.sampleOwners !== 'object' || typeof owners.dumps !== 'object') throw new Error('Invalid owner mapping');
    const configuredOwners = [...Object.values(owners.sampleOwners), ...Object.values(owners.dumps)];
    for (const owner of configuredOwners) {
      const { rows } = await sql.query('SELECT id FROM "user" WHERE id = $1', [owner.ownerId]);
      if (!rows.length) throw new Error('Mapped owner account not found');
    }
    const bucketName = required('R2_BUCKET');
    s3 = new S3Client({ region: 'auto', endpoint: required('R2_ENDPOINT'),
      credentials: { accessKeyId: required('R2_ACCESS_KEY_ID'), secretAccessKey: required('R2_SECRET_ACCESS_KEY') } });
    const client = s3;
    const bucket: BackfillBucket = {
      list: async options => {
        const result = await client.send(new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: options?.cursor, MaxKeys: 100 }));
        return { objects: (result.Contents ?? []).map(object => { if (!object.Key) throw new Error('Invalid object listing'); return { key: object.Key }; }), truncated: result.IsTruncated ?? false, cursor: result.NextContinuationToken };
      },
      get: async key => {
        try {
          const object = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
          if (!object.Body || object.ContentLength === undefined) throw new Error('Invalid object response');
          return { size: object.ContentLength, text: () => object.Body!.transformToString(),
            customMetadata: { ...object.Metadata, ...(object.Metadata?.ownerid ? { ownerId: object.Metadata.ownerid } : {}) } };
        } catch (error) {
          if (error instanceof Error && error.name === 'NoSuchKey') return null;
          throw error;
        }
      },
      put: async (key, body, options) => client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body,
        ContentType: options?.httpMetadata?.contentType, Metadata: options?.customMetadata }))
    };
    if (action === 'key-inventory') {
      console.info(JSON.stringify({ keys: await retainedKeyInventory(sql), dumps: await retainedDumpKeyInventory(sql, config, bucket), backupDependencies: 'consult retained backup inventory' }));
      return;
    }
    if (action === 'backfill') {
      if (!path) throw new Error('Backfill requires an explicit verified owner mapping');
      const samples = await backfillLegacySamples(sql, config, owners);
      const dumps = await backfillLegacyDumps(sql, config, bucket, owners);
      console.info(JSON.stringify({ migratedSamples: samples, migratedDumps: dumps }));
    }
    if (action === 'verify-cutover') {
      const verifiedBy = option('--verified-by'), backupInventoryReference = option('--backup-inventory');
      if (!path || !verifiedBy || !backupInventoryReference) throw new Error('Verified mapping/operator/backup inventory required');
      const coverage = await verifyLegacyCutover(sql, config, bucket, owners, { verifiedBy, backupInventoryReference });
      console.info(JSON.stringify({ status: 'live-data-coverage-verified', coverage }));
    } else {
      console.info(JSON.stringify(await inspectLegacyCoverage(sql, config, bucket, owners)));
    }
  } finally {
    s3?.destroy();
    await sql.end().catch(() => {});
  }
}

// Never serialize a driver/SDK/crypto error, which may include health values,
// SQL parameters, request credentials, bucket keys, or hostnames.
await run().catch(() => {
  console.error('Operator job failed. Coverage is incomplete; inspect the environment privately.');
  process.exitCode = 1;
});
