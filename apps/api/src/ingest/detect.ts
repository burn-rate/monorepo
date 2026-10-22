import type { IngestStats } from '@burn-rate/api-schema';

export type PayloadFormat = IngestStats['format'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Detect the incoming payload format from its shape, before any strict
 * parsing. Corresponds to steps 1–2 of the ingest pipeline: detect, then
 * select the mapping function.
 */
export function detectFormat(body: unknown): PayloadFormat {
  if (!isRecord(body)) return 'unknown';

  // health-exporter.v1 batches: envelope with schemaVersion + samples array.
  if (body.schemaVersion === 'health-exporter.v1' && Array.isArray(body.samples)) {
    return 'health-exporter-v1';
  }

  // Alternative export shape: { data: { metrics: [{ name, units, data: [...] }] } }.
  if (isRecord(body.data) && Array.isArray(body.data.metrics)) {
    return 'metrics-v1';
  }

  return 'unknown';
}
