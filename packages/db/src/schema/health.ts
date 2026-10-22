// Query metadata only. Deployment DDL belongs to the checked raw SQL runner in
// apps/api/timescale/000_metrics.sql and 002_encrypted.sql. drizzle.config.ts
// intentionally scopes generation to auth.ts; Timescale policies stay in SQL.
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';

interface HealthEnvelope { version: 1; keyId: string; iv: string; ciphertext: string }

/** Public registry; observation values and source identities are encrypted. */
export const metrics = pgTable('metrics', {
  metric: text('metric').primaryKey(),
  displayName: text('display_name').notNull(),
  category: text('category', { enum: ['activity', 'vitals'] }).notNull(),
  unit: text('unit').notNull()
});

export const encryptedHealthSamples = pgTable('encrypted_health_samples', {
  id: text('id').notNull(),
  ownerId: text('owner_id').notNull(),
  metric: text('metric').notNull().references(() => metrics.metric),
  time: timestamp('time', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  sourceDigest: text('source_digest').notNull(),
  envelope: jsonb('envelope').$type<HealthEnvelope>().notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  primaryKey({ columns: [table.time, table.id] }),
  unique().on(table.ownerId, table.metric, table.time, table.endedAt, table.sourceDigest),
  index('encrypted_health_samples_owner_page').on(table.ownerId, table.metric, table.time, table.id),
  check('encrypted_health_samples_owner_id_check', sql`${table.ownerId} <> 'default'`),
  check('encrypted_health_samples_envelope_check', sql`${table.envelope}->>'version' = '1'`),
  check('encrypted_samples_time_precision', sql`${table.time} = date_trunc('milliseconds', ${table.time})`),
  check('encrypted_samples_end_precision', sql`${table.endedAt} = date_trunc('milliseconds', ${table.endedAt})`)
]);

export const healthUserKeys = pgTable('health_user_keys', {
  ownerId: text('owner_id').notNull(),
  keyId: text('key_id').notNull(),
  purpose: text('purpose', { enum: ['data', 'index'] }).notNull(),
  state: text('state', { enum: ['active', 'retired'] }).notNull(),
  wrappedKey: jsonb('wrapped_key').$type<HealthEnvelope>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true })
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.keyId] }),
  uniqueIndex('health_user_keys_one_active').on(table.ownerId, table.purpose).where(sql`${table.state} = 'active'`),
  check('health_user_keys_owner_id_check', sql`${table.ownerId} <> 'default'`),
  check('health_user_keys_purpose_check', sql`${table.purpose} IN ('data', 'index')`),
  check('health_user_keys_state_check', sql`${table.state} IN ('active', 'retired')`),
  check('health_user_keys_wrapped_key_check', sql`${table.wrappedKey}->>'version' = '1'`),
  check('health_user_keys_check', sql`${table.purpose} <> 'index' OR ${table.state} = 'active'`)
]);
