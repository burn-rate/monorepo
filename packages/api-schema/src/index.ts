import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('burn-rate-api')
});

export const timeseriesHealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string()
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './metrics';
export * from './normalized-sample';
