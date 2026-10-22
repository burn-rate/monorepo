import { z } from '@hono/zod-openapi';

const ringSchema = z.object({
  actual: z.number().finite().nullable(),
  goal: z.number().finite().nullable(),
  unit: z.string().nullable()
}).strict();

/** Missing metadata stays explicit: incomplete corrections must survive ingestion. */
export const normalizedRingSummarySchema = z.object({
  sourceIdentity: z.string().nullable(),
  sourceRecordId: z.string().nullable(),
  localDate: z.string().nullable(),
  timeZone: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  revisionAt: z.string().nullable(),
  moveMode: z.enum(['energy', 'time']).nullable(),
  paused: z.boolean().nullable(),
  move: ringSchema,
  exercise: ringSchema,
  stand: ringSchema
}).strict();

export type NormalizedRingSummary = z.infer<typeof normalizedRingSummarySchema>;
export type RingSummaryEvidence = NormalizedRingSummary & { revisionDigest?: string };

export interface CreditEvidence {
  ringSummaries: RingSummaryEvidence[];
  /** Completion is authoritative metadata; progress or an elapsed deadline is insufficient. */
  loans: Array<{ principalKcal: string; fullyRepaid: boolean }>;
}
