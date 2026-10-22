// Note for future readers: this file intentionally has no DDL authority for the
// health tables. They live in TimescaleDB as a hypertable with columnstore and
// continuous-aggregate policies (see apps/api/timescale/001_init.sql), which
// plain drizzle-kit migrations cannot express. These definitions are for
// type-safe queries only; drizzle-kit migration scope is limited to auth.ts.
import { doublePrecision, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/** Canonical metric registry (seeded by 001_init.sql, kept in sync with @burn-rate/api-schema KNOWN_METRICS). */
export const metrics = pgTable('metrics', {
  metric: text('metric').primaryKey(),
  displayName: text('display_name').notNull(),
  category: text('category', { enum: ['activity', 'vitals'] }).notNull(),
  unit: text('unit').notNull()
});

/** Sample hypertable — read/write via drizzle, DDL owned by Timescale migration SQL. */
export const healthSamples = pgTable(
  'health_samples',
  {
    time: timestamp('time', { withTimezone: true }).notNull(), // sample start (partition column)
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(), // = time for instantaneous samples
    userId: text('user_id').notNull().default('default'),
    metric: text('metric')
      .notNull()
      .references(() => metrics.metric),
    value: doublePrecision('value').notNull(),
    valueMin: doublePrecision('value_min'),
    valueMax: doublePrecision('value_max'),
    unit: text('unit').notNull(),
    sourceName: text('source_name').notNull(),
    device: text('device'),
    extId: text('ext_id'),
    dumpKey: text('dump_key'),
    attrs: jsonb('attrs'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [unique().on(t.userId, t.metric, t.time, t.endedAt, t.sourceName)]
);

// health_daily (continuous aggregate) is queried with raw sql via db.execute —
// drizzle-orm materialized-view defs can't express Timescale continuous aggs.
